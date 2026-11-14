/**
 * computeLiveChanges — правки файлов во время выполнения запроса (бейдж над
 * инпутом до CHAT_STREAM_DONE).
 *
 * Раньше здесь дублировался разбор diff-шагов, из-за чего правки, сделанные
 * ВНУТРИ execute_code, не попадали в живой бейдж: инструмент скрипта не
 * эмитит собственных tool_result-шагов. Теперь источник один —
 * collectFileChanges (shared), который учитывает и trace вложенных вызовов.
 *
 * Возвращает null если нет правок — бейдж не показывается.
 * userMessageId/assistantMessageId пустые (неизвестны до CHAT_STREAM_DONE).
 */
import { collectFileChanges } from '../../../shared/fileChanges'
import type { ToolStep, LastTurnChanges, LastTurnFileChange } from '../../../shared/types'

export function computeLiveChanges(steps: ToolStep[] | undefined | null): LastTurnChanges | null {
  if (!steps || steps.length === 0) return null

  const collected = collectFileChanges(steps)
  if (collected.length === 0) return null

  const files: LastTurnFileChange[] = collected.map(f => ({
    path: f.path,
    added: f.adds,
    deleted: f.dels,
  }))

  return {
    files,
    totalAdded: files.reduce((s, f) => s + f.added, 0),
    totalDeleted: files.reduce((s, f) => s + f.deleted, 0),
    userMessageId: '',
    assistantMessageId: '',
  }
}
