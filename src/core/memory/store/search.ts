/**
 * search.ts — поиск по памяти (multi-source).
 *
 * Содержит: searchMemory (гибридный скоринг), searchAllSources (multi-source
 * для recall_memory), buildCuratedSummary (сводка для системного промпта).
 */

import { getDB } from '../../db/handle'
import { cosineSimilarity, bufferToEmbedding } from '../../context/embeddings'
import {
  searchMessagesFTS,
  searchChatSummaries,
  searchAgentLogs,
  searchPinnedMessages,
  type SearchSourceName,
} from '../chatSearch'
import {
  embedText,
  rowToItem,
  type Embedding,
  type MemoryItem,
  type SearchMemoryParams,
  type SearchResult,
  type MultiSourceResult,
} from './_shared'

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

  // Берём top-500 по importance (чтобы не гонять cosine по всей базе).
  // LIKE pre-filter убран — он исключал семантически релевантные записи,
  // не содержащие точной подстроки запроса. TF-IDF cosine + LIKE boost
  // в скоринге ниже обеспечивают ранжирование без потери recall.
  const rows = db.prepare(
    `SELECT * FROM memory_items WHERE ${scopeWhere} ${kindWhere}
     ORDER BY importance DESC, updated_at DESC LIMIT 500`
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

    // Substring match check — используется для TF-IDF fallback и LIKE boost.
    // Проверяем и content, и title.
    const contentLower = (row.content as string).toLowerCase()
    const titleLower = ((row.title as string) ?? '').toLowerCase()
    const queryLower = params.query.toLowerCase()
    const hasSubstring = queryLower.length > 0 &&
      (contentLower.includes(queryLower) || titleLower.includes(queryLower))

    // LIKE-fallback если embedding отсутствует или cosine=0
    if (tfidfCos === 0 && hasSubstring) {
      tfidfCos = 0.3 // базовый score за substring match
    }

    const importance = (row.importance as number) ?? 0.5
    const lastAccessed = row.last_accessed_at as number | null
    // Recency boost: 1.0 если доступалась только что, 0.0 если >30 дней
    const recencyBoost = lastAccessed
      ? Math.max(0, 1 - (now - lastAccessed) / (30 * 24 * 60 * 60 * 1000))
      : 0
    const pinnedBoost = (row.pinned as number) ? 0.5 : 0

    // Tuned: TF-IDF is the primary signal (×12), importance slightly reduced (×1.5)
    // so low-importance but relevant items surface. Recency boosted (×1.5).
    // LIKE boost (+1.0) — точное совпадение подстроки чуть повышает ранг,
    // но не исключает семантически релевантные записи без подстроки.
    const likeBoost = hasSubstring ? 1.0 : 0
    const combo = tfidfCos * 12 + importance * 1.5 + recencyBoost * 1.5 + pinnedBoost * 0.8 + likeBoost
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

  const crossProject = params.crossProject ?? false
  // When crossProject, chat sources search ALL projects (pass undefined projectId)
  const chatProjectId = crossProject ? undefined : params.projectId

  // Запускаем все источники параллельно. memory_items — async (TF-IDF embedding),
  // остальные — sync (FTS5/LIKE). Оборачиваем в Promise.all для единообразия.
  const tasks: Promise<MultiSourceResult[]>[] = []

  if (allSources.includes('memory')) {
    tasks.push(
      (async () => {
        const results = await searchMemory({
          query: params.query,
          kind: params.kind,
          scope: crossProject ? 'all' : params.scope,
          projectId: crossProject ? undefined : params.projectId,
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
        searchMessagesFTS(params.query, chatProjectId, perSourceLimit, crossProject)
          .map(r => ({ ...r, source: r.source as 'messages' }))
      )
    )
  }

  if (allSources.includes('summaries')) {
    tasks.push(
      Promise.resolve(
        searchChatSummaries(params.query, chatProjectId, perSourceLimit, crossProject)
          .map(r => ({ ...r, source: r.source as 'summaries' }))
      )
    )
  }

  if (allSources.includes('agent_logs')) {
    tasks.push(
      Promise.resolve(
        searchAgentLogs(params.query, chatProjectId, perSourceLimit, crossProject)
          .map(r => ({ ...r, source: r.source as 'agent_logs' }))
      )
    )
  }

  if (allSources.includes('pinned')) {
    tasks.push(
      Promise.resolve(
        searchPinnedMessages(params.query, chatProjectId, perSourceLimit, crossProject)
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

  // ── Project conventions ──
  if (projectId) {
    const conventions = db.prepare(
      `SELECT title, content FROM memory_items
       WHERE scope = 'project' AND project_id = ? AND kind = 'convention'
       ORDER BY importance DESC, updated_at DESC LIMIT 5`
    ).all(projectId) as Array<{ title: string; content: string }>

    if (conventions.length > 0) {
      if (lines.length > 0) lines.push('')
      lines.push('[Конвенции проекта]')
      for (const c of conventions) {
        lines.push(`- ${(c.title || c.content).slice(0, 120)}`)
      }
    }
  }

  // ── Recent conversations (task outcomes) ──
  if (projectId) {
    const conversations = db.prepare(
      `SELECT title, content FROM memory_items
       WHERE scope = 'project' AND project_id = ? AND kind = 'conversation'
       ORDER BY updated_at DESC LIMIT 3`
    ).all(projectId) as Array<{ title: string; content: string }>

    if (conversations.length > 0) {
      if (lines.length > 0) lines.push('')
      lines.push('[Итоги диалогов]')
      for (const c of conversations) {
        lines.push(`- ${(c.title || c.content).slice(0, 120)}`)
      }
    }
  }

  // ── Agent outcomes (lessons) ──
  if (projectId) {
    const outcomes = db.prepare(
      `SELECT title, content FROM memory_items
       WHERE scope = 'project' AND project_id = ? AND kind = 'agent_outcome'
       ORDER BY importance DESC, updated_at DESC LIMIT 3`
    ).all(projectId) as Array<{ title: string; content: string }>

    if (outcomes.length > 0) {
      if (lines.length > 0) lines.push('')
      lines.push('[Уроки]')
      for (const o of outcomes) {
        lines.push(`- ${(o.title || o.content).slice(0, 120)}`)
      }
    }
  }

  return lines.join('\n')
}
