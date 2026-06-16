import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import type { Chat, Message } from '../../shared/types'
import { v4 as uuid } from 'uuid'

let db: Database.Database

export function getDB(): Database.Database {
  if (!db) throw new Error('DB not initialized')
  return db
}

export function initDB(): void {
  const userData = app.getPath('userData')
  mkdirSync(userData, { recursive: true })
  const dbPath = join(userData, 'syntee.db')

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  runMigrations()
}

function runMigrations(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL DEFAULT 'Новый чат',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      is_incognito INTEGER NOT NULL DEFAULT 0,
      is_pinned   INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      color       TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role        TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      is_pinned   INTEGER NOT NULL DEFAULT 0,
      model       TEXT,
      tool_steps  TEXT
    );

    CREATE TABLE IF NOT EXISTS memory (
      id          TEXT PRIMARY KEY,
      category    TEXT NOT NULL DEFAULT 'general',
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_logs (
      id          TEXT PRIMARY KEY,
      chat_id     TEXT,
      type        TEXT NOT NULL,
      tool        TEXT,
      args        TEXT,
      result      TEXT,
      error       TEXT,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clipboard_history (
      id          TEXT PRIMARY KEY,
      content     TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'text',
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pinned_messages (
      message_id  TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      pinned_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_working_memory (
      chat_id     TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      content     TEXT NOT NULL DEFAULT '',
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_summaries (
      chat_id     TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      content     TEXT NOT NULL DEFAULT '',
      updated_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_memory_category ON memory(category);
    CREATE INDEX IF NOT EXISTS idx_clipboard_created ON clipboard_history(created_at);
  `)

  // Миграция: добавляем tool_steps если колонки нет
  const cols = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[]
  if (!cols.find(c => c.name === 'tool_steps')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN tool_steps TEXT`).run()
  }
  if (!cols.find(c => c.name === 'thinking')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN thinking TEXT`).run()
  }
  if (!cols.find(c => c.name === 'thinking_ms')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN thinking_ms INTEGER`).run()
  }
  if (!cols.find(c => c.name === 'slash_command')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN slash_command TEXT`).run()
  }
  if (!cols.find(c => c.name === 'iterations')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN iterations TEXT`).run()
  }
  if (!cols.find(c => c.name === 'plan_data')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN plan_data TEXT`).run()
  }

  // Миграция: добавляем поля чатов
  const chatCols = db.prepare(`PRAGMA table_info(chats)`).all() as { name: string }[]
  if (!chatCols.find(c => c.name === 'is_pinned'))   db.prepare(`ALTER TABLE chats ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0`).run()
  if (!chatCols.find(c => c.name === 'is_archived')) db.prepare(`ALTER TABLE chats ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0`).run()
  if (!chatCols.find(c => c.name === 'color'))       db.prepare(`ALTER TABLE chats ADD COLUMN color TEXT`).run()
}

// === CHATS ===

export function createChat(isIncognito = false): Chat {
  const now = Date.now()
  const chat: Chat = {
    id: uuid(),
    title: 'Новый чат',
    createdAt: now,
    updatedAt: now,
    isIncognito: isIncognito ? 1 : 0,
    isPinned: 0,
    isArchived: 0,
  }
  db.prepare(`
    INSERT INTO chats (id, title, created_at, updated_at, is_incognito, is_pinned, is_archived)
    VALUES (?, ?, ?, ?, ?, 0, 0)
  `).run(chat.id, chat.title, chat.createdAt, chat.updatedAt, chat.isIncognito)
  return chat
}

export function getAllChats(): Chat[] {
  return db.prepare(`
    SELECT c.id, c.title, c.created_at as createdAt, c.updated_at as updatedAt,
           c.is_incognito as isIncognito,
           c.is_pinned as isPinned,
           c.is_archived as isArchived,
           c.color,
           (SELECT m.content FROM messages m WHERE m.chat_id = c.id AND m.role != 'system' ORDER BY m.created_at DESC LIMIT 1) as lastMessage,
           (SELECT COUNT(*) FROM messages WHERE chat_id = c.id) as messageCount
    FROM chats c WHERE c.is_incognito = 0
    ORDER BY c.is_pinned DESC, c.updated_at DESC
  `).all() as Chat[]
}

export function renameChat(id: string, title: string): void {
  db.prepare('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?')
    .run(title, Date.now(), id)
}

export function deleteChat(id: string): void {
  db.prepare('DELETE FROM chats WHERE id = ?').run(id)
}

export function archiveChat(id: string, archived: boolean): void {
  db.prepare('UPDATE chats SET is_archived = ? WHERE id = ?').run(archived ? 1 : 0, id)
}

export function pinChat(id: string, pinned: boolean): void {
  db.prepare('UPDATE chats SET is_pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
}

export function setChatColor(id: string, color: string | null): void {
  db.prepare('UPDATE chats SET color = ? WHERE id = ?').run(color, id)
}

export function duplicateChat(id: string): Chat | null {
  const src = db.prepare(`SELECT * FROM chats WHERE id = ?`).get(id) as Chat & { created_at: number; updated_at: number; is_incognito: number } | undefined
  if (!src) return null
  const newId = require('uuid').v4() as string
  const now = Date.now()
  db.prepare(`INSERT INTO chats (id, title, created_at, updated_at, is_incognito, is_pinned, is_archived, color) VALUES (?,?,?,?,?,0,0,?)`)
    .run(newId, src.title + ' (копия)', now, now, src.is_incognito ?? 0, (src as unknown as Record<string,unknown>).color ?? null)
  const msgs = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC').all(id) as (Message & { chat_id: string; created_at: number; is_pinned: number; tool_steps?: string })[]
  for (const m of msgs) {
    const mid = require('uuid').v4() as string
    db.prepare(`INSERT INTO messages (id, chat_id, role, content, created_at, is_pinned, model, tool_steps) VALUES (?,?,?,?,?,?,?,?)`)
      .run(mid, newId, m.role, m.content, m.created_at ?? m.createdAt, 0, m.model ?? null, m.tool_steps ?? null)
  }
  return getAllChats().find(c => c.id === newId) ?? null
}

export function exportChat(id: string, format: 'txt' | 'md'): string {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as { title: string } | undefined
  if (!chat) return ''
  const msgs = db.prepare('SELECT role, content, created_at FROM messages WHERE chat_id = ? ORDER BY created_at ASC').all(id) as { role: string; content: string; created_at: number }[]
  if (format === 'md') {
    return `# ${chat.title}\n\n` + msgs.map(m => {
      const time = new Date(m.created_at).toLocaleString('ru')
      const role = m.role === 'user' ? '**Вы**' : '**Ассистент**'
      return `${role} _(${time})_\n\n${m.content}`
    }).join('\n\n---\n\n')
  }
  return msgs.map(m => {
    const time = new Date(m.created_at).toLocaleString('ru')
    const role = m.role === 'user' ? 'Вы' : 'Ассистент'
    return `[${time}] ${role}:\n${m.content}`
  }).join('\n\n')
}

export function touchChat(id: string): void {
  db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(Date.now(), id)
}

// === MESSAGES ===

export function saveMessage(msg: Message): void {
  db.prepare(`
    INSERT OR REPLACE INTO messages (id, chat_id, role, content, created_at, is_pinned, model, tool_steps, thinking, thinking_ms, slash_command, iterations, plan_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    msg.id, msg.chatId, msg.role, msg.content, msg.createdAt, msg.isPinned, msg.model ?? null,
    msg.toolSteps ? JSON.stringify(msg.toolSteps) : null,
    msg.thinking ?? null, msg.thinkingMs ?? null,
    msg.slashCommand ? JSON.stringify(msg.slashCommand) : null,
    (msg as Message & { iterations?: unknown }).iterations ? JSON.stringify((msg as Message & { iterations?: unknown }).iterations) : null,
    msg.planData ? JSON.stringify(msg.planData) : null,
  )
  touchChat(msg.chatId)
}

export function getMessages(chatId: string): Message[] {
  const rows = db.prepare(`
    SELECT id, chat_id as chatId, role, content, created_at as createdAt, is_pinned as isPinned, model,
           tool_steps as toolStepsJson, thinking, thinking_ms as thinkingMs, slash_command as slashCommandJson,
           iterations as iterationsJson, plan_data as planDataJson
    FROM messages WHERE chat_id = ?
    ORDER BY created_at ASC
  `).all(chatId) as (Message & { toolStepsJson?: string; slashCommandJson?: string; iterationsJson?: string; planDataJson?: string })[]
  return rows.map(r => {
    const { toolStepsJson, slashCommandJson, iterationsJson, planDataJson, ...rest } = r
    return {
      ...rest,
      toolSteps: toolStepsJson ? JSON.parse(toolStepsJson) : undefined,
      slashCommand: slashCommandJson ? JSON.parse(slashCommandJson) : undefined,
      iterations: iterationsJson ? JSON.parse(iterationsJson) : undefined,
      planData: planDataJson ? JSON.parse(planDataJson) : undefined,
    }
  })
}

export function pinMessage(id: string): void {
  db.prepare('UPDATE messages SET is_pinned = 1 WHERE id = ?').run(id)
  db.prepare('INSERT OR IGNORE INTO pinned_messages (message_id, pinned_at) VALUES (?, ?)')
    .run(id, Date.now())
}

export function unpinMessage(id: string): void {
  db.prepare('UPDATE messages SET is_pinned = 0 WHERE id = ?').run(id)
  db.prepare('DELETE FROM pinned_messages WHERE message_id = ?').run(id)
}

// === MEMORY ===

export function saveMemory(category: string, key: string, value: string): void {
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
  return db.prepare('SELECT category, key, value FROM memory ORDER BY category, updated_at DESC').all() as Array<{ category: string; key: string; value: string }>
}

// === CLIPBOARD HISTORY ===

export function saveClipboard(content: string, contentType = 'text'): void {
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
  return db.prepare('SELECT content, content_type as contentType, created_at as createdAt FROM clipboard_history ORDER BY created_at DESC LIMIT ?').all(limit) as Array<{ content: string; contentType: string; createdAt: number }>
}

// === AGENT LOGS ===

export function logAgentAction(action: {
  chatId?: string; type: string; tool?: string
  args?: unknown; result?: string; error?: string
}): void {
  db.prepare(`
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
  const row = db.prepare('SELECT content FROM chat_working_memory WHERE chat_id = ?').get(chatId) as { content: string } | undefined
  return row?.content ?? ''
}

export function setWorkingMemory(chatId: string, content: string): void {
  db.prepare(`
    INSERT INTO chat_working_memory (chat_id, content, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
  `).run(chatId, content.slice(0, 4000), Date.now())  // hard cap 4000 символов ~2000 токенов
}

export function clearWorkingMemory(chatId: string): void {
  db.prepare('DELETE FROM chat_working_memory WHERE chat_id = ?').run(chatId)
}

export function getChatSummary(chatId: string): string {
  const row = db.prepare('SELECT content FROM chat_summaries WHERE chat_id = ?').get(chatId) as { content: string } | undefined
  return row?.content ?? ''
}

export function setChatSummary(chatId: string, content: string): void {
  db.prepare(`
    INSERT INTO chat_summaries (chat_id, content, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
  `).run(chatId, content.slice(0, 12000), Date.now())
}

export function clearChatSummary(chatId: string): void {
  db.prepare('DELETE FROM chat_summaries WHERE chat_id = ?').run(chatId)
}
