import type { Attachment } from '../../shared/types'
import { getDB } from './handle'

// === Draft attachments ===
// Вложения черновика — переживают рестарт, не пропадают при смене чата.
// Картинки хранятся как файлы в userData/draft-attachments/{chatId}/,
// в БД — только путь + метаданные. Текстовые файлы из @mention хранят
// только путь (содержимое читается при отправке).

interface DraftAttachmentRow {
  id: string
  chat_id: string
  kind: string
  name: string
  path: string | null
  rel_path: string | null
  mime: string | null
  size: number | null
  source: string
  data_url: string | null
  skill_id: string | null
  command_name: string | null
  mcp_server_id: string | null
  snippet: string | null
  attached_at: number
}

function rowToAttachment(r: DraftAttachmentRow): Attachment {
  return {
    id: r.id,
    kind: r.kind as Attachment['kind'],
    name: r.name,
    path: r.path ?? undefined,
    relPath: r.rel_path ?? undefined,
    mime: r.mime ?? undefined,
    size: r.size ?? undefined,
    source: r.source as Attachment['source'],
    dataUrl: r.data_url ?? undefined,
    skillId: r.skill_id ?? undefined,
    commandName: r.command_name ?? undefined,
    mcpServerId: r.mcp_server_id ?? undefined,
    snippet: r.snippet ?? undefined,
    attachedAt: r.attached_at,
  }
}

/** Возвращает все вложения черновика чата (в порядке прикрепления). */
export function getDraftAttachments(chatId: string): Attachment[] {
  const rows = getDB().prepare(
    `SELECT id, chat_id, kind, name, path, rel_path, mime, size, source, data_url, skill_id, command_name, mcp_server_id, snippet, attached_at
     FROM chat_draft_attachments WHERE chat_id = ?
     ORDER BY attached_at ASC`
  ).all(chatId) as DraftAttachmentRow[]
  return rows.map(rowToAttachment)
}

/** Полностью заменяет список вложений черновика чата.
 *  Вызывается при каждом изменении набора чипов над инпутом. */
export function setDraftAttachments(chatId: string, attachments: Attachment[]): void {
  const db = getDB()
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM chat_draft_attachments WHERE chat_id = ?`).run(chatId)
    const stmt = db.prepare(
      `INSERT INTO chat_draft_attachments
       (id, chat_id, kind, name, path, rel_path, mime, size, source, data_url, skill_id, command_name, mcp_server_id, snippet, attached_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const a of attachments) {
      stmt.run(
        a.id, chatId, a.kind, a.name,
        a.path ?? null, a.relPath ?? null, a.mime ?? null, a.size ?? null,
        a.source, a.dataUrl ?? null, a.skillId ?? null, a.commandName ?? null,
        a.mcpServerId ?? null, a.snippet ?? null, a.attachedAt,
      )
    }
  })
  tx()
}

/** Удаляет одно вложение черновика по id. */
export function deleteDraftAttachment(chatId: string, attachmentId: string): void {
  getDB().prepare(
    `DELETE FROM chat_draft_attachments WHERE chat_id = ? AND id = ?`
  ).run(chatId, attachmentId)
}

/** Удаляет все вложения черновика чата (например, после отправки сообщения). */
export function clearDraftAttachments(chatId: string): void {
  getDB().prepare(`DELETE FROM chat_draft_attachments WHERE chat_id = ?`).run(chatId)
}
