import { v4 as uuid } from 'uuid'
import { getDB } from './handle'

// === MEMORY ===
// ВНИМАНИЕ: saveMemory/getAllMemory удалены — были мёртвым кодом (0 callers).
// Унифицированная память теперь живёт в memory_items (см. MemoryStore.ts).
// Старая `memory` table оставлена в схеме до Фазы 2 (откат), данные
// мигрированы в memory_items функцией migrateLegacyMemoryToMemoryItems.

// === CLIPBOARD HISTORY ===

export function saveClipboard(content: string, contentType = 'text'): void {
  const db = getDB()
  // Не дублируем последнюю запись
  const last = db.prepare('SELECT content FROM clipboard_history ORDER BY created_at DESC LIMIT 1').get() as { content: string } | undefined
  if (last?.content === content) return

  db.prepare('INSERT INTO clipboard_history (id, content, content_type, created_at) VALUES (?, ?, ?, ?)')
    .run(uuid(), content, contentType, Date.now())

  // Оставляем только последние 500 записей
  db.prepare(`
    DELETE FROM clipboard_history WHERE id NOT IN (
      SELECT id FROM clipboard_history ORDER BY created_at DESC LIMIT 500
    )
  `).run()
}

export function getClipboardHistory(limit = 50): Array<{ content: string; contentType: string; createdAt: number }> {
  return getDB().prepare('SELECT content, content_type as contentType, created_at as createdAt FROM clipboard_history ORDER BY created_at DESC LIMIT ?').all(limit) as Array<{ content: string; contentType: string; createdAt: number }>
}

// === AGENT LOGS ===

export function logAgentAction(action: {
  chatId?: string; type: string; tool?: string
  args?: unknown; result?: string; error?: string
}): void {
  getDB().prepare(`
    INSERT INTO agent_logs (id, chat_id, type, tool, args, result, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuid(), action.chatId ?? null, action.type,
    action.tool ?? null,
    action.args ? JSON.stringify(action.args) : null,
    action.result ?? null,
    action.error ?? null,
    Date.now()
  )
}

export interface AgentLogEntry {
  id: string
  chatId: string | null
  type: string
  tool: string | null
  args: unknown
  result: string | null
  error: string | null
  createdAt: number
}

/**
 * Недавние agent_logs — сырьё для outcome-extraction (Фаза 4).
 * Возвращает записи по chatId (или все если chatId не задан), отсортированные
 * от новыхых к старым, с лимитом. args парсится из JSON.
 */
export function getRecentAgentLogs(chatId?: string, limit = 50): AgentLogEntry[] {
  const db = getDB()
  const rows = chatId
    ? db.prepare('SELECT * FROM agent_logs WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?').all(chatId, limit) as Array<Record<string, unknown>>
    : db.prepare('SELECT * FROM agent_logs ORDER BY created_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>
  return rows.map(r => {
    let args: unknown = null
    if (r.args && typeof r.args === 'string') {
      try { args = JSON.parse(r.args as string) } catch { /* skip */ }
    }
    return {
      id: r.id as string,
      chatId: (r.chat_id as string | null) ?? null,
      type: r.type as string,
      tool: (r.tool as string | null) ?? null,
      args,
      result: (r.result as string | null) ?? null,
      error: (r.error as string | null) ?? null,
      createdAt: r.created_at as number,
    }
  })
}

/**
 * Удаляет agent_logs старше maxAgeDays. Вызывать периодически чтобы
 * таблица не росла бесконечно. Возвращает кол-во удалённых записей.
 */
export function pruneOldAgentLogs(maxAgeDays = 14): number {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  const result = getDB().prepare('DELETE FROM agent_logs WHERE created_at < ?').run(cutoff)
  return result.changes
}

// === WORKING MEMORY ===

export function getWorkingMemory(chatId: string): string {
  const row = getDB().prepare('SELECT content FROM chat_working_memory WHERE chat_id = ?').get(chatId) as { content: string } | undefined
  return row?.content ?? ''
}

export function setWorkingMemory(chatId: string, content: string): void {
  getDB().prepare(`
    INSERT INTO chat_working_memory (chat_id, content, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
  `).run(chatId, content.slice(0, 8000), Date.now())  // hard cap 8000 символов ~4000 токенов
}

export function clearWorkingMemory(chatId: string): void {
  getDB().prepare('DELETE FROM chat_working_memory WHERE chat_id = ?').run(chatId)
}

export function getChatSummary(chatId: string): string {
  const row = getDB().prepare('SELECT content FROM chat_summaries WHERE chat_id = ?').get(chatId) as { content: string } | undefined
  return row?.content ?? ''
}

export function setChatSummary(chatId: string, content: string): void {
  getDB().prepare(`
    INSERT INTO chat_summaries (chat_id, content, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
  `).run(chatId, content.slice(0, 12000), Date.now())
}

export function clearChatSummary(chatId: string): void {
  getDB().prepare('DELETE FROM chat_summaries WHERE chat_id = ?').run(chatId)
}
