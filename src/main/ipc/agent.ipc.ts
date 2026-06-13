import { ipcMain, BrowserWindow } from 'electron'
import type Store from 'electron-store'
import { agentManager } from '../AgentManager'

export function registerAgentIPC(store: Store, getWindow: () => BrowserWindow | null) {
  // Инициализируем AgentManager
  agentManager.init(store)
  const win = getWindow()
  if (win) agentManager.registerWindow(win)

  // Получить список всех агентов
  ipcMain.handle('agent:list', () => agentManager.getAll())

  // Получить конкретного агента
  ipcMain.handle('agent:get', (_e, id: string) => agentManager.get(id) ?? null)

  // Получить дочерних агентов
  ipcMain.handle('agent:children', (_e, parentId: string) => agentManager.getChildren(parentId))

  // Отменить агента
  ipcMain.handle('agent:cancel', (_e, id: string) => {
    agentManager.cancel(id)
    return { ok: true }
  })

  // Очистить агентов чата
  ipcMain.handle('agent:clearChat', (_e, chatId: string) => {
    agentManager.clearChat(chatId)
    return { ok: true }
  })
}
