import type { Attachment } from './types'

/**
 * Убирает base64-полезную нагрузку (dataUrl) из вложений, у которых уже есть
 * файл на диске (path).
 *
 * Зачем: вложение сохраняется в userData/draft-attachments/<chatId>/ и в записи
 * остаётся `path`, но paste/dragdrop дополнительно кладёт туда же полный
 * data:URL. PNG на 2.4 МБ превращается в 13 МБ base64 — и это уезжает в
 * messages.attachments (JSON), парсится в main на каждом чтении истории и
 * гонится по IPC в renderer. Замер 26.10.2026: 20.75 МБ base64 в 33 вложениях,
 * один JSON.parse такого сообщения = +12.6 МБ RSS.
 *
 * Renderer умеет рендерить вложение по `file://${path}` (MessageBubble,
 * AttachmentChips, AttachmentPreviewModal, InlineAttachmentRenderer), а
 * AI-пайплайн (chat.ipc processAttachmentsAndStream) читает файл с диска по
 * path — base64 в БД никому не нужен.
 *
 * Вложения БЕЗ path (файл ещё не сохранён) не трогаем: для них dataUrl —
 * единственный источник превью.
 */
export function stripAttachmentDataUrls<T extends Attachment>(
  attachments: T[],
): { attachments: T[]; changed: boolean } {
  let changed = false
  const result = attachments.map(a => {
    if (!a.dataUrl || !a.path) return a
    changed = true
    const copy = { ...a }
    delete (copy as Attachment).dataUrl
    return copy
  })
  return { attachments: changed ? result : attachments, changed }
}

/** Сколько байт base64 лежит в списке вложений (для диагностики/логов). */
export function attachmentDataUrlBytes(attachments: Attachment[] | undefined): number {
  if (!attachments?.length) return 0
  let total = 0
  for (const a of attachments) {
    if (a.dataUrl) total += a.dataUrl.length
  }
  return total
}