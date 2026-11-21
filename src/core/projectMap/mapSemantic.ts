/**
 * mapSemantic — семантический слой карты проекта.
 *
 * Документы символов/файлов выводятся из уже сохранённых узлов карты (имя +
 * сигнатура + путь, camelCase разбивается на слова) и эмбеддятся локальной
 * моделью E5 в Rust sidecar (sidecarSemanticEmbed: passage — при индексации,
 * query — при поиске). Векторы лежат в code_map_docs рядом с картой; hash-гейт
 * делает инкрементал почти бесплатным: текст не изменился — вектор не
 * пересчитывается.
 *
 * Интеграция с mapBuilder: syncFileDocs вызывается рядом с каждым
 * store.replaceFile / removeFile (полная сборка, инкрементал, удаление файлов),
 * worker просыпается по nudge() и по пачкам (64 при сборке карты / 128 в
 * простое) гоняет очередь через sidecar, уступая foreground-чату. Sidecar
 * serial — во время сборки карты embed-запросы встают за парсингом, поэтому
 * пачки при сборке меньше и с паузой.
 *
 * Ревизии раздельные: правка текстов документов инвалидирует lexical-индекс и
 * матрицу векторов, а запись векторов — только матрицу. Иначе каждая пачка
 * эмбеддингов пересобирала бы lexical-индекс по всем документам проекта.
 *
 * Поиск — гибрид трёх каналов: cosine по векторам (матрица проекта в памяти,
 * лениво, только для активного проекта), lexical по инвертированному индексу
 * слов документов, точное имя через findNodes. Слияние RRF. Лексические каналы
 * считаются первыми и никогда не ждут sidecar: точное имя отвечает сразу,
 * вектор — с коротким дедлайном. Без модели или до догрева векторов работает
 * lexical-канал — тул честно помечает режим.
 *
 * Прогрев E5 — только по явному запросу (semantic-поиск, открытая карта
 * активного проекта); глобального фонового прогрева нет, а не запрошенные
 * проекты в статусе честно помечены 'deferred'.
 */
import { createHash } from 'crypto'
import * as store from './mapStore'
import { EMBED_MODEL_TAG } from './mapStore'
import { sidecarSemanticEmbed, resolveSemanticModelPaths } from '../sidecar/sidecarClient'
import { ensureModelFiles } from '../memory/semanticIndex'
import { embeddingToBuffer } from '../context/embeddings'
import { log } from '../logger'
import type {
  CodeMapDocInfo, CodeMapNode, CodeMapProgress, CodeMapSemanticHit,
  CodeMapSemanticMode, CodeMapSemanticResult, CodeMapSemanticState, CodeMapSemanticStatus,
} from '../../shared/projectMap'

/**
 * Тег модели — версия вектора (колонка `model` в code_map_docs). Источник —
 * mapStore; fallback нужен только тестовым шимам, где store подменён пустышкой.
 */
const MODEL_TAG: string = (EMBED_MODEL_TAG as string | undefined) ?? 'e5'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

// ─── Документы ───────────────────────────────────────────────────────────────

/** E5-small режет вход на 512 токенов — документы короче по построению. */
const MAX_DOC_CHARS = 600

/** camelCase / snake_case / kebab-case → слова в нижнем регистре. */
export function splitIdentifier(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-zА-Яа-яЁё0-9]+/)
    .map(s => s.toLowerCase())
    .filter(s => s.length >= 2)
}

/** Текст документа символа: вид, имя (+слова), doc-контекст, сигнатура, родитель, путь. */
export function buildSymbolDocText(n: CodeMapNode): string {
  const words = splitIdentifier(n.name).join(' ')
  const sig = n.signature.replace(/\s+/g, ' ').trim().slice(0, 200)
  // Docstring/JSDoc/декораторы — единственное «человеческое» описание символа:
  // именно по нему E5 находит описательные запросы («логин по email и паролю»).
  const doc = (n.doc ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  const parts = [
    `${n.kind} ${n.name}`,
    words && words !== n.name.toLowerCase() ? words : '',
    doc,
    sig,
    n.parentName ? `defined in ${n.parentName}` : '',
    n.filePath,
  ].filter(Boolean)
  return parts.join(' — ').slice(0, MAX_DOC_CHARS)
}

/** Текст документа файла: путь + список экспортированных символов. */
export function buildFileDocText(fileNode: CodeMapNode, symbols: CodeMapNode[]): string {
  const exported = symbols.filter(s => s.exported)
  const list = exported.slice(0, 20).map(s => `${s.name} (${s.kind})`).join(', ')
  const more = exported.length > 20 ? `, +${exported.length - 20} more` : ''
  const base = `File ${fileNode.filePath}`
  return (list ? `${base} — exports: ${list}${more}` : base).slice(0, MAX_DOC_CHARS)
}

/**
 * Скриптовые языки без ключевого слова export: top-level функции/классы —
 * их публичный API (в Python .py-файле НЕ exported по /^export/-эвристике
 * sidecar'а, но искать их нужно в первую очередь).
 */
const SCRIPT_LANG_RE = /\.(py|pyi|go|rs|java|cs|rb|php)$/i

/**
 * Поля и переменные не получают семантических документов: текст «variable
 * readOnly» не несёт смысла для E5, а в проектах с богатыми типами (C#/Unity)
 * это 40%+ всех эмбеддингов — прогрев, размер БД и память растут впустую.
 * Имена всё равно ищутся точным каналом findNodes (узлы карты остаются).
 */
const NO_DOC_KINDS = new Set(['variable', 'field'])

/**
 * Минимальная длина docstring, при которой символ без `export` всё равно
 * получает вектор. Короче — это пересказ имени, E5 не даёт прироста над
 * lexical-каналом, а прогрев/БД растут.
 */
const MIN_DOC_CHARS = 30

/**
 * Документы файла из его узлов (узлы уже содержат file-узел с kind='file').
 *
 * Тир определяет, попадает ли документ в E5-индекс:
 *  - 0 — только lexical (текст лежит в code_map_docs, вектор не считается);
 *  - 1 — публичный API: файл с экспортами, exported-символы;
 *  - 2 — внутренние символы с реальным docstring.
 * Раньше по tier-2 шли ВСЕ внутренние функции (80% документов) — их текст
 * почти дословно повторяет имя, вектор бесполезен. Плюс пустые file-доки
 * («File src/x.ts» без единого экспорта) давали шум при 70% длины.
 */
export function buildDocsForFile(nodes: CodeMapNode[]): CodeMapDocInfo[] {
  const fileNode = nodes.find(n => n.kind === 'file')
  const symbols = nodes.filter(n => n.kind !== 'file' && n.kind !== 'package' && !NO_DOC_KINDS.has(n.kind))
  const docs: CodeMapDocInfo[] = []
  if (fileNode) {
    const text = buildFileDocText(fileNode, symbols)
    const hasExports = symbols.some(s => s.exported)
    docs.push({
      nodeId: fileNode.id, filePath: fileNode.filePath, kind: 'file',
      tier: hasExports ? 1 : 0, text, textHash: sha256(text),
    })
  }
  const scriptLang = fileNode ? SCRIPT_LANG_RE.test(fileNode.filePath) : false
  const byName = new Map(symbols.map(s => [s.name, s]))
  for (const s of symbols) {
    const text = buildSymbolDocText(s)
    const docLen = (s.doc ?? '').trim().length
    // Метод/конструктор внутри экспортируемого класса — публичный API класса.
    const parent = s.parentName ? byName.get(s.parentName) : undefined
    const inExportedContainer = !!parent?.exported && (s.kind === 'method' || s.kind === 'constructor')
    let tier: 0 | 1 | 2
    if (s.exported || (scriptLang && !s.parentName) || inExportedContainer) tier = 1
    else if ((scriptLang && !!s.parentName) || docLen >= MIN_DOC_CHARS) tier = 2
    else tier = 0
    docs.push({ nodeId: s.id, filePath: s.filePath, kind: s.kind, tier, text, textHash: sha256(text) })
  }
  return docs
}

// ─── Синхронизация карты → документы ─────────────────────────────────────────

/**
 * Раздельные ревизии проекта. Документы (тексты/состав) и векторы меняются в
 * разном темпе: правка файла меняет документы, а прогрев пишет по пачке
 * векторов. Раньше ревизия была одна, и каждая запись векторов выбрасывала
 * lexical-индекс — при прогреве на 15k документов это пересобирало постинги
 * десятки раз на пустом месте.
 */
interface ProjectRevs { docs: number; vectors: number }

const revsByProject = new Map<string, ProjectRevs>()
function revsOf(projectId: string): ProjectRevs {
  let r = revsByProject.get(projectId)
  if (!r) { r = { docs: 0, vectors: 0 }; revsByProject.set(projectId, r) }
  return r
}

/** Состав/тексты документов изменились — инвалидируются lexical и матрица. */
function bumpDocsRev(projectId: string): void {
  const r = revsOf(projectId)
  r.docs++
  r.vectors++
}

/** Появились/обновились векторы — инвалидируется только матрица. */
function bumpVectorRev(projectId: string): void {
  revsOf(projectId).vectors++
}

/** Пересобрать документы файла по его узлам. Вызывается рядом с replaceFile. */
export function syncFileDocs(projectId: string, filePath: string, nodes: CodeMapNode[]): void {
  const desired = buildDocsForFile(nodes)
  const existing = store.listDocMetaByFile(projectId, filePath)
  const keep = new Set(desired.map(d => d.nodeId))
  const orphan = [...existing.keys()].filter(id => !keep.has(id))
  store.upsertDocs(projectId, desired)
  store.deleteDocsByIds(projectId, orphan)
  bumpDocsRev(projectId)
  semanticWorker.nudge()
}

/** Файл исчез из карты (удалён с диска / перестал поддерживаться). */
export function removeFileDocs(projectId: string, filePath: string): void {
  store.deleteDocsByFile(projectId, filePath)
  bumpDocsRev(projectId)
}

/**
 * Полная пересборка карты: документы осиротевших узлов удаляются, документы
 * выживших остаются с векторами (текст тот же → hash-гейт сохранит embedding).
 * Полный clearDocs оставлен для миграции схемы, когда правила текста сменились.
 */
export function pruneProjectDocs(projectId: string): number {
  const removed = store.pruneOrphanDocs(projectId)
  if (removed > 0) bumpDocsRev(projectId)
  return removed
}

/** Полная пересборка карты — документы тоже под ноль. */
export function clearProjectDocs(projectId: string): void {
  store.clearDocs(projectId)
  bumpDocsRev(projectId)
}

// ─── Lexical: инвертированный индекс слов документов ─────────────────────────

interface LexicalIndex {
  rev: number
  builtAt: number
  docCount: number
  postings: Map<string, Set<string>>
}

const lexicalByProject = new Map<string, LexicalIndex>()

/**
 * Минимальный интервал пересборки кэшей. Во время прогрева документы меняются
 * с каждой пачкой файлов — без guard'а каждый запрос пересобирал бы индекс
 * заново (sync-работа в main). 2с устаревания на поисковый результат не влияют.
 */
const CACHE_REBUILD_MIN_MS = 2000

function tokenizeDoc(text: string): string[] {
  return text.toLowerCase().split(/[^a-zа-яё0-9]+/).filter(t => t.length >= 2)
}

function getLexicalIndex(projectId: string): LexicalIndex {
  const rev = revsOf(projectId).docs
  const cached = lexicalByProject.get(projectId)
  if (cached && (cached.rev === rev || Date.now() - cached.builtAt < CACHE_REBUILD_MIN_MS)) return cached
  const idx: LexicalIndex = { rev, builtAt: Date.now(), docCount: 0, postings: new Map() }
  for (const d of store.listDocTexts(projectId)) {
    idx.docCount++
    for (const t of tokenizeDoc(d.text)) {
      let post = idx.postings.get(t)
      if (!post) { post = new Set(); idx.postings.set(t, post) }
      post.add(d.nodeId)
    }
  }
  // Кэш lexical маленький (постинги без векторов) — держим до 4 проектов.
  if (lexicalByProject.size >= 4) lexicalByProject.clear()
  lexicalByProject.set(projectId, idx)
  return idx
}

/** Топ-K по словам запроса (idf-веса; канал деградации и усилитель векторов). */
function lexicalTopK(projectId: string, query: string, k: number): string[] {
  const idx = getLexicalIndex(projectId)
  if (idx.docCount === 0) return []
  const qTokens = [...new Set(tokenizeDoc(query))]
  if (qTokens.length === 0) return []
  const scores = new Map<string, number>()
  for (const t of qTokens) {
    const post = idx.postings.get(t)
    if (!post) continue
    const idf = Math.log(1 + idx.docCount / post.size)
    for (const id of post) scores.set(id, (scores.get(id) ?? 0) + idf)
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(e => e[0])
}

// ─── Векторная матрица проекта (только для активного, лениво) ────────────────

interface VectorMatrix {
  rev: number
  builtAt: number
  ids: string[]
  vectors: Float32Array
  norms: Float32Array
  dim: number
}

let matrixProjectId: string | null = null
let matrix: VectorMatrix | null = null

function getMatrix(projectId: string): VectorMatrix | null {
  const rev = revsOf(projectId).vectors
  if (matrix && matrixProjectId === projectId
    && (matrix.rev === rev || Date.now() - matrix.builtAt < CACHE_REBUILD_MIN_MS)) return matrix
  const rows = store.listDocVectors(projectId, 2000, MODEL_TAG)
  if (rows.length === 0) {
    // Векторов ещё нет (проект не грели) — матрицу не держим, честно null.
    matrix = null
    matrixProjectId = projectId
    return null
  }
  const dim = rows[0].embedding.byteLength >> 2
  const vectors = new Float32Array(rows.length * dim)
  const norms = new Float32Array(rows.length)
  const ids: string[] = []
  let w = 0
  for (const r of rows) {
    if ((r.embedding.byteLength >> 2) !== dim) continue // чужая/сломанная размерность
    const vec = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, dim)
    vectors.set(vec, w)
    let sum = 0
    for (let j = 0; j < dim; j++) sum += vec[j] * vec[j]
    norms[ids.length] = Math.sqrt(sum)
    ids.push(r.nodeId)
    w += dim
  }
  // Держим матрицу только одного проекта — память не растёт по числу проектов.
  matrix = { rev, builtAt: Date.now(), ids, vectors: vectors.subarray(0, w), norms: norms.subarray(0, ids.length), dim }
  matrixProjectId = projectId
  return matrix
}

/** Топ-K по cosine (векторы могут быть не нормированы — считаем честно). Экспортирован для тестов. */
export function topKByCosine(m: VectorMatrix, query: Float32Array, k: number): string[] {
  if (query.length !== m.dim) return []
  let qn = 0
  for (let j = 0; j < m.dim; j++) qn += query[j] * query[j]
  qn = Math.sqrt(qn) || 1
  const n = m.ids.length
  const scores = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const off = i * m.dim
    let dot = 0
    for (let j = 0; j < m.dim; j++) dot += m.vectors[off + j] * query[j]
    const norm = m.norms[i] * qn
    scores[i] = norm > 0 ? dot / norm : 0
  }
  const order = Array.from({ length: n }, (_, i) => i)
  order.sort((a, b) => scores[b] - scores[a])
  return order.slice(0, k).map(i => m.ids[i])
}

// ─── RRF-слияние каналов ─────────────────────────────────────────────────────

export interface MergedHit {
  score: number
  matchedBy: CodeMapSemanticHit['matchedBy']
}

/**
 * Reciprocal Rank Fusion: score = Σ 1/(k + rank). Векторный канал несёт смысл,
 * lexical (слова документов + точное имя) страхует его на идентификаторах.
 */
export function rrfMerge(vectorIds: string[], docWordIds: string[], nameIds: string[], k = 60): Map<string, MergedHit> {
  const out = new Map<string, { score: number; vec: boolean; lex: boolean }>()
  const add = (ids: string[], channel: 'vec' | 'lex') => {
    ids.forEach((id, rank) => {
      const e = out.get(id) ?? { score: 0, vec: false, lex: false }
      e.score += 1 / (k + rank + 1)
      if (channel === 'vec') e.vec = true
      else e.lex = true
      out.set(id, e)
    })
  }
  add(vectorIds, 'vec')
  add(docWordIds, 'lex')
  add(nameIds, 'lex')
  const merged = new Map<string, MergedHit>()
  for (const [id, e] of out) {
    merged.set(id, { score: e.score, matchedBy: e.vec && e.lex ? 'both' : e.vec ? 'semantic' : 'lexical' })
  }
  return merged
}

// ─── Поиск ───────────────────────────────────────────────────────────────────

/**
 * Дедлайн query-эмбеда для интерактивного поиска. Sidecar serial: во время
 * прогрева worker гоняет пачки, memory-циклы держат его до 60с — запрос тула
 * не должен стоять в этой очереди. Не успел → сразу честный lexical-ответ
 * (векторы дозреют — режим сменится сам). Тёплому sidecar на один короткий
 * текст хватает десятков миллисекунд, 1.5с — уже «занят».
 */
const QUERY_EMBED_DEADLINE_MS = 1500

/**
 * Тестовые пути приглушаются в ранжировании: тесты поверхностно повторяют
 * слова продакшн-кода (verify_password, captcha, ...) и на поведенческих
 * запросах выталкивают сам endpoint. Не удаляем — иногда тест и есть цель.
 */
const TEST_PATH_RE = /(^|\/)(tests?|__tests__|__mocks__|__snapshots__|spec|testing)(\/|$)|\.(test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]*$|_[gs]?test\.[a-z0-9]+$/i
const TEST_DEMOTION = 0.3

/** Экспортирован для тестов. */
export function isTestPath(filePath: string): boolean {
  return TEST_PATH_RE.test(filePath)
}

/**
 * Слова запроса, похожие на идентификаторы (ASCII, ≥3 символа): «скидки на
 * модели get_user_input_price» должны получить точное имя-совпадение, а не
 * только векторную близость. Берём только полное совпадение имени или
 * префикс — иначе частые английские слова (email, token) добавляют шум.
 */
function queryIdentifierWords(query: string): string[] {
  return [...new Set(query.split(/[^A-Za-z0-9_]+/).filter(w => w.length >= 3 && w.length <= 64))].slice(0, 5)
}

/** Имя узла, совпавшее с запросом/словом запроса целиком (регистр не важен). */
function sameName(a: string, b: string): boolean {
  return a === b || a.replace(/[^a-z0-9]/g, '') === b.replace(/[^a-z0-9]/g, '')
}

/**
 * Гибридный семантический поиск по карте. mode='e5' — векторы готовы; 'lexical'
 * — модель недоступна/векторы не догрели/запрос попал в точное имя; 'none' —
 * ни один канал не дал ответа.
 *
 * Порядок важен: лексические каналы (слова документов + точное имя) считаются
 * первыми и синхронно — поиск по идентификатору отвечает мгновенно и никогда
 * не ждёт инференс. Векторный канал подключается только если он уже готов
 * (модель есть, актуальные векторы в БД) и запрос не пойман точным именем;
 * ждёт он не дольше QUERY_EMBED_DEADLINE_MS. Дескриптивные запросы получают
 * полный гибрид, холодный/занятый sidecar — bounded lexical fallback.
 */
export async function searchSemantic(projectId: string, query: string, limit = 10): Promise<CodeMapSemanticResult> {
  const started = Date.now()
  // Запрос = явный сигнал «семантика этого проекта нужна» → worker прогреет его.
  semanticWorker.request(projectId)
  const { total, indexed, lexicalOnly } = store.countDocs(projectId, MODEL_TAG)
  // Нет документов вообще — искать нечего. Документы tier 0 (только lexical)
  // НЕ повод для 'none': lexical-канал по ним работает и без E5.
  if (total === 0 && (lexicalOnly ?? 0) === 0) {
    return { mode: 'none', totalDocs: 0, indexedDocs: 0, hits: [] }
  }
  const k = Math.max(limit * 4, 40)

  // ── 1. Lexical + точное имя (sync, без sidecar) ──
  const lexicalStarted = Date.now()
  const docWordIds = lexicalTopK(projectId, query, k)
  const nameIds: string[] = []
  const seenNames = new Set<string>()
  let strongExactName = false
  const qLower = query.trim().toLowerCase()
  // Слова-идентификаторы первыми: точное имя сильнее полного-запроса LIKE.
  for (const w of queryIdentifierWords(query)) {
    const lower = w.toLowerCase()
    for (const n of store.findNodes(projectId, w, 5)) {
      const nameLower = n.name.toLowerCase()
      if (!nameLower.startsWith(lower)) continue
      if (sameName(nameLower, lower)) strongExactName = true
      if (seenNames.has(n.id)) continue
      seenNames.add(n.id)
      nameIds.push(n.id)
    }
  }
  for (const n of store.findNodes(projectId, query, 10)) {
    if (sameName(n.name.toLowerCase(), qLower)) strongExactName = true
    if (!seenNames.has(n.id)) { seenNames.add(n.id); nameIds.push(n.id) }
  }
  const lexicalMs = Date.now() - lexicalStarted

  // ── 2. Векторный канал — только если готов и нужен ──
  let vectorIds: string[] = []
  let embedMs = -1
  if (strongExactName) {
    log('[mapSemantic] query "%s" — exact name match, vector channel skipped', query)
  } else if (indexed > 0) {
    const paths = resolveSemanticModelPaths()
    const m = paths ? getMatrix(projectId) : null
    if (paths && m && m.ids.length > 0) {
      const embedStarted = Date.now()
      try {
        const qvec = await Promise.race([
          sidecarSemanticEmbed([query], 'query', paths),
          sleep(QUERY_EMBED_DEADLINE_MS).then(() => null),
        ])
        embedMs = Date.now() - embedStarted
        const vec = qvec?.[0] ? Float32Array.from(qvec[0]) : null
        if (vec) {
          const matrixStarted = Date.now()
          vectorIds = topKByCosine(m, vec, k)
          log(`[mapSemantic] query vector top-K: %d hits from %d vectors (matrix+cosine %dms)`,
            vectorIds.length, m.ids.length, Date.now() - matrixStarted)
        }
        if (embedMs >= QUERY_EMBED_DEADLINE_MS) {
          log('[mapSemantic] query embed deadline hit (%dms) — sidecar busy, lexical fallback', embedMs)
        }
      } catch (e) {
        embedMs = Date.now() - embedStarted
        // sidecar занят/недоступен — тихо деградируем в lexical, агент видит режим.
        log('[mapSemantic] query embed failed (%dms), falling back to lexical: %s',
          embedMs, e instanceof Error ? e.message : String(e))
      }
    }
  }

  let mode: CodeMapSemanticMode = 'none'
  if (vectorIds.length > 0) mode = 'e5'
  else if (docWordIds.length > 0 || nameIds.length > 0) mode = 'lexical'
  if (mode === 'none') {
    log(`[mapSemantic] query "%s" — no channels (%d docs, %d indexed, %dms)`, query, total, indexed, Date.now() - started)
    return { mode, totalDocs: total, indexedDocs: indexed, hits: [] }
  }

  const merged = rrfMerge(vectorIds, docWordIds, nameIds)
  const ranked = [...merged.entries()].sort((a, b) => b[1].score - a[1].score)

  // Демоция тестов — ПОСЛЕ слияния: перекладываем итоговый порядок.
  const scored: Array<{ node: CodeMapNode; score: number; matchedBy: CodeMapSemanticHit['matchedBy'] }> = []
  for (const [nodeId, m] of ranked) {
    const node = store.getNode(projectId, nodeId)
    if (!node) continue
    const score = isTestPath(node.filePath) ? m.score * TEST_DEMOTION : m.score
    scored.push({ node, score, matchedBy: m.matchedBy })
  }
  scored.sort((a, b) => b.score - a.score)
  const hits = scored.slice(0, limit).map(h =>
    ({ node: h.node, score: h.score, matchedBy: h.matchedBy }))
  log(`[mapSemantic] query "%s" → mode=%s, %d/%d indexed, %d hits | embed=%dms lexical=%dms total=%dms`,
    query, mode, indexed, total, hits.length, embedMs, lexicalMs, Date.now() - started)
  return { mode, totalDocs: total, indexedDocs: indexed, hits }
}

// ─── Worker: фоновый эмбеддинг очереди документов ────────────────────────────

const NUDGE_DELAY_MS = 1500
const MODEL_RETRY_MS = 5 * 60 * 1000
const EMBED_RETRY_MS = 15_000
const IDLE_POLL_MS = 2000
const BUILD_PAUSE_MS = 400
// Sidecar serial: между пачками оставляем паузы, чтобы горячие запросы
// (токены, symbols, query-эмбед тула) не стояли за непрерывным прогревом.
const IDLE_PAUSE_MS = 120
const BATCH_BUILD = 64
const BATCH_IDLE = 128
const FOREGROUND_WAIT_CAP_MS = 60_000

class SemanticWorker {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private stopped = true
  private activeProjectId: string | null = null
  private foregroundBusy: () => boolean = () => false
  private mapBuilding: () => boolean = () => false
  private lastModelFailAt = 0
  private stateByProject = new Map<string, CodeMapSemanticState>()
  private errorByProject = new Map<string, string>()
  /** Прогресс наружу (IPC → баннер/настройки) с троттлингом по проекту. */
  private progressCb: ((p: CodeMapProgress) => void) | null = null
  private lastProgressEmit = new Map<string, number>()
  /** Проекты, для которых мы уже эмитили warming — по ним шлём финал ready. */
  private touched = new Set<string>()
  /**
   * Проекты, по которым семантика реально нужна (был semantic-запрос или
   * открыта карта). Прогрев остальных проектов не запускается: раньше worker
   * через 5 с после старта грел ВСЕ проекты (15.6k документов), хотя агент за
   * всю историю не сделал ни одного semantic-запроса.
   */
  private requested = new Set<string>()

  setForegroundPredicate(fn: () => boolean): void { this.foregroundBusy = fn }
  setMapBuildingPredicate(fn: () => boolean): void { this.mapBuilding = fn }
  setProgressCallback(cb: (p: CodeMapProgress) => void): void { this.progressCb = cb }

  /** Запросить прогрев семантики проекта (первый semantic-запрос/открытие карты). */
  request(projectId: string): void {
    if (this.requested.has(projectId)) return
    this.requested.add(projectId)
    this.nudge()
  }

  hasRequested(projectId: string): boolean {
    return this.activeProjectId === projectId || this.requested.has(projectId)
  }
  setActiveProject(projectId: string | null): void {
    this.activeProjectId = projectId
    this.nudge()
  }

  /**
   * Никакого глобального прогрева на старте: E5 опционален и включается только
   * явным запросом (semantic-поиск или открытая карта проекта). start() лишь
   * снимает флаг stopped — первый nudge придёт от request()/syncFileDocs.
   */
  start(): void {
    this.stopped = false
  }

  stop(): void {
    this.stopped = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }

  /** Разбудить worker: появились новые/изменённые документы. Debounce 1.5s. */
  nudge(): void {
    if (this.stopped || this.running || this.timer) return
    // Ни один проект не запрошен — греть нечего, цикл не запускаем вовсе.
    if (!this.activeProjectId && this.requested.size === 0) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.loop()
    }, NUDGE_DELAY_MS)
  }

  private async waitWhileForeground(): Promise<void> {
    let waited = 0
    while (this.foregroundBusy() && waited < FOREGROUND_WAIT_CAP_MS && !this.stopped) {
      await sleep(1000)
      waited += 1000
    }
  }

  /**
   * Паркуемся с автоповтором: sidecar/модель недоступны — не крутить холосто.
   * Короткий ретрай на временный сбой embed (sidecar занят парсингом), длинный
   * на отсутствие модели (скачивание тяжёлое, у semanticIndex окно 5 минут).
   */
  private park(error: string, delayMs = EMBED_RETRY_MS): void {
    if (this.stopped) return
    log('[mapSemantic] worker parked for %dms: %s', delayMs, error)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.loop()
    }, delayMs)
    for (const pid of store.listPendingDocProjectIds(MODEL_TAG)) {
      // Ошибку показываем только по проектам, которые реально ждут прогрева:
      // у остальных честный статус 'deferred'.
      if (!this.hasRequested(pid)) continue
      this.stateByProject.set(pid, 'error')
      this.errorByProject.set(pid, error)
      this.emitSemanticProgress(pid, true)
    }
  }

  /** Наблюдаемое состояние worker'а по проекту (для getSemanticStatus). */
  snapshot(projectId: string): { state: CodeMapSemanticState | null; error: string | null } {
    return {
      state: this.stateByProject.get(projectId) ?? null,
      error: this.errorByProject.get(projectId) ?? null,
    }
  }

  /**
   * Прогресс семантической индексации (фаза 'semantic'; при полном догреве —
   * 'ready', чтобы баннер закрылся). force — финальные/ошибочные события.
   */
  private emitSemanticProgress(projectId: string, force = false): void {
    if (!this.progressCb) return
    if (!force) {
      const now = Date.now()
      if (now - (this.lastProgressEmit.get(projectId) ?? 0) < 800) return
      this.lastProgressEmit.set(projectId, now)
    }
    const s = getSemanticStatus(projectId)
    const done = s.totalDocs > 0 && s.indexedDocs >= s.totalDocs
    this.touched.add(projectId)
    try {
      this.progressCb?.({
        projectId,
        phase: done ? 'ready' : 'semantic',
        percent: s.totalDocs > 0 ? Math.round((s.indexedDocs / s.totalDocs) * 100) : 0,
        indexedFiles: s.indexedDocs,
        totalFiles: s.totalDocs,
        message: done
          ? `Семантика готова: ${s.indexedDocs} документов (${s.mode})`
          : `Семантика: ${s.indexedDocs}/${s.totalDocs}`,
        semantic: { state: s.state, indexedDocs: s.indexedDocs, totalDocs: s.totalDocs },
      })
    } catch { /* UI-подписчики не должны ломать индексацию */ }
  }

  private async loop(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.loopInner()
    } catch (e) {
      // БД может быть не инициализирована на старте (getDB бросает), sidecar —
      // умирать посреди пачки. Паркуемся коротко и пробуем снова — worker не
      // должен валить процесс unhandled rejection'ом. log() — не console.warn:
      // debug.log — единственное место, где цикл виден.
      log('[mapSemantic] worker loop failed, retry in %dms: %s',
        EMBED_RETRY_MS, e instanceof Error ? e.message : String(e))
      this.timer = setTimeout(() => {
        this.timer = null
        void this.loop()
      }, EMBED_RETRY_MS)
    } finally {
      this.running = false
    }
  }

  private async loopInner(): Promise<void> {
      for (;;) {
      if (this.stopped) return
      const projects = store.listPendingDocProjectIds(MODEL_TAG).filter(pid => this.hasRequested(pid))
      if (projects.length === 0) {
        // Всё проиндексировано: финальные ready-события по затронутым проектам
        // (баннер закрывается, настройки обновляют счётчики), затем ждём nudge.
        for (const pid of this.touched) this.emitSemanticProgress(pid, true)
        this.touched.clear()
        return
      }
      const paths = resolveSemanticModelPaths()
      if (!paths) {
        if (Date.now() - this.lastModelFailAt >= MODEL_RETRY_MS) {
          const ok = await ensureModelFiles()
          this.lastModelFailAt = ok ? 0 : Date.now()
          if (ok) continue // модель появилась — пробуем снова
        }
        this.park('semantic model not downloaded yet — lexical mode active', MODEL_RETRY_MS)
        return
      }

      const ordered = this.activeProjectId && projects.includes(this.activeProjectId)
        ? [this.activeProjectId, ...projects.filter(pid => pid !== this.activeProjectId)]
        : projects
      let worked = false

      for (const pid of ordered) {
        if (this.stopped) return
        await this.waitWhileForeground()
        if (this.stopped) return
        if (!this.hasRequested(pid)) continue
        const batch = this.mapBuilding() ? BATCH_BUILD : BATCH_IDLE
        const docs = store.listPendingDocs(pid, batch, MODEL_TAG)
        if (docs.length === 0) continue
        this.stateByProject.set(pid, 'warming')
        this.errorByProject.delete(pid)

        let vectors: number[][] | null = null
        const batchStarted = Date.now()
        try {
          vectors = await sidecarSemanticEmbed(docs.map(d => d.text), 'passage', paths)
        } catch (e) {
          log('[mapSemantic] embed batch failed: %s', e instanceof Error ? e.message : String(e))
        }
        if (!vectors || vectors.length !== docs.length) {
          this.park('sidecar embed failed — will retry', EMBED_RETRY_MS)
          return
        }

        const now = Date.now()
        const items = docs.map((d, i) => ({
          nodeId: d.nodeId,
          textHash: d.textHash,
          embedding: embeddingToBuffer(Float32Array.from(vectors![i])),
          model: MODEL_TAG,
          embeddedAt: now,
        }))
        let saved = 0
        try {
          saved = store.saveDocEmbeddings(pid, items)
        } catch (e) {
          // Rust-semantic пишет в тот же syntee.db (memory-цикл) — возможен
          // SQLITE_BUSY на fail-fast соединении. Транзиент: пача переэмбедится.
          log('[mapSemantic] save batch failed (busy?): %s', e instanceof Error ? e.message : String(e))
          worked = false
          await sleep(IDLE_POLL_MS)
          continue
        }
        if (saved < docs.length) {
          log('[mapSemantic] batch saved %d/%d (hash-gate rejects stale texts)', saved, docs.length)
        }
        // Векторы изменились → инвалидируем ТОЛЬКО матрицу, lexical-индекс
        // (построенный по текстам документов) остаётся валидным.
        bumpVectorRev(pid)
        if (saved > 0) worked = true
        this.emitSemanticProgress(pid)
        log('[mapSemantic] batch %s: %d docs in %dms (saved %d, tier up to %d)',
          pid.slice(0, 8), docs.length, Date.now() - batchStarted, saved, docs[docs.length - 1].tier)
        // Пачка ушла в sidecar — короткая пауза; при сборке карты подольше,
        // чтобы embed-запросы не толкались с парсингом в serial-sidecar.
        await sleep(this.mapBuilding() ? BUILD_PAUSE_MS : IDLE_PAUSE_MS)
      }
      if (!worked) await sleep(IDLE_POLL_MS) // всё ждёт foreground — не крутиться
    }
  }
}

export const semanticWorker = new SemanticWorker()

// ─── Статус и прогресс ───────────────────────────────────────────────────────

/**
 * Текущее состояние семантического слоя проекта (для IPC/настроек).
 *
 * 'deferred' — документы есть, но проект не запрашивали: векторов нет и
 * прогрева не будет, пока не придёт semantic-запрос. Это честное состояние, а
 * не вечный 'warming'. Ошибка воркера важнее deferred — она объясняет причину.
 */
export function getSemanticStatus(projectId: string): CodeMapSemanticStatus {
  const { total, indexed, lexicalOnly } = store.countDocs(projectId, MODEL_TAG)
  const snap = semanticWorker.snapshot(projectId)
  const requested = semanticWorker.hasRequested(projectId)
  let state: CodeMapSemanticState
  if (total === 0 && (lexicalOnly ?? 0) === 0) state = 'off'
  // Только lexical-документы (tier 0): поиск уже готов, эмбеддить нечего.
  else if (total === 0) state = 'ready'
  else if (indexed >= total) state = 'ready'
  else if (!requested) state = 'deferred'
  else if (snap.state === 'error') state = 'error'
  else state = 'warming'
  const mode: CodeMapSemanticMode = indexed > 0 && resolveSemanticModelPaths() ? 'e5' : 'lexical'
  return { state, mode, totalDocs: total, indexedDocs: indexed, error: state === 'error' ? snap.error : null }
}
