/**
 * semanticIndex — фоновая E5-индексация памяти и semantic-поиск.
 *
 * Вся тяжёлая работа (ONNX-инференс, cosine по BLOB-векторам, обход источников)
 * теперь в Rust sidecar (`Sidecar/src/semantic/`). Здесь остался только
 * планировщик и адаптер форматов.
 *
 * Почему переехало: E5-инференс в main-процессе блокировал event loop кусками
 * по ~400 мс (замер 26.10.2026: cpuUser 1.6–1.9 ядра за 10 с, eventLoopP95
 * 390–450 мс). Любой IPC в этот момент вставал в очередь — «фризил весь UI».
 * Отдельный процесс эту возможность убирает физически.
 *
 * Индексируется 5 источников в таблицу `semantic_embeddings` (384-dim E5):
 *   1. memory_items      → text = "title. content"
 *   2. messages          → text = content (user/assistant)
 *   3. chat_summaries    → text = content
 *   4. agent_logs        → text = "[tool] ERROR: … | result"
 *   5. pinned_messages   → text = content сообщения
 *
 * Деградация: если sidecar недоступен или модель не скачана — цикл
 * пропускается, lexical/TF-IDF поиск работает как раньше.
 */

import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { getMemorySettings } from './globalMemorySettings'
import { rowToItem, type MemoryKind, type MultiSourceResult } from './store/_shared'
import {
  resolveSemanticModelPaths,
  sidecarSemanticIndex,
  sidecarSemanticSearch,
  type SidecarSemanticHit,
} from '../sidecar/sidecarClient'
import { perfMark, perfEvent } from '../performanceDiagnostics'
import { getDB } from '../db/handle'

// ─── Типы ────────────────────────────────────────────────────────────────────

/** Источники semantic-индексации — зеркалят SearchSourceName из chatSearch.ts. */
export type SemanticSourceName = 'memory' | 'messages' | 'summaries' | 'agent_logs' | 'pinned'

const SEMANTIC_SOURCES: SemanticSourceName[] = ['memory', 'messages', 'summaries', 'agent_logs', 'pinned']

// ─── Конфиг ──────────────────────────────────────────────────────────────────

/** Задержка первого запуска после start — не блокировать startup. */
const START_DELAY_MS = 30_000
/** Периодический реиндекс (ловит новые сообщения/логи). */
const REINDEX_INTERVAL_MS = 15 * 60 * 1000
/**
 * Бюджет CPU на один вызов sidecar. Недоделанное продолжается следующим
 * вызовом — так один цикл не растягивается на 16 минут, как было в TS.
 */
const CYCLE_BUDGET_MS = 60_000
/** Сколько подряд «продолжений» делаем внутри одного запуска (страховка). */
const MAX_CONSECUTIVE_CYCLES = 5

// ─── Состояние ───────────────────────────────────────────────────────────────

let _startTimer: NodeJS.Timeout | null = null
let _interval: NodeJS.Timeout | null = null
let _running = false
let _stopRequested = false
let _started = false
let _isForegroundBusy: () => boolean = () => false

/** Connect foreground activity without coupling core memory code to Electron/main. */
export function setSemanticIndexerForegroundPredicate(predicate: () => boolean): void {
  _isForegroundBusy = predicate
}

// ─── Модель ──────────────────────────────────────────────────────────────────

const HF_BASE = 'https://huggingface.co'
const MODEL_ID = 'Xenova/multilingual-e5-small'

/** Файлы модели, которые нужны Rust-эмбеддеру. */
const MODEL_FILES: Array<{ relative: string; minBytes: number }> = [
  { relative: join('onnx', 'model_quantized.onnx'), minBytes: 100 * 1024 * 1024 },
  { relative: 'tokenizer.json', minBytes: 1024 * 1024 },
]

let _downloadAttempted = false
let _downloadFailedAt = 0
/** Прежняя политика E5: неудачу не ретраим чаще, чем раз в 5 минут. */
const DOWNLOAD_RETRY_MS = 5 * 60 * 1000

/**
 * Скачивает файлы модели в HF-кэш приложения, если их нет.
 *
 * Раньше загрузку делал transformers.js при первом `getE5Embedder()`. Теперь
 * инференс в Rust, поэтому и качать должен кто-то без ONNX в main — иначе
 * вернули бы 500 МБ и блокировки, от которых уходили. Это два HTTP-запроса.
 *
 * Возвращает true, если модель на месте. Экспортируется и для семантического
 * слоя карты (mapSemantic) — скачивание общее, состояние ретраев общее.
 */
export async function ensureModelFiles(): Promise<boolean> {
  if (resolveSemanticModelPaths()) return true
  const cacheDir = process.env.TRANSFORMERS_CACHE
  if (!cacheDir) return false
  if (_downloadAttempted) {
    // Уже пытались: повторяем только после окна ожидания (офлайн-режим не
    // должен крутить загрузчик на каждом цикле).
    if (_downloadFailedAt === 0) return false
    if (Date.now() - _downloadFailedAt < DOWNLOAD_RETRY_MS) return false
  }

  _downloadAttempted = true
  const modelDir = join(cacheDir, MODEL_ID)
  try {
    for (const file of MODEL_FILES) {
      const target = join(modelDir, file.relative)
      if (existsSync(target) && statSync(target).size >= file.minBytes) continue
      mkdirSync(dirname(target), { recursive: true })
      const url = `${HF_BASE}/${MODEL_ID}/resolve/main/${file.relative.split('\\').join('/')}`
      console.log(`[semanticIndex] downloading ${file.relative}…`)
      const response = await fetch(url, { redirect: 'follow' })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.byteLength < file.minBytes) {
        throw new Error(`truncated download: ${buffer.byteLength} bytes`)
      }
      // Атомарная подмена: недокачанный файл не должен выглядеть готовым.
      const temp = `${target}.part`
      writeFileSync(temp, buffer)
      renameSync(temp, target)
      console.log(`[semanticIndex] saved ${file.relative} (${Math.round(buffer.byteLength / 1024 / 1024)} MB)`)
    }
    return resolveSemanticModelPaths() !== null
  } catch (e) {
    _downloadFailedAt = Date.now()
    console.warn('[semanticIndex] model download failed:', e instanceof Error ? e.message : e)
    return false
  }
}

// ─── Индексация ──────────────────────────────────────────────────────────────

/**
 * Один цикл индексации всех 5 источников. Идемпотентен, защищён от
 * параллельных запусков (_running). Ошибки глотаются с warn — фоновый процесс
 * не должен падать и не должен ломать основной поиск.
 */
export async function runSemanticIndexingOnce(): Promise<void> {
  if (_running) {
    console.log('[semanticIndex] cycle already running — skip')
    return
  }
  if (_stopRequested) return
  // Пользователь активно работает (идёт ран/компакция) — не начинаем цикл.
  if (_isForegroundBusy()) return

  _running = true
  const cycleStarted = perfMark()
  try {
    // An empty profile needs neither the model download nor an ONNX session.
    // Existing vectors still require a cycle so deleted source rows get pruned.
    const work = getDB().prepare(`
      SELECT EXISTS(SELECT 1 FROM memory_items)
        OR EXISTS(SELECT 1 FROM messages WHERE role IN ('user', 'assistant'))
        OR EXISTS(SELECT 1 FROM chat_summaries)
        OR EXISTS(SELECT 1 FROM agent_logs)
        OR EXISTS(SELECT 1 FROM pinned_messages pm JOIN messages m ON m.id = pm.message_id)
        OR EXISTS(SELECT 1 FROM semantic_embeddings) AS hasWork
    `).get() as { hasWork: number }
    if (!work.hasWork) return

    if (!await ensureModelFiles()) {
      console.log('[semanticIndex] E5 model unavailable — skipping cycle (lexical search unaffected)')
      return
    }
    const paths = resolveSemanticModelPaths()
    if (!paths) return

    let totalIndexed = 0
    let totalFailed = 0
    for (let attempt = 0; attempt < MAX_CONSECUTIVE_CYCLES; attempt++) {
      if (_stopRequested || _isForegroundBusy()) break
      const report = await sidecarSemanticIndex({ budgetMs: CYCLE_BUDGET_MS }, paths)
      totalIndexed += report.totalIndexed
      totalFailed += report.totalFailed
      if (!report.budgetExhausted) break
      // Бюджет кончился — сразу продолжаем, пока не доедем до конца.
    }
    if (totalIndexed > 0 || totalFailed > 0) {
      console.log(
        `[semanticIndex] +${totalIndexed} indexed, ${totalFailed} failed (${Math.round(perfMark() - cycleStarted)}ms)`,
      )
    }
  } catch (e) {
    console.warn('[semanticIndex] cycle failed:', e instanceof Error ? e.message : e)
  } finally {
    perfEvent('semantic_index.cycle', perfMark() - cycleStarted)
    _running = false
  }
}

/**
 * Запускает фоновую индексацию: первый цикл через START_DELAY_MS (не блокирует
 * startup), далее каждые REINDEX_INTERVAL_MS. Повторный вызов — no-op.
 */
export function startSemanticIndexer(): void {
  if (_started) return
  _started = true
  _stopRequested = false

  _startTimer = setTimeout(() => {
    _startTimer = null
    void runSemanticIndexingOnce()
    _interval = setInterval(() => {
      void runSemanticIndexingOnce()
    }, REINDEX_INTERVAL_MS)
    _interval.unref?.()
  }, START_DELAY_MS)
  _startTimer.unref?.()
}

/**
 * Останавливает индексатор: снимает таймеры и выставляет _stopRequested
 * (текущий цикл доедет до ближайшей проверки и выйдет). Модель в sidecar
 * освобождается командой `semanticUnload` при shutdown sidecar.
 */
export function stopSemanticIndexer(): void {
  _stopRequested = true
  _started = false
  if (_startTimer) {
    clearTimeout(_startTimer)
    _startTimer = null
  }
  if (_interval) {
    clearInterval(_interval)
    _interval = null
  }
}

/** Текущее состояние (для диагностики/UI-статуса). */
export function getSemanticIndexerStatus(): {
  started: boolean
  running: boolean
  stopRequested: boolean
} {
  return { started: _started, running: _running, stopRequested: _stopRequested }
}

// ─── SEMANTIC SEARCH (E5 query → cosine ranking в Rust) ──────────────────────

export interface SemanticSearchOptions {
  /** Какие источники искать. Default: все 5. */
  sources?: SemanticSourceName[]
  /**
   * Scope-фильтр memory_items — зеркалит SearchMemoryParams.scope
   * ('global' | 'project' | 'chat' | 'all'). Default: 'all'.
   */
  scope?: 'global' | 'project' | 'chat' | 'all'
  /** Проект для scope-фильтров (memory + chat-источники). */
  projectId?: string
  /** kind-фильтр memory_items (как SearchMemoryParams.kind). */
  kind?: MemoryKind
  /** Chat-источники: искать во всех проектах (как chatSearch crossProject). */
  crossProject?: boolean
  /** Top-K кандидатов на источник. Default: 5. */
  limit?: number
}

/** Строка-кандидат sidecar → MultiSourceResult (формат lexical-канала). */
function hitToResult(hit: SidecarSemanticHit): MultiSourceResult | null {
  const source = hit.source as SemanticSourceName
  if (!SEMANTIC_SOURCES.includes(source)) return null
  const semanticScore = Math.max(0, Math.min(1, hit.score))
  const result: MultiSourceResult = {
    source,
    sourceId: hit.sourceId,
    content: hit.content,
    score: semanticScore,
    semanticScore,
  }
  if (source === 'memory' && hit.memoryRow) result.item = rowToItem(hit.memoryRow)
  if (hit.chatId != null) result.chatId = hit.chatId
  if (hit.chatTitle != null) result.chatTitle = hit.chatTitle
  if (hit.role != null) result.role = hit.role
  if (hit.date != null) result.date = hit.date
  if (source === 'messages' || source === 'pinned') result.messageId = hit.sourceId
  return result
}

/**
 * Semantic-поиск по всем источникам recall_memory (E5, cosine).
 *
 * Возвращает top-K на источник в формате MultiSourceResult с sourceId и
 * semanticScore (cosine 0..1). Graph НЕ возвращается — граф-экспансия остаётся
 * в searchAllSources.
 *
 * Отказоустойчивость: sidecar недоступен / модели нет / ошибка SQL → [] —
 * lexical-канал работает как раньше.
 */
export async function searchSemanticSources(
  query: string,
  options: SemanticSearchOptions = {},
): Promise<MultiSourceResult[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  // Поиск никогда не запускает скачивание модели — только уже готовые файлы.
  const paths = resolveSemanticModelPaths()
  if (!paths) return []

  const settings = getMemorySettings()
  try {
    const hits = await sidecarSemanticSearch({
      query: trimmed,
      sources: options.sources ?? SEMANTIC_SOURCES,
      scope: options.scope,
      projectId: options.projectId,
      crossProject: options.crossProject === true,
      kind: options.kind,
      limit: Math.max(1, options.limit ?? 5),
      memoryEnabled: settings.enabled,
      memoryGlobal: settings.global,
      memoryProject: settings.project,
      memoryChat: settings.chat,
    }, paths)
    const results: MultiSourceResult[] = []
    for (const hit of hits) {
      const mapped = hitToResult(hit)
      if (mapped) results.push(mapped)
    }
    return results
  } catch (e) {
    console.warn('[semanticIndex] semantic search failed:', e instanceof Error ? e.message : e)
    return []
  }
}

/** Путь к модели — для диагностики/статуса в UI. */
export function getSemanticModelInfo(): { available: boolean; model: string } {
  const paths = resolveSemanticModelPaths()
  return { available: paths !== null, model: MODEL_ID }
}
