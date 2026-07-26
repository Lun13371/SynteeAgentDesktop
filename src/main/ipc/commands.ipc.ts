/**
 * IPC для кастомных slash-команд.
 *
 *   commands:list  — список custom-команд для UI (builtin из SLASH_COMMANDS
 *                    renderer добавляет сам через filterCommands).
 *                    Параметр: { projectWorkdir?: string }.
 *   commands:reload — сброс кэша (после правки .md-файлов).
 */
import { ipcMain } from 'electron'
import { getCommandManager } from '../../core/commands/commandManager'

export function registerCommandsIPC(): void {
  ipcMain.handle('commands:list', (_, params?: { projectWorkdir?: string }) => {
    try {
      return getCommandManager().getAllForUI({ projectWorkdir: params?.projectWorkdir })
    } catch (e) {
      console.error('[commands:list] error:', (e as Error).message)
      return []
    }
  })

  ipcMain.handle('commands:reload', () => {
    try {
      getCommandManager().invalidate()
      return true
    } catch (e) {
      console.error('[commands:reload] error:', (e as Error).message)
      return false
    }
  })
}
