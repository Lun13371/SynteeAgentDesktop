import type { Message } from '../../shared/types'
import { getDB } from './handle'
import { touchChat } from './chats'

// === MESSAGES ===

export function saveMessage(msg: Message): void {
  getDB().prepare(`
    INSERT OR REPLACE INTO messages (id, chat_id, role, content, created_at, is_pinned, model, tool_steps, thinking, thinking_ms, slash_command, iterations, plan_data, todo, compact_summary, compact_stats)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    msg.id, msg.chatId, msg.role, msg.content, msg.createdAt, msg.isPinned, msg.model ?? null,
    msg.toolSteps ? JSON.stringify(msg.toolSteps) : null,
    msg.thinking ?? null, msg.thinkingMs ?? null,
    msg.slashCommand ? JSON.stringify(msg.slashCommand) : null,
    (msg as Message & { iterations?: unknown }).iterations ? JSON.stringify((msg as Message & { iterations?: unknown }).iterations) : null,
    msg.planData ? JSON.stringify(msg.planData) : null,
    msg.todo ? JSON.stringify(msg.todo) : null,
    msg.compactSummary ?? null,
    msg.compactStats ? JSON.stringify(msg.compactStats) : null,
  )
  touchChat(msg.chatId)
}

export function getMessages(chatId: string): Message[] {
  const rows = getDB().prepare(`
    SELECT id, chat_id as chatId, role, content, created_at as createdAt, is_pinned as isPinned, model,
           tool_steps as toolStepsJson, thinking, thinking_ms as thinkingMs, slash_command as slashCommandJson,
           iterations as iterationsJson, plan_data as planDataJson, todo as todoJson, compact_summary as compactSummary,
           compact_stats as compactStatsJson
    FROM messages WHERE chat_id = ?
    ORDER BY created_at ASC
  `).all(chatId) as (Message & { toolStepsJson?: string; slashCommandJson?: string; iterationsJson?: string; planDataJson?: string; todoJson?: string; compactStatsJson?: string })[]
  return rows.map(r => {
    const { toolStepsJson, slashCommandJson, iterationsJson, planDataJson, todoJson, compactStatsJson, ...rest } = r
    return {
      ...rest,
      toolSteps: toolStepsJson ? JSON.parse(toolStepsJson) : undefined,
      slashCommand: slashCommandJson ? JSON.parse(slashCommandJson) : undefined,
      iterations: iterationsJson ? JSON.parse(iterationsJson) : undefined,
      planData: planDataJson ? JSON.parse(planDataJson) : undefined,
      todo: todoJson ? JSON.parse(todoJson) : undefined,
      compactStats: compactStatsJson ? JSON.parse(compactStatsJson) : undefined,
    }
  })
}

export function pinMessage(id: string): void {
  const db = getDB()
  db.prepare('UPDATE messages SET is_pinned = 1 WHERE id = ?').run(id)
  db.prepare('INSERT OR IGNORE INTO pinned_messages (message_id, pinned_at) VALUES (?, ?)')
    .run(id, Date.now())
}

export function unpinMessage(id: string): void {
  const db = getDB()
  db.prepare('UPDATE messages SET is_pinned = 0 WHERE id = ?').run(id)
  db.prepare('DELETE FROM pinned_messages WHERE message_id = ?').run(id)
}

export function deleteMessageById(messageId: string): void {
  getDB().prepare(`DELETE FROM messages WHERE id = ?`).run(messageId)
}

/**
 * Удаляет все сообщения чата с created_at > порога (используется при rewind
 * для очистки откатнутых сообщений). Возвращает кол-во удалённых.
 */
export function deleteMessagesAfter(chatId: string, createdAt: number): number {
  const info = getDB().prepare(`DELETE FROM messages WHERE chat_id = ? AND created_at > ?`).run(chatId, createdAt)
  return info.changes
}

/**
 * Кол-во сообщений в чате (для snapshot'а context_snapshot).
 */
export function getMessageCount(chatId: string): number {
  const row = getDB().prepare(`SELECT COUNT(*) as cnt FROM messages WHERE chat_id = ?`).get(chatId) as { cnt: number }
  return row.cnt
}
