import type { BrowserWindow } from 'electron'
import { v4 as uuid } from 'uuid'
import { deleteMessageById } from '../../core/db'
import { IPC_EVENTS } from '../../shared/constants'
import type { Message } from '../../shared/types'
import type { ChatMessage } from '../../core/context/contextManager'

// ─── Compact: helpers для разделителя сжатия контекста ──────────────────────
// Применяется и при авто-компакции (внутри runChatSend), и при ручном /compact
// (chat:compact IPC handler). Разделитель — это system-сообщение с
// slashCommand.name === 'compact', сохраняется в БД через saveMessage.
// compactSummary — снимок резюме на момент сжатия (не меняется при будущих
// компакциях в отличие от chat_summaries, который перетирается).

export function fmtTokensK(n: number): string {
  // Округляем до десятых k (1200 → "1.2k", 18500 → "18.5k", 600 → "0.6k")
  return (Math.round(n / 100) / 10).toLocaleString('ru') + 'k'
}

export function createCompactDivider(chatId: string, opts: {
  removedCount: number
  tokensBefore: number
  tokensAfter: number
  summaryContent: string
  createdAt?: number
  /** Пометка ручного /compact: 'last' | 'full', при фокусе — 'last + фокус'. */
  modeLabel?: string
}): Message {
  const tokensSaved = Math.max(0, opts.tokensBefore - opts.tokensAfter)
  const modeSuffix = opts.modeLabel ? ` (${opts.modeLabel})` : ''
  const content = `Контекст сжат${modeSuffix} • удалено ${opts.removedCount} сообщ. • ${fmtTokensK(opts.tokensBefore)}→${fmtTokensK(opts.tokensAfter)} токенов • сэкономлено ~${fmtTokensK(tokensSaved)}`
  return {
    id: uuid(),
    chatId,
    role: 'system',
    content,
    createdAt: opts.createdAt ?? Date.now(),
    isPinned: 0,
    slashCommand: { name: 'compact', args: '' },
    compactSummary: opts.summaryContent,
    compactStats: {
      removedCount: opts.removedCount,
      tokensBefore: opts.tokensBefore,
      tokensAfter: opts.tokensAfter,
      tokensSaved,
    },
  }
}

export function emitChatCompacted(win: BrowserWindow | null, payload: {
  chatId: string
  dividerMessageId: string
  removedCount: number
  tokensBefore: number
  tokensAfter: number
  trigger: 'auto' | 'manual'
}): void {
  win?.webContents.send(IPC_EVENTS.CHAT_COMPACTED, { ...payload, ts: Date.now() })
}

/**
 * Вычисляет Message.id middle-диапазона (что надо удалить из БД) и удаляет их.
 * Логика симметрична applyRollingWindowAsync: первые keepFirst и последние
 * keepLast Message остаются, middle — удаляется физически (через
 * deleteMessageById). При короткой истории адаптирует keepLast/keepFirst
 * так, чтобы middle содержал хотя бы 1 сообщение.
 *
 * Возвращает реально удалённое кол-во (может отличаться от removedCount в
 * CompressResult, т.к. тот считал ChatMessage, а тут — Message).
 */
export function deleteMiddleMessagesFromDB(history: Message[], keepFirst: number, keepLast: number): number {
  let kf = keepFirst
  let kl = keepLast
  if (history.length <= kf + kl + 1) {
    const newKl = Math.max(0, history.length - kf - 1)
    kl = Math.min(kl, newKl)
    if (kf + kl + 1 > history.length) {
      kf = Math.max(0, history.length - kl - 1)
    }
  }
  if (kf + kl >= history.length || kf < 0 || kl < 0) return 0

  const middle = history.slice(kf, history.length - kl)
  let deleted = 0
  for (const msg of middle) {
    try {
      deleteMessageById(msg.id)
      deleted++
    } catch {
      // уже удалён / не существует — ok
    }
  }
  return deleted
}

/**
 * Возвращает «живое» подмножество истории для AI-контекста: сообщения
 * ПОСЛЕ последнего compaction-divider'а. Старые (summarized) сообщения
 * остаются в БД (UI хранит всю историю), но в контекст модели не грузятся
 * — их заменяет summary в system prompt.
 *
 * Модель: «новый чат + summary». После компакции AI видит только:
 *   summary (в system prompt) + tail + новые сообщения.
 *
 * Divider — это system-сообщение с slashCommand.name === 'compact'. Его
 * createdAt = граница между summarized middle и live tail (первый tail
 * минус 1). Сообщения с createdAt > divider.createdAt = tail + новые.
 * Divider-сообщения сами исключаются (они UI-маркеры, не AI-контекст).
 *
 * Если divider'а нет (первая компакция ещё не было) — live = вся история.
 */
// Legacy in-memory filter for caller-owned ephemeral histories (side/incognito).
// Keep its divider boundary semantics while applying context visibility.
export function getLiveMessages(history: Message[]): Message[] {
  let latestDividerAt = -Infinity
  for (const message of history) {
    if (message.role === 'system' && message.slashCommand?.name === 'compact') {
      latestDividerAt = Math.max(latestDividerAt, message.createdAt)
    }
  }
  return history.filter(message =>
    !(message.role === 'system' && message.slashCommand?.name === 'compact')
    && message.createdAt > latestDividerAt,
  )
}

/**
 * createdAt для divider'а ручного /compact.
 *
 * Divider — это граница AI-контекста: getMessagesAfterLatestCompact берёт
 * сообщения с created_at > divider.created_at. Значит divider обязан стоять
 * ровно ПЕРЕД сохранённым tail'ом (createdAt первого tail Message − 1) —
 * как в авто-компакции внутри runChatSend. Если поставить его на Date.now()
 * (как было раньше), из live-подмножества выпадает и tail, который
 * applyRollingWindowAsync только что сохранил, причём в summary он тоже не
 * попадает (middle его исключает) — последние сообщения исчезают из контекста
 * модели молча.
 *
 * Пустой tail (история из одного сообщения) — divider уходит в конец ленты:
 * сохранять нечего, всё ушло в summary.
 */
export function compactDividerCreatedAt(tail: ChatMessage[], liveMessages: Message[]): number {
  const firstTailMsgId = tail.find(m => m.messageId)?.messageId
  const boundaryMsg = firstTailMsgId ? liveMessages.find(m => m.id === firstTailMsgId) : undefined
  return boundaryMsg ? boundaryMsg.createdAt - 1 : Date.now()
}
