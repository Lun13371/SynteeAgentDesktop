import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import {
  listNotes,
  createNote,
  updateNote,
  deleteNote,
  type NoteScope,
} from '../../core/db/notes'
import { getChatWorkdirContext, getAllProjects } from '../../core/db'
import { getDB } from '../../core/db/handle'

/**
 * IPC для заметок (notes). Два типа:
 *  - project: видны во всех чатах проекта, AI видит в системном промпте.
 *  - chat: привязаны к конкретному чату.
 *
 * CRUD через IPC: notes:list, notes:create, notes:update, notes:delete.
 * Live-обновление: после любой мутации шлём 'notes:changed' в renderer.
 */
export function registerNotesIPC(getWindow: () => BrowserWindow | null): void {
  function notifyChanged(scope: NoteScope, projectId?: string | null, chatId?: string | null) {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('notes:changed', { scope, projectId, chatId })
    }
  }

  // Resolve projectId by chatId — used by NotesPanel to know which project
  // the current chat belongs to (for project-scoped notes).
  ipcMain.handle('notes:getProjectId', (_, chatId: string) => {
    try {
      const wctx = getChatWorkdirContext(chatId)
      if (wctx.workdir) {
        const found = getAllProjects().find(p => p.workdir === wctx.workdir)
        return found?.id ?? null
      }
    } catch { /* ok */ }
    return null
  })

  ipcMain.handle('notes:list', (_, params: { scope: NoteScope; projectId?: string; chatId?: string }) => {
    return listNotes(params)
  })

  ipcMain.handle('notes:create', (_, params: {
    scope: NoteScope
    projectId?: string
    chatId?: string
    title: string
    content?: string
  }) => {
    const result = createNote(params)
    if (result.success) {
      notifyChanged(params.scope, params.projectId, params.chatId)
    }
    return result
  })

  ipcMain.handle('notes:update', (_, params: { id: string; title?: string; content?: string }) => {
    const result = updateNote(params)
    if (result.success && result.note) {
      notifyChanged(result.note.scope, result.note.projectId, result.note.chatId)
    }
    return result
  })

  ipcMain.handle('notes:delete', (_, id: string) => {
    let scope: NoteScope = 'chat'
    let projectId: string | null = null
    let chatId: string | null = null
    try {
      const row = getDB().prepare(`SELECT scope, project_id, chat_id FROM notes WHERE id=?`).get(id) as
        | { scope: NoteScope; project_id: string | null; chat_id: string | null }
        | undefined
      if (row) {
        scope = row.scope
        projectId = row.project_id
        chatId = row.chat_id
      }
    } catch { /* ok */ }

    const result = deleteNote(id)
    if (result.success) {
      notifyChanged(scope, projectId, chatId)
    }
    return result
  })
}
