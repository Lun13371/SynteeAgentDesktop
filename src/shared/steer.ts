import type { Attachment, SteerAttachmentMeta } from './types/attachment'

// ── §steer: реплика пользователя, внедрённая в контекст работающего агента ──
//
// Пользователь зажимает кнопку отправки (0,5с) → текст НЕ встаёт в очередь,
// а летит в воркер → Agent дренажит pendingSteers на границе следующего раунда
// и вставляет user-сообщение с этим маркером. Модель видит, что её поправили
// ПО ХОДУ дела, и продолжает работу, а не начинает заново.
//
// Маркер общий для runtime (Agent) и для пересборки истории
// (chatContextHelpers): в БД реплика живёт шагом внутри assistant-сообщения,
// поэтому при следующих ходах её нужно восстановить в контекст как обычное
// user-сообщение — иначе модель «забудет», что её поправляли.
export const STEER_MARKER = '[Пользователь написал во время твоей работы — учти это и продолжи с учётом написанного]'

/**
 * §steer — сжимает Attachment до метаданных для карточки реплики в ленте
 * рана (ToolStep.attachments): чипы/миниатюры InlineAttachmentRenderer.
 * dataUrl/snippet/source не переживают БД — там они не нужны.
 */
export function toSteerAttachmentMeta(a: Attachment): SteerAttachmentMeta {
  return { id: a.id, kind: a.kind, name: a.name, path: a.path, mime: a.mime, size: a.size }
}
