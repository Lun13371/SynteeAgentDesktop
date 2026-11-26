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
  /** Версия схемы. 2 — конституция содержит только явные правила
   *  (/rule, «запомни правило:»). Файлы без версии писались авто-экстрактором,
   *  и их пункты нельзя применять (см. loadAssistantState). */
  version?: number
  constitution?: string[]
  janitorArchive?: JanitorArchiveEntry[]
}

/** Текущая версия схемы состояния мини-агентов. */
export const ASSISTANT_STATE_VERSION = 2

/** Хвост архива: достаточно для restore недавних компакций, не свалка. */
const MAX_ARCHIVE_ENTRIES = 50

function stateFile(userDataPath: string, chatId: string): string {
  const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(userDataPath, 'assistants-state', `${safe}.json`)
}

export interface LoadedAssistantState extends AssistantState {
  /** Состояние пришло из старой схемы и было вычищено — вызывающий должен
   *  перезаписать файл, иначе миграция повторится на следующем старте. */
  migrated: boolean
}

/**
 * Читает состояние чата. Миграция v1 → v2: пункты конституции, накопленные
 * авто-извлечением (regex по любому тексту + LLM в main), больше НЕ
 * применяются — их нельзя отличить от явных правил, а в контекст они
 * попадали без спроса. Архив джанитора сохраняется (он не про правила).
 */
export function loadAssistantState(userDataPath: string, chatId: string): LoadedAssistantState | null {
  try {
    const p = stateFile(userDataPath, chatId)
    if (!existsSync(p)) return null
    const raw = JSON.parse(readFileSync(p, 'utf8')) as AssistantState
    if (!raw || typeof raw !== 'object') return null
    if (raw.version === ASSISTANT_STATE_VERSION) return { ...raw, migrated: false }
    return {
      version: ASSISTANT_STATE_VERSION,
      constitution: [],
      janitorArchive: raw.janitorArchive ?? [],
      migrated: true,
    }
  } catch { /* битый файл — считаем пустым состоянием */ return null }
}

export function saveAssistantState(userDataPath: string, chatId: string, state: AssistantState): void {
  try {
    mkdirSync(join(userDataPath, 'assistants-state'), { recursive: true })
    const payload = {
      version: ASSISTANT_STATE_VERSION,
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
