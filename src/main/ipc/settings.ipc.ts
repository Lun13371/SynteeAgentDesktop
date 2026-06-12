import { ipcMain } from 'electron'
import type Store from 'electron-store'

export function registerSettingsIPC(store: Store): void {
  ipcMain.handle('settings:getAll', () => store.store)
  ipcMain.handle('settings:get', (_, key: string) => store.get(key))
  ipcMain.handle('settings:set', (_, key: string, value: unknown) => {
    store.set(key, value)
    return true
  })
  ipcMain.handle('settings:reset', () => {
    store.clear()
    return true
  })
}
