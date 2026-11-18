import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { JanitorArchiveEntry } from './janitor'

/**
 * Персистентное состояние мини-агентов per chat: конституция (закреплённые
 * ограничения юзера) и recall-архив джанитора.
 *
 * Worker (и Agent вместе с ним) живёт один запрос — без этого файла
 * конституция и архив умирают между сообщениями чата, а маркеры [recall:id]
 * в сохранённой истории БД остаются без источника. Инкогнито-чаты и
 * суб-агенты сюда не пишут (см. Agent.persistAssistantState).
 */
export interface AssistantState {
  constitution?: string[]
  janitorArchive?: JanitorArchiveEntry[]
}

/** Хвост архива: достаточно для restore недавних компакций, не свалка. */
const MAX_ARCHIVE_ENTRIES = 50

function stateFile(userDataPath: string, chatId: string): string {
  const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(userDataPath, 'assistants-state', `${safe}.json`)
}

export function loadAssistantState(userDataPath: string, chatId: string): AssistantState | null {
  try {
    const p = stateFile(userDataPath, chatId)
    if (!existsSync(p)) return null
    const raw = JSON.parse(readFileSync(p, 'utf8')) as AssistantState
    return raw && typeof raw === 'object' ? raw : null
  } catch { /* битый файл — считаем пустым состоянием */ return null }
}

export function saveAssistantState(userDataPath: string, chatId: string, state: AssistantState): void {
  try {
    mkdirSync(join(userDataPath, 'assistants-state'), { recursive: true })
    const payload = {
      constitution: state.constitution ?? [],
      janitorArchive: (state.janitorArchive ?? []).slice(-MAX_ARCHIVE_ENTRIES),
    }
    writeFileSync(stateFile(userDataPath, chatId), JSON.stringify(payload))
  } catch { /* персист не критичен */ }
}

/**
 * Возвращает свёрнутые джанитором tool-результаты к их резюме прямо в массиве
 * сообщений — по том же правилу, что применяет Janitor во время рана.
 *
 * Зачем это в main: агент живёт в воркере и видит СВЁРНУТУЮ историю, а
 * `context:calculate` собирает историю из БД, где tool-результаты лежат
 * целиком (janitor меняет только контекст в памяти). Без этого кольцо
 * контекста показывало несжатое значение (400k+) до тех пор, пока не придёт
 * реальный usage от провайдера (225k) — отсюда «то 400к, то норм».
 *
 * Совпадение проверяется по tool_call_id + исходному контенту: если результат
 * в БД другой (уже перезаписан), резюме не применяется.
 */
export function applyJanitorSummaries<T extends { role: string; content: unknown; tool_call_id?: string }>(
  messages: T[],
  entries: JanitorArchiveEntry[] | undefined,
): number {
  if (!entries?.length) return 0
  // Индекс: tool_call_id → исходный контент → резюме.
  const byCall = new Map<string, Array<{ original: string; summary: string }>>()
  for (const entry of entries) {
    const original = entry.originalMessages?.[0]
    if (!original?.tool_call_id || typeof original.content !== 'string' || typeof entry.summary !== 'string') continue
    const list = byCall.get(original.tool_call_id)
    if (list) list.push({ original: original.content, summary: entry.summary })
    else byCall.set(original.tool_call_id, [{ original: original.content, summary: entry.summary }])
  }
  if (byCall.size === 0) return 0
  let applied = 0
  for (const message of messages) {
    if (message.role !== 'tool' || !message.tool_call_id || typeof message.content !== 'string') continue
    const candidates = byCall.get(message.tool_call_id)
    if (!candidates) continue
    const hit = candidates.find(c => c.original === message.content)
    if (!hit) continue
    message.content = hit.summary
    applied++
  }
  return applied
}
