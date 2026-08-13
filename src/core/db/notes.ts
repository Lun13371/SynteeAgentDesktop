import { v4 as uuid } from 'uuid'
import { getDB } from './handle'

// ── Types ──────────────────────────────────────────────────────────────────

export type NoteScope = 'project' | 'chat'

export interface Note {
  id: string
  scope: NoteScope
  projectId: string | null
  chatId: string | null
  title: string
  content: string
  createdAt: number
  updatedAt: number
}

interface NoteRow {
  id: string
  scope: NoteScope
  project_id: string | null
  chat_id: string | null
  title: string
  content: string
  created_at: number
  updated_at: number
}

function rowToNote(row: NoteRow): Note {
  return {
    id: row.id,
    scope: row.scope,
    projectId: row.project_id,
    chatId: row.chat_id,
    title: row.title,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ── CRUD ───────────────────────────────────────────────────────────────────

const MAX_PROJECT_NOTES = 15

export function listNotes(params: {
  scope: NoteScope
  projectId?: string | null
  chatId?: string | null
}): Note[] {
  const db = getDB()
  if (params.scope === 'project') {
    if (!params.projectId) return []
    const rows = db.prepare(
      `SELECT * FROM notes WHERE scope='project' AND project_id=? ORDER BY updated_at DESC`
    ).all(params.projectId) as NoteRow[]
    return rows.map(rowToNote)
  }
  // scope === 'chat'
  if (!params.chatId) return []
  const rows = db.prepare(
    `SELECT * FROM notes WHERE scope='chat' AND chat_id=? ORDER BY updated_at DESC`
  ).all(params.chatId) as NoteRow[]
  return rows.map(rowToNote)
}

export function createNote(params: {
  scope: NoteScope
  projectId?: string | null
  chatId?: string | null
  title: string
  content?: string
}): { success: boolean; note?: Note; error?: string } {
  const db = getDB()
  const { scope, title, content = '' } = params

  if (!title || !title.trim()) {
    return { success: false, error: 'title is required' }
  }

  if (scope === 'project') {
    if (!params.projectId) {
      return { success: false, error: 'projectId is required for project notes' }
    }
    // Лимит проектных заметок
    const count = (db.prepare(
      `SELECT COUNT(*) as c FROM notes WHERE scope='project' AND project_id=?`
    ).get(params.projectId) as { c: number }).c
    if (count >= MAX_PROJECT_NOTES) {
      return { success: false, error: `Project notes limit reached (${MAX_PROJECT_NOTES}). Delete some notes first.` }
    }
  } else {
    if (!params.chatId) {
      return { success: false, error: 'chatId is required for chat notes' }
    }
  }

  const now = Date.now()
  const id = uuid()
  db.prepare(
    `INSERT INTO notes (id, scope, project_id, chat_id, title, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    scope,
    scope === 'project' ? params.projectId : null,
    scope === 'chat' ? params.chatId : null,
    title.trim(),
    content,
    now,
    now,
  )

  const row = db.prepare(`SELECT * FROM notes WHERE id=?`).get(id) as NoteRow
  return { success: true, note: rowToNote(row) }
}

export function updateNote(params: {
  id: string
  title?: string
  content?: string
}): { success: boolean; note?: Note; error?: string } {
  const db = getDB()
  const existing = db.prepare(`SELECT * FROM notes WHERE id=?`).get(params.id) as NoteRow | undefined
  if (!existing) {
    return { success: false, error: 'Note not found' }
  }

  const title = params.title !== undefined ? params.title.trim() : existing.title
  const content = params.content !== undefined ? params.content : existing.content

  if (!title) {
    return { success: false, error: 'title cannot be empty' }
  }

  db.prepare(
    `UPDATE notes SET title=?, content=?, updated_at=? WHERE id=?`
  ).run(title, content, Date.now(), params.id)

  const row = db.prepare(`SELECT * FROM notes WHERE id=?`).get(params.id) as NoteRow
  return { success: true, note: rowToNote(row) }
}

export function deleteNote(id: string): { success: boolean; error?: string } {
  const db = getDB()
  const result = db.prepare(`DELETE FROM notes WHERE id=?`).run(id)
  if (result.changes === 0) {
    return { success: false, error: 'Note not found' }
  }
  return { success: true }
}

export function getProjectNotesInfo(projectId: string): { notes: Array<{ id: string; title: string }>; count: number } {
  const db = getDB()
  const rows = db.prepare(
    `SELECT id, title FROM notes WHERE scope='project' AND project_id=? ORDER BY updated_at DESC LIMIT 15`
  ).all(projectId) as Array<{ id: string; title: string }>
  return { notes: rows, count: rows.length }
}
