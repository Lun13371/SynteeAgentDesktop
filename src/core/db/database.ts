import Database = require('better-sqlite3')
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'

let db: Database.Database

export function getDB(): Database.Database {
  if (db) return db

  const userData = app.getPath('userData')
  mkdirSync(userData, { recursive: true })
  const dbPath = join(userData, 'syntee.db')

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  initSchema(db)
  return db
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL DEFAULT 'Новый чат',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      is_incognito INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role        TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      is_pinned   INTEGER NOT NULL DEFAULT 0,
      model       TEXT
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
      type        TEXT NOT NULL DEFAULT 'text',
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_memory_category ON memory(category);
    CREATE INDEX IF NOT EXISTS idx_agent_logs_chat ON agent_logs(chat_id);
  `)
}

// ─── CHATS ───────────────────────────────────────────────
export function createChat(id: string, incognito = false): void {
  const db = getDB()
  const now = Date.now()
  db.prepare(`
    INSERT INTO chats (id, title, created_at, updated_at, is_incognito)
    VALUES (?, 'Новый чат', ?, ?, ?)
  `).run(id, now, now, incognito ? 1 : 0)
}

export function getAllChats() {
  return getDB().prepare(`
    SELECT c.*, 
      (SELECT content FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
      (SELECT COUNT(*) FROM messages WHERE chat_id = c.id) as message_count
    FROM chats c
    WHERE c.is_incognito = 0
    ORDER BY c.updated_at DESC
  `).all()
}

export function renameChat(id: string, title: string): void {
  getDB().prepare('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?')
    .run(title, Date.now(), id)
}

export function deleteChat(id: string): void {
  getDB().prepare('DELETE FROM chats WHERE id = ?').run(id)
}

export function touchChat(id: string): void {
  getDB().prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(Date.now(), id)
}

// ─── MESSAGES ────────────────────────────────────────────
export function addMessage(msg: {
  id: string; chatId: string; role: string
  content: string; model?: string
}): void {
  getDB().prepare(`
    INSERT INTO messages (id, chat_id, role, content, created_at, is_pinned, model)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `).run(msg.id, msg.chatId, msg.role, msg.content, Date.now(), msg.model ?? null)
  touchChat(msg.chatId)
}

export function getMessages(chatId: string) {
  return getDB().prepare(
    'SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC'
  ).all(chatId)
}

export function pinMessage(id: string, pinned: boolean): void {
  getDB().prepare('UPDATE messages SET is_pinned = ? WHERE id = ?')
    .run(pinned ? 1 : 0, id)
}

// ─── MEMORY ──────────────────────────────────────────────
export function upsertMemory(id: string, category: string, key: string, value: string): void {
  const now = Date.now()
  getDB().prepare(`
    INSERT INTO memory (id, category, key, value, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(id, category, key, value, now, now)
}

export function getAllMemory() {
  return getDB().prepare('SELECT * FROM memory ORDER BY category, key').all()
}

export function clearMemory(): void {
  getDB().prepare('DELETE FROM memory').run()
}

// ─── AGENT LOGS ──────────────────────────────────────────
export function addAgentLog(log: {
  id: string; chatId?: string; type: string
  tool?: string; args?: string; result?: string; error?: string
}): void {
  getDB().prepare(`
    INSERT INTO agent_logs (id, chat_id, type, tool, args, result, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(log.id, log.chatId ?? null, log.type, log.tool ?? null,
    log.args ?? null, log.result ?? null, log.error ?? null, Date.now())
}

// ─── CLIPBOARD ───────────────────────────────────────────
export function addClipboardEntry(id: string, content: string, type = 'text'): void {
  getDB().prepare(`
    INSERT INTO clipboard_history (id, content, type, created_at) VALUES (?, ?, ?, ?)
  `).run(id, content, type, Date.now())
  // Храним только последние 200 записей
  getDB().prepare(`
    DELETE FROM clipboard_history WHERE id NOT IN (
      SELECT id FROM clipboard_history ORDER BY created_at DESC LIMIT 200
    )
  `).run()
}

export function getClipboardHistory(limit = 50) {
  return getDB().prepare(
    'SELECT * FROM clipboard_history ORDER BY created_at DESC LIMIT ?'
  ).all(limit)
}
