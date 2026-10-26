/**
 * Embeddings — semantic search через MiniLM (384-dim) с TF-IDF fallback.
 *
 * @huggingface/transformers загружается лениво. Модель all-MiniLM-L6-v2 (~22MB)
 * скачивается при первом использовании и кэшируется в HuggingFace cache.
 * Если загрузка не удалась — fallback на TF-IDF (чистый JS, без ML).
 *
 * Работает в main process и worker_threads (onnxruntime-node).
 *
 * Дополнительно: отдельный lazy E5-embedder (getE5Embedder) — multilingual
 * модель для фоновой semantic-индексации recall_memory (см. memory/semanticIndex.ts).
 * Полностью изолирован от getEmbedder/fast-context: свой pipeline, свои флаги,
 * свой dispose. Недоступность E5 НЕ влияет на TF-IDF/MiniLM поиск.
 */

// Embedding helpers are platform-independent; paths are normalized as strings below.
// ─── Типы ────────────────────────────────────────────────────────────────────

export type Embedding = Float32Array

export interface Embedder {
  embed(text: string): Promise<Embedding>
  stableEmbed?: (text: string) => Promise<Embedding>
  stableDim?: number
  dim: number
  mode: 'neural' | 'tfidf'
}

// ─── Neural embeddings (MiniLM) ──────────────────────────────────────────────
// ОТКЛЮЧЕНО по умолчанию: onnxruntime-node грузит native threads которые
// не убиваются полностью через dispose() — жрут CPU в простое.
// Для desktop app TF-IDF достаточно (мгновенно, 0 CPU overhead).
// Включить: setUseNeuralEmbeddings(true) из настроек.

let _pipeline: any = null
let _neuralInitAttempted = false
let _neuralInitFailed = false
let _useNeural = false

/**
 * Общие опции загрузки ONNX-моделей (MiniLM и E5).
 *
 * ⚠️ dtype: 'q8' — квантованные веса (model_quantized.onnx, ~113 МБ вместо
 * 448 МБ fp32). В @huggingface/transformers v4 опция `quantized` УДАЛЕНА и
 * молча игнорируется: код качал fp32-модель и держал ~845 МБ private RAM в
 * main-процессе против ~508 МБ на q8 (замер 26.10.2026). Размерность вектора
 * не меняется (384), поэтому контракт E5Embedder.dim стабилен.
 *
 * ⚠️ session_options.intraOpNumThreads — у onnxruntime-node по умолчанию
 * потоков столько же, сколько ядер. Фоновая индексация выжирала до ~5 ядер
 * (cpuUserMs 489% в 10-секундном сэмпле performance-main.jsonl). Ограничение
 * только на wasm-бэкенд (env.backends.onnx.wasm.numThreads) не влияло на
 * нативный CPU-провайдер. Двух потоков фоновой задаче достаточно.
 */
const ONNX_SESSION_OPTIONS = {
  intraOpNumThreads: 2,
  interOpNumThreads: 1,
  executionMode: 'sequential' as const,
  graphOptimizationLevel: 'all' as const,
}

/** Опции pipeline для neural/E5 — единая точка, чтобы dtype не разъезжался. */
function modelLoadOptions(dtype: 'q8' | 'fp32') {
  return {
    dtype,
    cache_dir: process.env.TRANSFORMERS_CACHE || undefined,
    session_options: ONNX_SESSION_OPTIONS,
  }
}

/** Включить/выключить neural embeddings (ONNX). По умолчанию выключено. */
export function setUseNeuralEmbeddings(enabled: boolean): void {
  _useNeural = enabled
  if (!enabled) disposeEmbedder()
}

async function initNeural(): Promise<void> {
  if (_neuralInitAttempted || !_useNeural) return
  _neuralInitAttempted = true

  try {
    // require вместо await import: нативный import() не работает в V8-байткоде
    // (пакет имеет CJS-сборку dist/transformers.node.cjs для require-экспорта)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { pipeline, env } = require('@huggingface/transformers')
    // ⚠️ @huggingface/transformers v4 НЕ читает TRANSFORMERS_CACHE из process.env.
    // Явно перенаправляем в userData/transformers-cache (writable в production).
    if (process.env.TRANSFORMERS_CACHE) {
      env.cacheDir = process.env.TRANSFORMERS_CACHE
    }
    try {
      env.backends.onnx.wasm.numThreads = 1
    } catch { /* onnx may not be configured */ }
    _pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2',
      modelLoadOptions('q8'))
  } catch (e) {
    _neuralInitFailed = true
    console.warn('[embeddings] neural init failed, using TF-IDF fallback:', e instanceof Error ? e.message : e)
  }
}

/** Освобождает ONNX pipeline. */
export function disposeEmbedder(): void {
  if (_pipeline) {
    try {
      const p = _pipeline as any
      if (typeof p.dispose === 'function') p.dispose()
      else if (p.model?.dispose) p.model.dispose()
    } catch { /* ignore */ }
    _pipeline = null
    _neuralInitAttempted = false
  }
}

const NEURAL_DIM = 384
// Memory TF-IDF layout stays stable. Fast-context uses a separate dimension so
// old vectors are invalidated without changing persisted memory embeddings.
const TFIDF_DIM = 1024
const FAST_TFIDF_DIM = 2048

// ─── E5 multilingual embeddings — ПЕРЕНЕСЕНО В RUST SIDECAR ──────────────────
// Модель Xenova/multilingual-e5-small (q8), токенизация и ONNX-инференс теперь
// живут в Sidecar/src/semantic/embed.rs, индексация и cosine-поиск — в
// semantic/{index,search}.rs. Причина: нативная ONNX-сессия в main-процессе
// блокировала event loop кусками по ~400 мс (замер 26.10.2026: 1.6–1.9 ядра за
// 10 с, eventLoopP95 390–450 мс) — «фризил весь UI».
//
// Здесь остаются только MiniLM (getEmbedder, по умолчанию выключен) и TF-IDF
// fallback: fast-context и memory TF-IDF работают как раньше.

async function embedNeural(text: string): Promise<Embedding> {
  if (!_pipeline) await initNeural()
  if (!_pipeline) throw new Error('neural pipeline not available')

  const output = await _pipeline([text], { pooling: 'mean', normalize: true })
  return output.data as Float32Array
}

// ─── TF-IDF fallback ─────────────────────────────────────────────────────────
// Простой но эффективный: веса термам по IDF (редкие термины важнее).
// Не знает синонимы, но лучше чистого lexical — учитывает важность слов.

// Per-project IDF cache — avoids cross-project contamination
interface ProjectIdf {
  idf: Map<string, number>
  docCount: number
}
const IDF_BY_PROJECT = new Map<string, ProjectIdf>()
let _activeProjectId: string | null = null

export function setActiveProjectId(projectId: string): void {
  _activeProjectId = projectId
}

export function updateTfidfIdf(projectId: string, documents: string[]): void {
  const df = new Map<string, number>() // document frequency
  for (const doc of documents) {
    const tokens = new Set(tokenize(doc))
    for (const t of tokens) {
      df.set(t, (df.get(t) ?? 0) + 1)
    }
  }
  // IDF = ln(N / df)
  const idf = new Map<string, number>()
  for (const [term, freq] of df) {
    idf.set(term, Math.log(documents.length / freq))
  }
  IDF_BY_PROJECT.set(projectId, { idf, docCount: documents.length })
}

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .split(/[^a-zа-я0-9_]+/i)
    .filter(t => t.length >= 2)
}

function embedHashed(text: string, dim: number, idf?: Map<string, number>, docCount = 1): Embedding {
  const tf = new Map<string, number>()
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + 1)
  const vec = new Float32Array(dim)
  for (const [term, freq] of tf) {
    const weight = idf
      ? freq * (idf.get(term) ?? Math.log(docCount || 1))
      : 1 + Math.log(freq)
    let hash = 0
    for (let i = 0; i < term.length; i++) hash = ((hash << 5) - hash + term.charCodeAt(i)) | 0
    vec[Math.abs(hash) % dim] += weight
  }
  let norm = 0
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < dim; i++) vec[i] /= norm
  return vec
}

function embedTfidf(text: string): Embedding {
  const project = _activeProjectId ? IDF_BY_PROJECT.get(_activeProjectId) : null
  return embedHashed(text, TFIDF_DIM, project?.idf, project?.docCount)
}

function embedFastContextTfidf(text: string): Embedding {
  return embedHashed(text, FAST_TFIDF_DIM)
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function getEmbedder(): Promise<Embedder> {
  // Neural embeddings по умолчанию выключены (ONNX runtime жрёт CPU в простое).
  // TF-IDF — мгновенно, без native threads, достаточно для semantic search.
  if (_useNeural && !_neuralInitFailed) {
    await initNeural()
    if (_pipeline) {
      return { embed: embedNeural, stableEmbed: embedNeural, dim: NEURAL_DIM, stableDim: NEURAL_DIM, mode: 'neural' }
    }
  }
  return {
    embed: async (text: string) => embedTfidf(text),
    stableEmbed: async (text: string) => embedFastContextTfidf(text),
    stableDim: FAST_TFIDF_DIM,
    dim: TFIDF_DIM,
    mode: 'tfidf',
  }
}

/** Косинусное сходство двух векторов (оба L2-normalized → dot product). */
export function cosineSimilarity(a: Embedding, b: Embedding): number {
  let dot = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
  }
  return dot
}

/** Сериализация embedding в Buffer для хранения в SQLite BLOB. */
export function embeddingToBuffer(emb: Embedding): Buffer {
  return Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength)
}

/** Десериализация embedding из Buffer. */
export function bufferToEmbedding(buf: Buffer): Embedding {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

/**
 * Текст для embedding файла: путь + имена символов + kinds + сигнатуры + imports.
 * Компактное представление содержимого файла для semantic поиска.
 * ВАЖНО: путь файла включён — иначе auth.ts без символа "auth" не матчится.
 */
export function fileToEmbeddingText(
  defs: Array<{ name: string; kind: string; signature: string; parentName?: string }>,
  imports: string[],
  filePath?: string,
): string {
  const parts: string[] = []
  // Путь файла — basename + директория (даёт сигнал для semantic match)
  if (filePath) {
    const normalized = filePath.replace(/\\/g, '/')
    const segments = normalized.split('/')
    const baseName = segments[segments.length - 1].replace(/\.[^.]+$/, '')
    parts.push(baseName)
    // Последние 2 директории — контекст (e.g. "auth/login" для src/auth/login.ts)
    if (segments.length >= 3) {
      parts.push(segments[segments.length - 2])
    }
  }
  for (const d of defs.slice(0, 50)) {
    if (d.parentName) parts.push(`${d.parentName}.${d.name} ${d.kind}`)
    else parts.push(`${d.name} ${d.kind}`)
    if (d.signature) parts.push(d.signature.slice(0, 80))
  }
  for (const imp of imports.slice(0, 20)) {
    parts.push(imp)
  }
  return parts.join(' ')
}
