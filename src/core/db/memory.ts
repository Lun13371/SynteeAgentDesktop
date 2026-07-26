import { v4 as uuid } from 'uuid'
import { getDB } from './handle'

// === MEMORY ===

export function saveMemory(category: string, key: string, value: string): void {
  const db = getDB()
  const now = Date.now()
  const existing = db.prepare('SELECT id FROM memory WHERE category = ? AND key = ?').get(category, key)
  if (existing) {
    db.prepare('UPDATE memory SET value = ?, updated_at = ? WHERE category = ? AND key = ?')
      .run(value, now, category, key)
  } else {
    db.prepare('INSERT INTO memory (id, category, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uuid(), category, key, value, now, now)
  }
}

export function getAllMemory(): Array<{ category: string; key: string; value: string }> {
  return getDB().prepare('SELECT category, key, value FROM memory ORDER BY category, updated_at DESC').all() as Array<{ category: string; key: string; value: string }>
}

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
