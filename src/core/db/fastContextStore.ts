import { getDB } from './handle'

// === FAST CONTEXT INDEX ===

export interface FastContextEntry {
  projectId: string
  filePath: string
  lang: string | null
  symbolsJson: string | null
  mtime: number
  size: number
  rankedScore: number
  updatedAt: number
}

/** Получить все записи индекса fast context для проекта. */
export function getFastContextEntries(projectId: string): FastContextEntry[] {
  return getDB().prepare(`
    SELECT project_id as projectId, file_path as filePath, lang, symbols_json as symbolsJson,
           mtime, size, ranked_score as rankedScore, updated_at as updatedAt
    FROM fast_context_index
    WHERE project_id = ?
    ORDER BY ranked_score DESC
  `).all(projectId) as FastContextEntry[]
}

/** Получить одну запись (для проверки инвалидации по mtime+size). */
export function getFastContextEntry(projectId: string, filePath: string): FastContextEntry | null {
  return getDB().prepare(`
    SELECT project_id as projectId, file_path as filePath, lang, symbols_json as symbolsJson,
           mtime, size, ranked_score as rankedScore, updated_at as updatedAt
    FROM fast_context_index
    WHERE project_id = ? AND file_path = ?
  `).get(projectId, filePath) as FastContextEntry | null
}

/** Upsert записи индекса. symbolsJson — JSON-строка с определениями/ссылками символов. */
export function upsertFastContextEntry(
  projectId: string,
  filePath: string,
  lang: string | null,
  symbolsJson: string | null,
  mtime: number,
  size: number,
  rankedScore = 0,
): void {
  getDB().prepare(`
    INSERT INTO fast_context_index (project_id, file_path, lang, symbols_json, mtime, size, ranked_score, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, file_path) DO UPDATE SET
      lang = excluded.lang,
      symbols_json = excluded.symbols_json,
      mtime = excluded.mtime,
      size = excluded.size,
      ranked_score = excluded.ranked_score,
      updated_at = excluded.updated_at
  `).run(projectId, filePath, lang, symbolsJson, mtime, size, rankedScore, Date.now())
}

/** Обновить только rankedScore (после graph ranking пересчёта). */
export function updateFastContextScores(projectId: string, scores: Array<{ filePath: string; rankedScore: number }>): void {
  const db = getDB()
  const stmt = db.prepare(`UPDATE fast_context_index SET ranked_score = ? WHERE project_id = ? AND file_path = ?`)
  const tx = db.transaction((rows: Array<{ filePath: string; rankedScore: number }>) => {
    for (const r of rows) stmt.run(r.rankedScore, projectId, r.filePath)
  })
  tx(scores)
}

/** Удалить одну запись (файл удалён из проекта). */
export function deleteFastContextEntry(projectId: string, filePath: string): void {
  getDB().prepare(`DELETE FROM fast_context_index WHERE project_id = ? AND file_path = ?`).run(projectId, filePath)
}

/** Очистить весь индекс проекта (удаление проекта / reindex). */
export function clearFastContextIndex(projectId: string): void {
  getDB().prepare(`DELETE FROM fast_context_index WHERE project_id = ?`).run(projectId)
}

/** Количество файлов в индексе (для статистики в UI). */
export function getFastContextIndexCount(projectId: string): number {
  const r = getDB().prepare(`SELECT COUNT(*) as n FROM fast_context_index WHERE project_id = ?`).get(projectId) as { n: number }
  return r.n
}

// === FAST CONTEXT INDEX HISTORY ===

export interface FastContextIndexHistoryEntry {
  id: number
  projectId: string
  eventType: string       // 'full' | 'incremental' | 'manual' | 'clear'
  filesCount: number
  filesChanged: number
  durationMs: number
  createdAt: number
}

/** Добавить событие в историю обновлений индекса. */
export function addIndexHistoryEvent(
  projectId: string,
  eventType: string,
  filesCount: number,
  filesChanged: number,
  durationMs: number,
): void {
  getDB().prepare(`
    INSERT INTO fast_context_index_history (project_id, event_type, files_count, files_changed, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(projectId, eventType, filesCount, filesChanged, durationMs, Date.now())
}

/** Получить последние N событий истории для проекта (по умолчанию 50). */
export function getIndexHistory(projectId: string, limit = 50): FastContextIndexHistoryEntry[] {
  return getDB().prepare(`
    SELECT id, project_id as projectId, event_type as eventType,
           files_count as filesCount, files_changed as filesChanged,
           duration_ms as durationMs, created_at as createdAt
    FROM fast_context_index_history
    WHERE project_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(projectId, limit) as FastContextIndexHistoryEntry[]
}

/** Удалить старые события истории, оставив только последние `keep`. */
export function pruneIndexHistory(projectId: string, keep = 50): void {
  getDB().prepare(`
    DELETE FROM fast_context_index_history
    WHERE project_id = ? AND id NOT IN (
      SELECT id FROM fast_context_index_history
      WHERE project_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    )
  `).run(projectId, projectId, keep)
}

// === RELEVANCE BOOST (relevance feedback) ===
// Когда AI читает файл (read_file) после get_fast_context — инкрементим boost.
// В buildRepoMapSlice boost добавляется к combo score. Decay при каждом reindex.

/** Инкремент relevance_boost для файла (вызывается когда AI читает файл). */
export function bumpRelevanceBoost(projectId: string, filePath: string, amount = 1): void {
  getDB().prepare(`
    UPDATE fast_context_index
    SET relevance_boost = relevance_boost + ?
    WHERE project_id = ? AND file_path = ?
  `).run(amount, projectId, filePath)
}

/** Применить decay (умножить на 0.9) ко всем relevance_boost проекта. */
export function decayRelevanceBoost(projectId: string, factor = 0.9): void {
  getDB().prepare(`
    UPDATE fast_context_index
    SET relevance_boost = relevance_boost * ?
    WHERE project_id = ?
  `).run(factor, projectId)
}

/** Получить последние N изменённых файлов (по updated_at). */
export function getRecentFastContextFiles(projectId: string, limit = 10): Array<{
  filePath: string
  lang: string | null
  rankedScore: number
  updatedAt: number
}> {
  return getDB().prepare(`
    SELECT file_path as filePath, lang, ranked_score as rankedScore, updated_at as updatedAt
    FROM fast_context_index
    WHERE project_id = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(projectId, limit) as Array<{ filePath: string; lang: string | null; rankedScore: number; updatedAt: number }>
}

/** Получить топ-N файлов по rankedScore (самые важные по PageRank). */
export function getTopFastContextFiles(projectId: string, limit = 10): Array<{
  filePath: string
  lang: string | null
  rankedScore: number
  relevanceBoost: number
  updatedAt: number
}> {
  return getDB().prepare(`
    SELECT file_path as filePath, lang, ranked_score as rankedScore,
           relevance_boost as relevanceBoost, updated_at as updatedAt
    FROM fast_context_index
    WHERE project_id = ?
    ORDER BY ranked_score DESC
    LIMIT ?
  `).all(projectId, limit) as Array<{ filePath: string; lang: string | null; rankedScore: number; relevanceBoost: number; updatedAt: number }>
}

/** Последний timestamp обновления индекса (MAX(updated_at)). */
export function getFastContextLastUpdated(projectId: string): number | null {
  const r = getDB().prepare(`SELECT MAX(updated_at) as m FROM fast_context_index WHERE project_id = ?`).get(projectId) as { m: number | null }
  return r.m ?? null
}

// === RUST SIDECAR INDEX (read-only mirrors of fast_context_sidecar_index) ===
// The Rust sidecar owns this table; main reads it for UI status only.

function sidecarTableAvailable(): boolean {
  try {
    const row = getDB().prepare(
      `SELECT 1 as ok FROM sqlite_master WHERE type = 'table' AND name = 'fast_context_sidecar_index'`,
    ).get() as { ok: number } | undefined
    return row?.ok === 1
  } catch {
    return false
  }
}

export function getSidecarIndexCount(projectId: string): number {
  if (!sidecarTableAvailable()) return 0
  const r = getDB().prepare(`SELECT COUNT(*) as n FROM fast_context_sidecar_index WHERE project_id = ?`).get(projectId) as { n: number }
  return r.n
}

export function getSidecarLastUpdated(projectId: string): number | null {
  if (!sidecarTableAvailable()) return null
  const r = getDB().prepare(`SELECT MAX(updated_at) as m FROM fast_context_sidecar_index WHERE project_id = ?`).get(projectId) as { m: number | null }
  return r.m ?? null
}

/** Последние проиндексированные Rust-индексом файлы. */
export function getRecentSidecarFiles(projectId: string, limit = 10): Array<{
  filePath: string
  lang: string | null
  rankedScore: number
  updatedAt: number
}> {
  if (!sidecarTableAvailable()) return []
  return getDB().prepare(`
    SELECT file_path as filePath, lang, ranked_score as rankedScore, updated_at as updatedAt
    FROM fast_context_sidecar_index
    WHERE project_id = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(projectId, limit) as Array<{ filePath: string; lang: string | null; rankedScore: number; updatedAt: number }>
}

/** Самые «важные» файлы по версии Rust-индекса (источники приоритетнее артефактов). */
export function getTopSidecarFiles(projectId: string, limit = 10): Array<{
  filePath: string
  lang: string | null
  rankedScore: number
  relevanceBoost: number
  updatedAt: number
}> {
  if (!sidecarTableAvailable()) return []
  return getDB().prepare(`
    SELECT file_path as filePath, lang, ranked_score as rankedScore,
           relevance_boost as relevanceBoost, updated_at as updatedAt
    FROM fast_context_sidecar_index
    WHERE project_id = ?
    ORDER BY CASE WHEN lang IN ('json','yaml','toml','markdown') THEN 1 ELSE 0 END, ranked_score DESC
    LIMIT ?
  `).all(projectId, limit) as Array<{ filePath: string; lang: string | null; rankedScore: number; relevanceBoost: number; updatedAt: number }>
}
