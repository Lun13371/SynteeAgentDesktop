/**
 * MemoryStore — унифицированное хранилище памяти агента.
 *
 * Заменяет собой:
 *   - MemoryEngine.ts (старая key-value память в отдельном memory.db)
 *   - мёртвый saveMemory/getAllMemory из db/memory.ts
 *
 * 4 типа памяти (kind):
 *   - user_fact         — факты о пользователе (личное, предпочтения, работа)
 *   - project_decision  — архитектурные решения/конвенции проекта
 *   - conversation      — эпизодическая: итоги прошлых диалогов
 *   - agent_outcome     — уроки из исходов действий агента
 *
 * 3 scope:
 *   - global  — сквозная память через все проекты/чаты
 *   - project — привязана к конкретному project_id
 *   - chat    — только в пределах одного чата (для agent_outcome)
 *
 * Запись: saveMemoryItem() с dedup (key → update; иначе cosine>0.92 → merge; иначе insert).
 * Чтение:  searchMemory() — гибридный скоринг (TF-IDF cosine + importance + recency + pinned).
 *          buildCuratedSummary() — топ фактов для системного промпта.
 * Забывание: decayPrune() — удаляет низко-important неиспользуемые записи (pinned защищены).
 *
 * Embeddings: TF-IDF (default, мгновенно) через существующий embeddings.ts.
 * Neural (MiniLM ONNX) — opt-in через setUseNeuralEmbeddings.
 */

import { v4 as uuid } from 'uuid'
import { getDB } from '../db/handle'
import {
  getEmbedder,
  cosineSimilarity,
  embeddingToBuffer,
  bufferToEmbedding,
  setActiveProjectId,
  updateTfidfIdf,
  type Embedding,
} from '../context/embeddings'
import {
  searchMessagesFTS,
  searchChatSummaries,
  searchAgentLogs,
  searchPinnedMessages,
  type SearchSourceName,
} from './chatSearch'

// ─── Типы ────────────────────────────────────────────────────────────────────

export type MemoryScope = 'global' | 'project' | 'chat'
export type MemoryKind = 'user_fact' | 'project_decision' | 'convention' | 'conversation' | 'agent_outcome'
export type MemorySource =
  | 'user_explicit'    // юзер сказал «запомни»
  | 'agent_tool'       // агент вызвал save_memory
  | 'auto_extract'     // LLM-извлечение из диалога
  | 'compaction'       // синк из chat_summaries
  | 'agent_log'        // извлечение уроков из agent_logs
  | 'legacy_migration' // перенос из старой memory table
  | 'user_manual'      // ручной ввод через UI

export interface MemoryItem {
  id: string
  title: string
  scope: MemoryScope
  projectId: string | null
  chatId: string | null
  kind: MemoryKind
  category: string | null
  key: string | null
  content: string
  source: MemorySource
  confidence: number
  importance: number
  accessCount: number
  lastAccessedAt: number | null
  pinned: boolean
  metadata: Record<string, unknown> | null
  createdAt: number
  updatedAt: number
}

export interface SaveMemoryInput {
  title: string
  content: string
  kind: MemoryKind
  scope?: MemoryScope // default: 'project' если есть projectId, иначе 'global'
  projectId?: string
  chatId?: string
  category?: string
  key?: string
  source?: MemorySource // default: 'agent_tool'
  confidence?: number // default: 1.0
  importance?: number // default: 0.5
  pinned?: boolean // default: true если source='user_explicit', иначе false
  metadata?: Record<string, unknown>
}

export interface SearchMemoryParams {
  query: string
  kind?: MemoryKind
  /** 'global' | 'project' | 'all' (default: 'all' = global + текущий проект) */
  scope?: MemoryScope | 'all'
  projectId?: string // для scope='project' или 'all'
  limit?: number // default: 8 (для memory_items)
  minScore?: number // default: 0.01
  /**
   * Какие источники искать (multi-source search). Default: все 5.
   * - 'memory'       → memory_items (TF-IDF + importance + recency)
   * - 'messages'     → messages (FTS5 trigram + bm25)
   * - 'summaries'    → chat_summaries (LIKE + recency)
   * - 'agent_logs'   → agent_logs (LIKE, recent 14d)
   * - 'pinned'       → pinned_messages (FTS5 + boost)
   */
  sources?: SearchSourceName[] | 'all'
}

export interface SearchResult {
  item: MemoryItem
  score: number
}

/**
 * Унифицированный результат multi-source поиска. Возвращается searchAllSources.
 * Поле source указывает откуда пришёл результат.
 * Для messages/pinned дополнительно: chatId, chatTitle, messageId, role, date.
 * Для memory: kind, scope, key (внутри item).
 */
export interface MultiSourceResult {
  source: 'memory' | SearchSourceName
  content: string
  score: number // 0..1, normalized для сравнения между источниками
  // Memory-specific (когда source='memory'):
  item?: MemoryItem
  // Messages/pinned-specific:
  chatId?: string
  chatTitle?: string
  messageId?: string
  role?: string
  date?: number
}

export interface ListMemoryFilter {
  scope?: MemoryScope
  kind?: MemoryKind
  projectId?: string
  category?: string
  search?: string // LIKE по content
  limit?: number
  offset?: number
}

// ─── Внутренние хелперы ──────────────────────────────────────────────────────

const MEMORY_IDF_NAMESPACE = '__syntee_memory__'
const SEMANTIC_MERGE_THRESHOLD = 0.92

/** IDF cache для памяти. Строится лениво из всех memory_items.content. */
let _idfBuilt = false

function invalidateIdfCache(): void {
  _idfBuilt = false
}

function ensureMemoryIdf(): void {
  if (_idfBuilt) return
  try {
    const db = getDB()
    const rows = db.prepare(`SELECT content FROM memory_items`).all() as { content: string }[]
    updateTfidfIdf(
      MEMORY_IDF_NAMESPACE,
      rows.map(r => r.content),
    )
    _idfBuilt = true
  } catch {
    // БД пуста или недоступна — IDF не построен, embed вернёт zero-vector.
    // Не критично: search упадёт на LIKE-fallback, save всё равно запишет.
  }
}

/**
 * Embedding текста в namespace памяти. Синхронно для TF-IDF, async для neural.
 * Важно: setActiveProjectId переключает global IDF cache — FastContext после
 * этого выставит свой projectId, так что конфликтов нет (JS single-threaded).
 */
async function embedText(text: string): Promise<Embedding> {
  ensureMemoryIdf()
  setActiveProjectId(MEMORY_IDF_NAMESPACE)
  const embedder = await getEmbedder()
  return embedder.embed(text)
}

function rowToItem(row: Record<string, unknown>): MemoryItem {
  let metadata: Record<string, unknown> | null = null
  if (row.metadata && typeof row.metadata === 'string') {
    try { metadata = JSON.parse(row.metadata) as Record<string, unknown> } catch { /* skip */ }
  }
  return {
    id: row.id as string,
    title: (row.title as string) ?? '',
    scope: row.scope as MemoryScope,
    projectId: (row.project_id as string | null) ?? null,
    chatId: (row.chat_id as string | null) ?? null,
    kind: row.kind as MemoryKind,
    category: (row.category as string | null) ?? null,
    key: (row.key as string | null) ?? null,
    content: row.content as string,
    source: row.source as MemorySource,
    confidence: (row.confidence as number) ?? 1.0,
    importance: (row.importance as number) ?? 0.5,
    accessCount: (row.access_count as number) ?? 0,
    lastAccessedAt: (row.last_accessed_at as number | null) ?? null,
    pinned: Boolean(row.pinned),
    metadata,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  }
}

// ─── SAVE (с dedup) ──────────────────────────────────────────────────────────

/**
 * Сохраняет запись в память с дедупликацией:
 *   1. Если есть key и найдена запись с тем же (scope, key) → update
 *   2. Иначе если cosine(новое, существующее same-scope+kind) > 0.92 → merge
 *   3. Иначе insert новой записи
 *
 * Embedding считается всегда (TF-IDF мгновенно). При update/merge embedding
 * пересчитывается от нового content.
 */
export async function saveMemoryItem(input: SaveMemoryInput): Promise<MemoryItem> {
  const db = getDB()
  const now = Date.now()
  const scope: MemoryScope = input.scope ?? (input.projectId ? 'project' : 'global')
  const source: MemorySource = input.source ?? 'agent_tool'
  const pinnedInt = (input.pinned ?? source === 'user_explicit') ? 1 : 0
  const importance = input.importance ?? 0.5
  const confidence = input.confidence ?? 1.0
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null

  // ── 1. Dedup по key ──
  if (input.key) {
    const existing = db.prepare(
      `SELECT * FROM memory_items WHERE scope = ? AND key = ?`
    ).get(scope, input.key) as Record<string, unknown> | undefined

    if (existing) {
      const emb = await embedText(input.content)
      const newImportance = Math.min(1, (existing.importance as number) + 0.1)
      db.prepare(
        `UPDATE memory_items
         SET title = ?, content = ?, category = ?, importance = ?, confidence = ?, embedding = ?, metadata = ?, pinned = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        input.title,
        input.content,
        input.category ?? (existing.category as string | null),
        newImportance,
        confidence,
        embeddingToBuffer(emb),
        metadataJson,
        pinnedInt,
        now,
        existing.id as string,
      )
      invalidateIdfCache()
      const updated = db.prepare(`SELECT * FROM memory_items WHERE id = ?`).get(existing.id) as Record<string, unknown>
      return rowToItem(updated)
    }
  }

  // ── 2. Semantic dedup (cosine > 0.92) ──
  const emb = await embedText(input.content)
  const candidates = db.prepare(
    `SELECT * FROM memory_items WHERE scope = ? AND kind = ? AND embedding IS NOT NULL`
  ).all(scope, input.kind) as Record<string, unknown>[]

  let bestMatch: { id: string; cosine: number; row: Record<string, unknown> } | null = null
  for (const c of candidates) {
    try {
      const cEmb = bufferToEmbedding(c.embedding as Buffer)
      const cos = cosineSimilarity(emb, cEmb)
      if (cos > SEMANTIC_MERGE_THRESHOLD && (!bestMatch || cos > bestMatch.cosine)) {
        bestMatch = { id: c.id as string, cosine: cos, row: c }
      }
    } catch { /* skip corrupted embedding */ }
  }

  if (bestMatch) {
    const existing = bestMatch.row
    // Merge: оставляем более длинный content, boost importance
    const existingContent = existing.content as string
    const mergedContent = input.content.length > existingContent.length ? input.content : existingContent
    const newImportance = Math.min(1, (existing.importance as number) + 0.1)
    db.prepare(
      `UPDATE memory_items
       SET title = ?, content = ?, importance = ?, embedding = ?, updated_at = ?
       WHERE id = ?`
    ).run(input.title, mergedContent, newImportance, embeddingToBuffer(emb), now, bestMatch.id)
    invalidateIdfCache()
    const updated = db.prepare(`SELECT * FROM memory_items WHERE id = ?`).get(bestMatch.id) as Record<string, unknown>
    return rowToItem(updated)
  }

  // ── 3. Insert новой записи ──
  const id = uuid()
  db.prepare(
    `INSERT INTO memory_items
     (id, title, scope, project_id, chat_id, kind, category, key, content, source, confidence, importance, access_count, last_accessed_at, pinned, embedding, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.title,
    scope,
    input.projectId ?? null,
    input.chatId ?? null,
    input.kind,
    input.category ?? null,
    input.key ?? null,
    input.content,
    source,
    confidence,
    importance,
    pinnedInt,
    embeddingToBuffer(emb),
    metadataJson,
    now,
    now,
  )
  invalidateIdfCache()
  const row = db.prepare(`SELECT * FROM memory_items WHERE id = ?`).get(id) as Record<string, unknown>
  return rowToItem(row)
}

// ─── SEARCH (гибридный скоринг) ──────────────────────────────────────────────

/**
 * Семантический поиск по памяти. Гибридный скоринг:
 *   combo = tfidfCosine * 10 + importance * 2 + recencyBoost * 1 + pinned * 0.5
 *
 * TF-IDF cosine — основной сигнал (мгновенно). Importance + recency + pinned
 * — boost'ы для ранжирования. LIKE-fallback если embedding отсутствует.
 * После поиска инкрементит access_count + last_accessed_at (обратная связь).
 */
export async function searchMemory(params: SearchMemoryParams): Promise<SearchResult[]> {
  const db = getDB()
  const limit = params.limit ?? 8
  const minScore = params.minScore ?? 0.01

  // ── Scope filter ──
  let scopeWhere: string
  const scopeArgs: unknown[] = []
  if (params.scope === 'global') {
    scopeWhere = `scope = 'global'`
  } else if (params.scope === 'project' && params.projectId) {
    scopeWhere = `scope = 'project' AND project_id = ?`
    scopeArgs.push(params.projectId)
  } else if (params.scope === 'chat' && params.projectId) {
    // 'chat' трактуем как project+chat — но для простоты ищем в project scope
    scopeWhere = `scope = 'project' AND project_id = ?`
    scopeArgs.push(params.projectId)
  } else {
    // 'all' (default): global + текущий проект
    scopeWhere = `(scope = 'global' OR (scope = 'project' AND project_id = ?))`
    scopeArgs.push(params.projectId ?? '__none__')
  }

  // ── Kind filter ──
  let kindWhere = ''
  const kindArgs: unknown[] = []
  if (params.kind) {
    kindWhere = `AND kind = ?`
    kindArgs.push(params.kind)
  }

  // Берём top-200 по importance (чтобы не гонять cosine по всей базе)
  const rows = db.prepare(
    `SELECT * FROM memory_items WHERE ${scopeWhere} ${kindWhere}
     ORDER BY importance DESC, updated_at DESC LIMIT 200`
  ).all(...scopeArgs, ...kindArgs) as Record<string, unknown>[]

  if (rows.length === 0) return []

  // ── Embed query ──
  let queryEmb: Embedding | null = null
  try { queryEmb = await embedText(params.query) } catch { /* skip */ }

  // ── Score каждой записи ──
  const now = Date.now()
  const scored: Array<{ item: MemoryItem; score: number }> = []

  for (const row of rows) {
    let tfidfCos = 0

    if (queryEmb && row.embedding) {
      try {
        const itemEmb = bufferToEmbedding(row.embedding as Buffer)
        tfidfCos = cosineSimilarity(queryEmb, itemEmb)
      } catch { /* skip */ }
    }

    // LIKE-fallback если embedding отсутствует или cosine=0
    if (tfidfCos === 0) {
      const contentLower = (row.content as string).toLowerCase()
      const queryLower = params.query.toLowerCase()
      if (contentLower.includes(queryLower)) {
        tfidfCos = 0.3 // базовый score за substring match
      }
    }

    const importance = (row.importance as number) ?? 0.5
    const lastAccessed = row.last_accessed_at as number | null
    // Recency boost: 1.0 если доступалась только что, 0.0 если >30 дней
    const recencyBoost = lastAccessed
      ? Math.max(0, 1 - (now - lastAccessed) / (30 * 24 * 60 * 60 * 1000))
      : 0
    const pinnedBoost = (row.pinned as number) ? 0.5 : 0

    const combo = tfidfCos * 10 + importance * 2 + recencyBoost * 1 + pinnedBoost
    if (combo < minScore) continue

    scored.push({ item: rowToItem(row), score: combo })
  }

  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, limit)

  // ── Touch access_count + last_accessed_at ──
  if (top.length > 0) {
    const touch = db.prepare(
      `UPDATE memory_items SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`
    )
    const touchAll = db.transaction((items: typeof top) => {
      for (const t of items) touch.run(now, t.item.id)
    })
    touchAll(top)
  }

  return top
}

// ─── MULTI-SOURCE SEARCH (recall_memory) ─────────────────────────────────────

/**
 * Multi-source поиск для recall_memory. Параллельно ищет по 5 источникам:
 *   1. memory_items (TF-IDF + importance + recency) — через searchMemory
 *   2. messages (FTS5 trigram + bm25)               — через searchMessagesFTS
 *   3. chat_summaries (LIKE + recency)              — через searchChatSummaries
 *   4. agent_logs (LIKE, recent 14d)                — через searchAgentLogs
 *   5. pinned_messages (FTS5 + boost)               — через searchPinnedMessages
 *
 * Каждый источник даёт top-3, merge по normalized score, общий top-15.
 * Scope-логика:
 *   - memory_items: global ВСЕГДА + project если есть projectId
 *   - chat-источники: project_id = projectId ИЛИ IS NULL если нет projectId
 *
 * Параметр sources позволяет сузить поиск (например только memory + messages).
 * Default: 'all' (все 5 источников).
 */
export async function searchAllSources(params: SearchMemoryParams): Promise<MultiSourceResult[]> {
  const sources = params.sources ?? 'all'
  const allSources: SearchSourceName[] = sources === 'all'
    ? ['memory', 'messages', 'summaries', 'agent_logs', 'pinned']
    : (sources as SearchSourceName[])

  const perSourceLimit = 5
  const totalLimit = params.limit ?? 20

  // Запускаем все источники параллельно. memory_items — async (TF-IDF embedding),
  // остальные — sync (FTS5/LIKE). Оборачиваем в Promise.all для единообразия.
  const tasks: Promise<MultiSourceResult[]>[] = []

  if (allSources.includes('memory')) {
    tasks.push(
      (async () => {
        const results = await searchMemory({
          query: params.query,
          kind: params.kind,
          scope: params.scope,
          projectId: params.projectId,
          limit: perSourceLimit,
          minScore: params.minScore,
        })
        // Нормализуем score memory_items в 0..1.
        // searchMemory возвращает combo = tfidfCos*10 + importance*2 + recency + pinned,
        // типичные значения 0.5..15. Делим на 15 и clamp.
        return results.map(r => ({
          source: 'memory' as const,
          content: r.item.content,
          score: Math.max(0, Math.min(1, r.score / 15)),
          item: r.item,
        }))
      })()
    )
  }

  if (allSources.includes('messages')) {
    tasks.push(
      Promise.resolve(
        searchMessagesFTS(params.query, params.projectId, perSourceLimit)
          .map(r => ({ ...r, source: r.source as 'messages' }))
      )
    )
  }

  if (allSources.includes('summaries')) {
    tasks.push(
      Promise.resolve(
        searchChatSummaries(params.query, params.projectId, perSourceLimit)
          .map(r => ({ ...r, source: r.source as 'summaries' }))
      )
    )
  }

  if (allSources.includes('agent_logs')) {
    tasks.push(
      Promise.resolve(
        searchAgentLogs(params.query, params.projectId, perSourceLimit)
          .map(r => ({ ...r, source: r.source as 'agent_logs' }))
      )
    )
  }

  if (allSources.includes('pinned')) {
    tasks.push(
      Promise.resolve(
        searchPinnedMessages(params.query, params.projectId, perSourceLimit)
          .map(r => ({ ...r, source: r.source as 'pinned' }))
      )
    )
  }

  const perSourceResults = await Promise.all(tasks)

  // Merge all results, sort by score desc, take top-N
  const merged: MultiSourceResult[] = []
  for (const results of perSourceResults) {
    merged.push(...results)
  }
  merged.sort((a, b) => b.score - a.score)

  return merged.slice(0, totalLimit)
}

/**
 * Компактная сводка памяти для системного промпта (~400 токенов).
 * Заменяет getAllMemoriesForContext() из MemoryEngine.ts.
 *
 *   - top-8 global user_fact (по importance × confidence × recency)
 *   - top-8 project_decision для текущего проекта (если есть)
 *
 * Бюджет токенов вместо дампа всей базы — масштабируется.
 */
export function buildCuratedSummary(projectId?: string): string {
  const db = getDB()
  const lines: string[] = []

  // ── Global user_facts ──
  const globalFacts = db.prepare(
    `SELECT * FROM memory_items
     WHERE scope = 'global' AND kind = 'user_fact'
     ORDER BY importance DESC, confidence DESC, updated_at DESC LIMIT 8`
  ).all() as Record<string, unknown>[]

  if (globalFacts.length > 0) {
    lines.push('[Память о пользователе]')
    const labels: Record<string, string> = {
      personal: 'Личное',
      work: 'Работа',
      preferences: 'Предпочтения',
      projects: 'Проекты',
      facts: 'Факты',
    }
    const grouped: Record<string, string[]> = {}
    for (const f of globalFacts) {
      const cat = (f.category as string) || 'facts'
      if (!grouped[cat]) grouped[cat] = []
      const title = (f.title as string) || (f.content as string)
      grouped[cat].push(title)
    }
    for (const [cat, items] of Object.entries(grouped)) {
      const label = labels[cat] || cat
      lines.push(`${label}: ${items.join('; ')}`)
    }
  }

  // ── Project decisions ──
  if (projectId) {
    const decisions = db.prepare(
      `SELECT * FROM memory_items
       WHERE scope = 'project' AND project_id = ? AND kind = 'project_decision'
       ORDER BY importance DESC, updated_at DESC LIMIT 8`
    ).all(projectId) as Record<string, unknown>[]

    if (decisions.length > 0) {
      if (lines.length > 0) lines.push('')
      lines.push('[Решения проекта]')
      for (const d of decisions) {
        const title = (d.title as string) || (d.content as string)
        lines.push(`- ${title}`)
      }
    }
  }

  return lines.join('\n')
}

// ─── LIST / GET / DELETE / PIN ───────────────────────────────────────────────

export function getMemoryItem(id: string): MemoryItem | null {
  const row = getDB().prepare(`SELECT * FROM memory_items WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  return row ? rowToItem(row) : null
}

export function listMemoryItems(filter: ListMemoryFilter = {}): MemoryItem[] {
  const db = getDB()
  const where: string[] = []
  const args: unknown[] = []

  if (filter.scope) { where.push(`scope = ?`); args.push(filter.scope) }
  if (filter.kind) { where.push(`kind = ?`); args.push(filter.kind) }
  if (filter.projectId) { where.push(`project_id = ?`); args.push(filter.projectId) }
  if (filter.category) { where.push(`category = ?`); args.push(filter.category) }
  if (filter.search) {
    where.push(`(content LIKE ? OR key LIKE ?)`)
    const q = `%${filter.search}%`
    args.push(q, q)
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const limit = filter.limit ?? 200
  const offset = filter.offset ?? 0

  const rows = db.prepare(
    `SELECT * FROM memory_items ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
  ).all(...args, limit, offset) as Record<string, unknown>[]

  return rows.map(rowToItem)
}

export function deleteMemoryItem(id: string): boolean {
  const result = getDB().prepare(`DELETE FROM memory_items WHERE id = ?`).run(id)
  if (result.changes > 0) invalidateIdfCache()
  return result.changes > 0
}

export function pinMemoryItem(id: string, pinned: boolean): boolean {
  const result = getDB().prepare(`UPDATE memory_items SET pinned = ? WHERE id = ?`).run(pinned ? 1 : 0, id)
  return result.changes > 0
}

export function updateMemoryItemImportance(id: string, importance: number): boolean {
  const clamped = Math.max(0, Math.min(1, importance))
  const result = getDB().prepare(`UPDATE memory_items SET importance = ? WHERE id = ?`).run(clamped, id)
  return result.changes > 0
}

// ─── FORGET POLICY ───────────────────────────────────────────────────────────

/**
 * Decay prune — удаляет низко-important неиспользуемые записи.
 * Защищены: pinned=1, source='user_explicit'.
 *
 * Критерии удаления:
 *   - pinned = 0
 *   - source != 'user_explicit'
 *   - importance < minImportance
 *   - access_count = 0 (никогда не искалась)
 *   - last_accessed_at < cutoff ИЛИ NULL
 *   - created_at < cutoff (не свежая)
 *
 * Возвращает кол-во удалённых записей. Вызывать раз в сутки при старте app.
 */
export function decayPrune(maxAgeDays = 30, minImportance = 0.2): number {
  const db = getDB()
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  const result = db.prepare(
    `DELETE FROM memory_items
     WHERE pinned = 0
       AND source != 'user_explicit'
       AND importance < ?
       AND access_count = 0
       AND (last_accessed_at IS NULL OR last_accessed_at < ?)
       AND created_at < ?`
  ).run(minImportance, cutoff, cutoff)
  if (result.changes > 0) invalidateIdfCache()
  return result.changes
}

// ─── FEEDBACK LOOP: usage-based importance ───────────────────────────────────

/**
 * Feedback loop: bump access_count + importance для memory_items, которые
 * попали в результаты recall_memory. Часто вспоминаемые факты становятся
 * "неприкосновенными" (decayPrune защищает access_count > 0).
 *
 * - access_count += 1
 * - last_accessed_at = now
 * - importance = min(1.0, importance + 0.05) — плавный boost
 *
 * Вызывается из recall_memory handler после searchAllSources.
 * Non-fatal: ошибки не блокируют recall.
 */
export function bumpMemoryHit(ids: string[]): number {
  if (!ids.length) return 0
  const db = getDB()
  const now = Date.now()
  const stmt = db.prepare(
    `UPDATE memory_items
     SET access_count = access_count + 1,
         last_accessed_at = ?,
         importance = MIN(1.0, importance + 0.05)
     WHERE id = ?`
  )
  let bumped = 0
  const tx = db.transaction(() => {
    for (const id of ids) {
      const r = stmt.run(now, id)
      if (r.changes > 0) bumped++
    }
  })
  tx()
  return bumped
}

// ─── СТАТИСТИКА ──────────────────────────────────────────────────────────────

export function getMemoryStats(): {
  total: number
  byScope: Record<string, number>
  byKind: Record<string, number>
  bySource: Record<string, number>
} {
  const db = getDB()
  const total = (db.prepare(`SELECT COUNT(*) as c FROM memory_items`).get() as { c: number }).c
  const byScopeRows = db.prepare(`SELECT scope, COUNT(*) as c FROM memory_items GROUP BY scope`).all() as Array<{ scope: string; c: number }>
  const byKindRows = db.prepare(`SELECT kind, COUNT(*) as c FROM memory_items GROUP BY kind`).all() as Array<{ kind: string; c: number }>
  const bySourceRows = db.prepare(`SELECT source, COUNT(*) as c FROM memory_items GROUP BY source`).all() as Array<{ source: string; c: number }>
  return {
    total,
    byScope: Object.fromEntries(byScopeRows.map(r => [r.scope, r.c])),
    byKind: Object.fromEntries(byKindRows.map(r => [r.kind, r.c])),
    bySource: Object.fromEntries(bySourceRows.map(r => [r.source, r.c])),
  }
}

/**
 * Статистика по проекту — для системного промпта (агент видит сколько у него
 * памяти по проекту и глобально). Возвращает счётчики по scope/kind/category.
 */
export function getMemoryStatsForProject(projectId?: string): {
  globalCount: number
  projectCount: number
  globalByKind: Record<string, number>
  projectByKind: Record<string, number>
  byCategory: Record<string, number>
} {
  const db = getDB()
  const globalCount = (db.prepare(`SELECT COUNT(*) as c FROM memory_items WHERE scope = 'global'`).get() as { c: number }).c
  const projectCount = projectId
    ? (db.prepare(`SELECT COUNT(*) as c FROM memory_items WHERE scope = 'project' AND project_id = ?`).get(projectId) as { c: number }).c
    : 0
  const globalByKindRows = db.prepare(`SELECT kind, COUNT(*) as c FROM memory_items WHERE scope = 'global' GROUP BY kind`).all() as Array<{ kind: string; c: number }>
  // Bug 1: was `.get(projectId)` — get() returns a single row (object), not
  // an array, so `.map` below threw "(projectByKindRows || []).map is not a
  // function" whenever projectId was set. Must be `.all(projectId)`.
  const projectByKindRows = projectId
    ? (db.prepare(`SELECT kind, COUNT(*) as c FROM memory_items WHERE scope = 'project' AND project_id = ? GROUP BY kind`).all(projectId) as Array<{ kind: string; c: number }>)
    : []
  // Bug 2: the placeholder `?` only appears in SQL when projectId is set,
  // but `.all(projectId)` always passed projectId (even undefined) →
  // better-sqlite3 threw "Too many parameter values were provided" when
  // projectId was undefined. Build the statement conditionally and pass
  // params only when needed.
  const byCategoryStmt = projectId
    ? db.prepare(
        `SELECT COALESCE(category, 'uncategorized') as cat, COUNT(*) as c FROM memory_items
         WHERE scope = 'global' OR (scope = 'project' AND project_id = ?)
         GROUP BY cat ORDER BY c DESC`
      )
    : db.prepare(
        `SELECT COALESCE(category, 'uncategorized') as cat, COUNT(*) as c FROM memory_items
         WHERE scope = 'global'
         GROUP BY cat ORDER BY c DESC`
      )
  const byCategoryRows = (projectId ? byCategoryStmt.all(projectId) : byCategoryStmt.all()) as Array<{ cat: string; c: number }>
  return {
    globalCount,
    projectCount,
    globalByKind: Object.fromEntries(globalByKindRows.map(r => [r.kind, r.c])),
    projectByKind: Object.fromEntries((projectByKindRows || []).map(r => [r.kind, r.c])),
    byCategory: Object.fromEntries(byCategoryRows.map(r => [r.cat, r.c])),
  }
}

/**
 * Реиндекс всех embeddings (после переключения TF-IDF ↔ neural).
 * Дорого — O(N) embedding calls. Вызывать из UI по кнопке.
 */
export async function reindexAllEmbeddings(onProgress?: (done: number, total: number) => void): Promise<number> {
  const db = getDB()
  const rows = db.prepare(`SELECT id, content FROM memory_items`).all() as { id: string; content: string }[]
  let done = 0
  for (const row of rows) {
    try {
      const emb = await embedText(row.content)
      db.prepare(`UPDATE memory_items SET embedding = ? WHERE id = ?`).run(embeddingToBuffer(emb), row.id)
    } catch { /* skip */ }
    done++
    onProgress?.(done, rows.length)
  }
  invalidateIdfCache()
  return rows.length
}

// ─── ДИНАМИЧЕСКИЕ КАТЕГОРИИ ──────────────────────────────────────────────────

export interface MemoryCategory {
  id: string
  name: string         // машинное имя (lowercase)
  label: string        // человекочитаемое
  icon: string | null  // имя иконки из AppIcon
  color: string | null // hex
  scope: MemoryScope
  projectId: string | null
  kind: MemoryKind | null // фильтр (null = любой)
  createdAt: number
}

/** Builtin категории — всегда доступны, не хранятся в БД. */
export const BUILTIN_CATEGORIES: MemoryCategory[] = [
  { id: 'builtin-personal', name: 'personal', label: 'Личное', icon: 'user', color: null, scope: 'global', projectId: null, kind: 'user_fact', createdAt: 0 },
  { id: 'builtin-work', name: 'work', label: 'Работа', icon: 'briefcase', color: null, scope: 'global', projectId: null, kind: 'user_fact', createdAt: 0 },
  { id: 'builtin-preferences', name: 'preferences', label: 'Предпочтения', icon: 'sparkles', color: null, scope: 'global', projectId: null, kind: 'user_fact', createdAt: 0 },
  { id: 'builtin-projects', name: 'projects', label: 'Проекты', icon: 'folder', color: null, scope: 'global', projectId: null, kind: 'user_fact', createdAt: 0 },
  { id: 'builtin-facts', name: 'facts', label: 'Факты', icon: 'pin', color: null, scope: 'global', projectId: null, kind: 'user_fact', createdAt: 0 },
]

export function listMemoryCategories(projectId?: string): MemoryCategory[] {
  const db = getDB()
  // Builtin + кастомные (global + project-specific если projectId задан)
  const custom = projectId
    ? db.prepare(`SELECT * FROM memory_categories WHERE scope = 'global' OR (scope = 'project' AND project_id = ?) ORDER BY created_at`).all(projectId) as Record<string, unknown>[]
    : db.prepare(`SELECT * FROM memory_categories WHERE scope = 'global' ORDER BY created_at`).all() as Record<string, unknown>[]
  const customMapped = custom.map(r => ({
    id: r.id as string,
    name: r.name as string,
    label: r.label as string,
    icon: (r.icon as string | null) ?? null,
    color: (r.color as string | null) ?? null,
    scope: r.scope as MemoryScope,
    projectId: (r.project_id as string | null) ?? null,
    kind: (r.kind as MemoryKind | null) ?? null,
    createdAt: r.created_at as number,
  }))
  return [...BUILTIN_CATEGORIES, ...customMapped]
}

export function createMemoryCategory(input: {
  name: string
  label: string
  icon?: string
  color?: string
  scope?: MemoryScope
  projectId?: string
  kind?: MemoryKind
}): MemoryCategory {
  const db = getDB()
  const id = uuid()
  const now = Date.now()
  const scope: MemoryScope = input.scope ?? (input.projectId ? 'project' : 'global')
  const name = input.name.toLowerCase().replace(/[^a-zа-я0-9_]/gi, '_')
  db.prepare(
    `INSERT INTO memory_categories (id, name, label, icon, color, scope, project_id, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, input.label, input.icon ?? null, input.color ?? null, scope, input.projectId ?? null, input.kind ?? null, now)
  return { id, name, label: input.label, icon: input.icon ?? null, color: input.color ?? null, scope, projectId: input.projectId ?? null, kind: input.kind ?? null, createdAt: now }
}

export function deleteMemoryCategory(id: string): boolean {
  // Builtin нельзя удалить
  if (id.startsWith('builtin-')) return false
  const result = getDB().prepare(`DELETE FROM memory_categories WHERE id = ?`).run(id)
  return result.changes > 0
}
