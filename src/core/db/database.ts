import Database from 'better-sqlite3'
import { app } from 'electron'
import { join, basename } from 'path'
import { mkdirSync } from 'fs'
import type { Chat, Message, ChatMode, Project } from '../../shared/types'
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

    CREATE TABLE IF NOT EXISTS projects (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      workdir         TEXT NOT NULL UNIQUE,
      project_context TEXT,
      verification_command TEXT,
      created_at      INTEGER NOT NULL,
      last_used       INTEGER NOT NULL
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
  if (!cols.find(c => c.name === 'todo')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN todo TEXT`).run()
  }

  // Миграция: добавляем поля чатов
  const chatCols = db.prepare(`PRAGMA table_info(chats)`).all() as { name: string }[]
  if (!chatCols.find(c => c.name === 'is_pinned'))   db.prepare(`ALTER TABLE chats ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0`).run()
  if (!chatCols.find(c => c.name === 'is_archived')) db.prepare(`ALTER TABLE chats ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0`).run()
  if (!chatCols.find(c => c.name === 'color'))       db.prepare(`ALTER TABLE chats ADD COLUMN color TEXT`).run()
  if (!chatCols.find(c => c.name === 'mode'))        db.prepare(`ALTER TABLE chats ADD COLUMN mode TEXT NOT NULL DEFAULT 'code'`).run()
  // workdir — рабочая директория чата в режиме "Код" (NULL для Work-режима
  // и чатов, созданных до этой фичи). project_context — результат
  // analyzeProject(workdir) на момент создания чата; write-once, неизменяем.
  if (!chatCols.find(c => c.name === 'workdir'))          db.prepare(`ALTER TABLE chats ADD COLUMN workdir TEXT`).run()
  if (!chatCols.find(c => c.name === 'project_context'))  db.prepare(`ALTER TABLE chats ADD COLUMN project_context TEXT`).run()
  // project_id — FK на projects. Чаты без проекта (старые, инкогнито,
  // или созданные до этой фичи) имеют NULL → попадают в группу «Без проекта».
  if (!chatCols.find(c => c.name === 'project_id'))       db.prepare(`ALTER TABLE chats ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`).run()

  // Миграция: verification_command на projects — команда авто-проверки
  // (напр. "npm test"), запускаемая после серии успешных правок файлов.
  const projectCols = db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[]
  if (!projectCols.find(c => c.name === 'verification_command')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN verification_command TEXT`).run()
  }

  // Индекс по project_id — создаём ПОСЛЕ миграции (колонка добавлена выше).
  // В db.exec() этот индекс создавать нельзя: на момент выполнения первого
  // блока колонки project_id ещё нет, и CREATE INDEX роняет всю миграцию.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chats_project_id ON chats(project_id);`)

  // Автомиграция: для каждого уникального workdir из chats создаём проект
  // и привязываем чаты к нему. workdir на chats остаётся как денормализованный
  // кэш для обратной совместимости, но источник правды теперь — projects.
  migrateChatsToProjects()
}

/**
 * Переносит существующие chats.workdir в таблицу projects: для каждого
  * уникального workdir создаёт проект (имя = basename папки), чатам
  * проставляет project_id. Идемпотентна — повторный запуск не дублирует.
 */
function migrateChatsToProjects(): void {
  const rows = db.prepare(`SELECT DISTINCT workdir FROM chats WHERE workdir IS NOT NULL AND project_id IS NULL`).all() as { workdir: string }[]
  if (rows.length === 0) return
  const now = Date.now()
  for (const { workdir } of rows) {
    // Проверяем, есть ли уже проект с таким workdir (UNIQUE constraint)
    const existing = db.prepare(`SELECT id FROM projects WHERE workdir = ?`).get(workdir) as { id: string } | undefined
    const projectId = existing?.id ?? uuid()
    if (!existing) {
      const name = basename(workdir) || workdir
      const projectContext = db.prepare(`SELECT project_context FROM chats WHERE workdir = ? AND project_context IS NOT NULL LIMIT 1`).get(workdir) as { project_context: string } | undefined
      db.prepare(`INSERT INTO projects (id, name, workdir, project_context, created_at, last_used) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(projectId, name, workdir, projectContext?.project_context ?? null, now, now)
    }
    db.prepare(`UPDATE chats SET project_id = ? WHERE workdir = ? AND project_id IS NULL`).run(projectId, workdir)
  }
}

// === CHATS ===

export function createChat(isIncognito = false, mode: ChatMode = 'code', projectId?: string): Chat {
  const now = Date.now()
  // workdir на chats — денормализованный кэш из projects (для обратной
  // совместимости со старым кодом, читающим chats.workdir напрямую).
  let workdir: string | undefined
  if (projectId) {
    const p = db.prepare(`SELECT workdir FROM projects WHERE id = ?`).get(projectId) as { workdir: string } | undefined
    if (p) workdir = p.workdir
  }
  const chat: Chat = {
    id: uuid(),
    title: 'Новый чат',
    createdAt: now,
    updatedAt: now,
    isIncognito: isIncognito ? 1 : 0,
    isPinned: 0,
    isArchived: 0,
    mode,
    workdir,
    projectId,
  }
  db.prepare(`
    INSERT INTO chats (id, title, created_at, updated_at, is_incognito, is_pinned, is_archived, mode, workdir, project_context, project_id)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, NULL, ?)
  `).run(chat.id, chat.title, chat.createdAt, chat.updatedAt, chat.isIncognito, mode, workdir ?? null, projectId ?? null)
  // Обновляем last_used проекта
  if (projectId) {
    db.prepare(`UPDATE projects SET last_used = ? WHERE id = ?`).run(now, projectId)
  }
  return chat
}

export function getAllChats(): Chat[] {
  return db.prepare(`
    SELECT c.id, c.title, c.created_at as createdAt, c.updated_at as updatedAt,
           c.is_incognito as isIncognito,
           c.is_pinned as isPinned,
           c.is_archived as isArchived,
           c.mode,
           c.color,
           c.workdir,
           c.project_id as projectId,
           (SELECT m.content FROM messages m WHERE m.chat_id = c.id AND m.role != 'system' ORDER BY m.created_at DESC LIMIT 1) as lastMessage,
           (SELECT COUNT(*) FROM messages WHERE chat_id = c.id) as messageCount
    FROM chats c WHERE c.is_incognito = 0
    ORDER BY c.is_pinned DESC, c.updated_at DESC
  `).all() as Chat[]
}

export function getChatMode(chatId: string): ChatMode {
  const row = db.prepare('SELECT mode FROM chats WHERE id = ?').get(chatId) as { mode: string } | undefined
  return (row?.mode as ChatMode) ?? 'code'
}

/**
 * Возвращает рабочую директорию чата и зафиксированный при создании
 * контекст проекта (результат analyzeProject). Источник правды — таблица
 * projects (JOIN через project_id). Если у чата нет project_id, но есть
 * денормализованный workdir (старые чаты до миграции) — используем его
 * как fallback. project_context НЕ выносится в shared Chat-тип — это
 * потенциально большой текстовый блок, который нужен только main-процессу.
 */
export function getChatWorkdirContext(chatId: string): { workdir?: string; projectContext?: string; verificationCommand?: string } {
  const row = db.prepare(`
    SELECT c.workdir as chatWorkdir, c.project_context as chatProjectContext,
           p.workdir as projWorkdir, p.project_context as projProjectContext,
           p.verification_command as verificationCommand
    FROM chats c
    LEFT JOIN projects p ON c.project_id = p.id
    WHERE c.id = ?
  `).get(chatId) as {
    chatWorkdir: string | null; chatProjectContext: string | null
    projWorkdir: string | null; projProjectContext: string | null
    verificationCommand: string | null
  } | undefined
  if (!row) return {}
  // Предпочитаем project (источник правды), fallback на denormalized chats.workdir
  const workdir = row.projWorkdir ?? row.chatWorkdir ?? undefined
  const projectContext = row.projProjectContext ?? row.chatProjectContext ?? undefined
  return { workdir, projectContext, verificationCommand: row.verificationCommand ?? undefined }
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
  const src = db.prepare(`SELECT * FROM chats WHERE id = ?`).get(id) as Chat & { created_at: number; updated_at: number; is_incognito: number; workdir: string | null; project_context: string | null; project_id: string | null; mode: string } | undefined
  if (!src) return null
  const newId = require('uuid').v4() as string
  const now = Date.now()
  // Копируем project_id — дубликат чата остаётся в том же проекте
  // и сохраняет привязку к рабочей директории.
  db.prepare(`INSERT INTO chats (id, title, created_at, updated_at, is_incognito, is_pinned, is_archived, color, mode, workdir, project_context, project_id) VALUES (?,?,?,?,?,0,0,?,?,?,?,?,?)`)
    .run(newId, src.title + ' (копия)', now, now, src.is_incognito ?? 0, (src as unknown as Record<string,unknown>).color ?? null, src.mode ?? 'code', src.workdir ?? null, src.project_context ?? null, src.project_id ?? null)
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

// === PROJECTS ===

export function createProject(workdir: string, projectContext?: string): Project {
  const now = Date.now()
  const name = basename(workdir) || workdir
  // Если проект с таким workdir уже существует — возвращаем его (UNIQUE на workdir).
  const existing = db.prepare(`SELECT * FROM projects WHERE workdir = ?`).get(workdir) as Project | undefined
  if (existing) {
    // Обновляем last_used и контекст если передан новый
    if (projectContext) {
      db.prepare(`UPDATE projects SET project_context = ?, last_used = ? WHERE id = ?`).run(projectContext, now, existing.id)
    } else {
      db.prepare(`UPDATE projects SET last_used = ? WHERE id = ?`).run(now, existing.id)
    }
    return { ...existing, lastUsed: now, projectContext: projectContext ?? existing.projectContext }
  }
  const project: Project = {
    id: uuid(),
    name,
    workdir,
    projectContext,
    createdAt: now,
    lastUsed: now,
  }
  db.prepare(`INSERT INTO projects (id, name, workdir, project_context, created_at, last_used) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(project.id, project.name, project.workdir, projectContext ?? null, project.createdAt, project.lastUsed)
  return project
}

export function getAllProjects(): Project[] {
  return db.prepare(`
    SELECT id, name, workdir, project_context as projectContext, verification_command as verificationCommand,
           created_at as createdAt, last_used as lastUsed
    FROM projects ORDER BY last_used DESC
  `).all() as Project[]
}

export function renameProject(id: string, name: string): void {
  db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id)
}

export function setProjectVerificationCommand(id: string, command: string | null): void {
  db.prepare('UPDATE projects SET verification_command = ? WHERE id = ?').run(command, id)
}

export function deleteProject(id: string): void {
  // Чаты остаются (project_id = NULL через ON DELETE SET NULL), попадают в «Без проекта».
  // workdir на chats не трогаем — денормализованный кэш, harmless.
  db.prepare('DELETE FROM projects WHERE id = ?').run(id)
}

export function getProjectById(id: string): Project | undefined {
  const row = db.prepare(`
    SELECT id, name, workdir, project_context as projectContext, verification_command as verificationCommand,
           created_at as createdAt, last_used as lastUsed
    FROM projects WHERE id = ?
  `).get(id) as Project | undefined
  return row
}

export function touchProject(id: string): void {
  db.prepare('UPDATE projects SET last_used = ? WHERE id = ?').run(Date.now(), id)
}

// === MESSAGES ===

export function saveMessage(msg: Message): void {
  db.prepare(`
    INSERT OR REPLACE INTO messages (id, chat_id, role, content, created_at, is_pinned, model, tool_steps, thinking, thinking_ms, slash_command, iterations, plan_data, todo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    msg.id, msg.chatId, msg.role, msg.content, msg.createdAt, msg.isPinned, msg.model ?? null,
    msg.toolSteps ? JSON.stringify(msg.toolSteps) : null,
    msg.thinking ?? null, msg.thinkingMs ?? null,
    msg.slashCommand ? JSON.stringify(msg.slashCommand) : null,
    (msg as Message & { iterations?: unknown }).iterations ? JSON.stringify((msg as Message & { iterations?: unknown }).iterations) : null,
    msg.planData ? JSON.stringify(msg.planData) : null,
    msg.todo ? JSON.stringify(msg.todo) : null,
  )
  touchChat(msg.chatId)
}

export function getMessages(chatId: string): Message[] {
  const rows = db.prepare(`
    SELECT id, chat_id as chatId, role, content, created_at as createdAt, is_pinned as isPinned, model,
           tool_steps as toolStepsJson, thinking, thinking_ms as thinkingMs, slash_command as slashCommandJson,
           iterations as iterationsJson, plan_data as planDataJson, todo as todoJson
    FROM messages WHERE chat_id = ?
    ORDER BY created_at ASC
  `).all(chatId) as (Message & { toolStepsJson?: string; slashCommandJson?: string; iterationsJson?: string; planDataJson?: string; todoJson?: string })[]
  return rows.map(r => {
    const { toolStepsJson, slashCommandJson, iterationsJson, planDataJson, todoJson, ...rest } = r
    return {
      ...rest,
      toolSteps: toolStepsJson ? JSON.parse(toolStepsJson) : undefined,
      slashCommand: slashCommandJson ? JSON.parse(slashCommandJson) : undefined,
      iterations: iterationsJson ? JSON.parse(iterationsJson) : undefined,
      planData: planDataJson ? JSON.parse(planDataJson) : undefined,
      todo: todoJson ? JSON.parse(todoJson) : undefined,
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
  `).run(chatId, content.slice(0, 8000), Date.now())  // hard cap 8000 символов ~4000 токенов
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
