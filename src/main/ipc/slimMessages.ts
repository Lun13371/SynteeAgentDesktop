import type { Message, ToolStep } from '../../shared/types'
import { stripAttachmentDataUrls } from '../../shared/attachmentStorage'

/**
 * Slim-версии сообщений для renderer'а.
 *
 * Полные toolSteps (тела файлов в toolArgs write_file/edit, большие diff'ы,
 * многокилобайтные выводы команд) НУЖНЫ в БД: messageToContextMessages
 * разворачивает их в AI-контекст при следующих chat:send, SessionChangesPanel
 * читает diff'ы. Но для ОТОБРАЖЕНИЯ в чате полные пейлоады избыточны — UI и
 * так урезает вывод (60/500 строк + «Показать ещё»). Раньше полные данные
 * гонялись по IPC при каждой подгрузке страницы и лежали в памяти renderer'а
 * (messages + LRU-кэш окон на 8 чатов) — десятки МБ на tool-тяжёлых чатах,
 * плюс JSON.parse этих мегабайт в main при каждом getMessagesPage.
 *
 * Здесь урезаем КОПИЮ только на границе main→renderer. БД и AI-контекст
 * читают полные данные напрямую из SQLite и не затрагиваются.
 */

const CONTENT_MAX = 50_000
const DIFF_MAX = 50_000
const ARG_VALUE_MAX = 2_000
const THINKING_MAX = 50_000

// Эти тулы читают свои пейлоады специальным образом вне ToolChain:
// ask_user — вопросы из toolArgs + JSON-ответы из content (regex по хвосту);
// spawn_agent — task из toolArgs + agentId regex из content (AgentCardLive).
// Их данные малы, но усечение сломало бы парсинг — пропускаем.
const SKIP_TOOLS = new Set(['ask_user', 'spawn_agent'])

function capNote(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n… [сокращено: показано ${max} из ${text.length} символов]`
}

function slimStep(step: ToolStep): ToolStep {
  if (SKIP_TOOLS.has(step.toolName ?? '')) return step
  let out = step
  if (typeof step.content === 'string' && step.content.length > CONTENT_MAX) {
    out = { ...out, content: capNote(step.content, CONTENT_MAX) }
  }
  if (typeof step.diff === 'string' && step.diff.length > DIFF_MAX) {
    out = { ...out, diff: capNote(step.diff, DIFF_MAX) }
  }
  const args = step.toolArgs
  if (args) {
    let changed = false
    const slim: Record<string, unknown> = { ...args }
    for (const [k, v] of Object.entries(slim)) {
      if (typeof v === 'string' && v.length > ARG_VALUE_MAX) {
        slim[k] = capNote(v, ARG_VALUE_MAX)
        changed = true
      }
    }
    if (changed) out = { ...out, toolArgs: slim }
  }
  return out
}

/** Возвращает копию сообщения с урезанными tool-пейлоадами (оригинал не мутируется). */
export function slimMessageForUI<T extends Message>(msg: T): T {
  let out = msg
  if (msg.toolSteps && msg.toolSteps.length > 0) {
    out = { ...out, toolSteps: msg.toolSteps.map(slimStep) }
  }
  if (msg.iterations && msg.iterations.length > 0) {
    out = {
      ...out,
      iterations: msg.iterations.map(it => ({ ...it, steps: it.steps.map(slimStep) })),
    }
  }
  if (typeof msg.thinking === 'string' && msg.thinking.length > THINKING_MAX) {
    out = { ...out, thinking: capNote(msg.thinking, THINKING_MAX) }
  }
  // base64 вложений — самая тяжёлая часть сообщения (до 13 МБ на одну картинку).
  // В renderer не нужен: вложение рендерится по file://${path}. Без этой ветки
  // 20.75 МБ base64 ехали по IPC при каждой загрузке страницы и оседали в
  // JS-heap renderer'а.
  if (msg.attachments && msg.attachments.length > 0) {
    const stripped = stripAttachmentDataUrls(msg.attachments)
    if (stripped.changed) out = { ...out, attachments: stripped.attachments }
  }
  return out
}

export function slimMessagesForUI<T extends Message>(messages: T[]): T[] {
  return messages.map(slimMessageForUI)
}
