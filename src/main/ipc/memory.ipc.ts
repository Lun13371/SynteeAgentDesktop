import { ipcMain } from 'electron'
import type Store from 'electron-store'
import {
  saveMemory, getMemories, deleteMemory, searchMemories
} from '../../core/memory/MemoryEngine'

export function registerMemoryIPC(_store: Store): void {
  ipcMain.handle('memory:getAll', (_, category?: string) => getMemories(category))

  ipcMain.handle('memory:save', (_, entry) => saveMemory(entry))

  ipcMain.handle('memory:delete', (_, id: string) => {
    deleteMemory(id)
    return true
  })

  ipcMain.handle('memory:search', (_, query: string) => searchMemories(query))
}
