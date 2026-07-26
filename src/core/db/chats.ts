import type { Chat, Message, ChatMode } from '../../shared/types'
import { v4 as uuid } from 'uuid'
import { getDB } from './handle'

// === CHATS ===

export function createChat(isIncognito = false, mode: ChatMode = 'code', projectId?: string): Chat {
  const db = getDB()
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
  return getDB().prepare(`
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
  const row = getDB().prepare('SELECT mode FROM chats WHERE id = ?').get(chatId) as { mode: string } | undefined
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
  const row = getDB().prepare(`
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
  getDB().prepare('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?')
    .run(title, Date.now(), id)
}

export function deleteChat(id: string): void {
  getDB().prepare('DELETE FROM chats WHERE id = ?').run(id)
}

export function archiveChat(id: string, archived: boolean): void {
  getDB().prepare('UPDATE chats SET is_archived = ? WHERE id = ?').run(archived ? 1 : 0, id)
}

export function pinChat(id: string, pinned: boolean): void {
  getDB().prepare('UPDATE chats SET is_pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
}

export function setChatColor(id: string, color: string | null): void {
  getDB().prepare('UPDATE chats SET color = ? WHERE id = ?').run(color, id)
}

export function duplicateChat(id: string): Chat | null {
  const db = getDB()
  const src = db.prepare(`SELECT * FROM chats WHERE id = ?`).get(id) as Chat & { created_at: number; updated_at: number; is_incognito: number; workdir: string | null; project_context: string | null; project_id: string | null; mode: string } | undefined
  if (!src) return null
  const newId = uuid()
  const now = Date.now()
  // Копируем project_id — дубликат чата остаётся в том же проекте
  // и сохраняет привязку к рабочей директории.
  db.prepare(`INSERT INTO chats (id, title, created_at, updated_at, is_incognito, is_pinned, is_archived, color, mode, workdir, project_context, project_id) VALUES (?,?,?,?,?,0,0,?,?,?,?,?,?)`)
    .run(newId, src.title + ' (копия)', now, now, src.is_incognito ?? 0, (src as unknown as Record<string,unknown>).color ?? null, src.mode ?? 'code', src.workdir ?? null, src.project_context ?? null, src.project_id ?? null)
  const msgs = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC').all(id) as (Message & { chat_id: string; created_at: number; is_pinned: number; tool_steps?: string })[]
  for (const m of msgs) {
    const mid = uuid()
    db.prepare(`INSERT INTO messages (id, chat_id, role, content, created_at, is_pinned, model, tool_steps) VALUES (?,?,?,?,?,?,?,?)`)
      .run(mid, newId, m.role, m.content, m.created_at ?? m.createdAt, 0, m.model ?? null, m.tool_steps ?? null)
  }
  return getAllChats().find(c => c.id === newId) ?? null
}

export function exportChat(id: string, format: 'txt' | 'md'): string {
  const db = getDB()
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
  getDB().prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(Date.now(), id)
}
