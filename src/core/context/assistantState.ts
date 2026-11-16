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
