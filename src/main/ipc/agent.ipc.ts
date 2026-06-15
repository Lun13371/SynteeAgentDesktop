import { ipcMain, BrowserWindow } from 'electron'
import type Store from 'electron-store'
import { agentManager } from '../AgentManager'

const DEFAULT_AGENT_SETTINGS = {
  approvalMode: 'ask',
  maxSteps: 8,
  toolOutputMode: 'normal',
  enableThinking: false,
  maxParallelSubAgents: 3,
}

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

  // Отменить агента (id опциональный — без id отменяем все running)
  ipcMain.handle('agent:cancel', (_e, id?: string) => {
    if (id) {
      agentManager.cancel(id)
    } else {
      agentManager.getAll()
        .filter(a => a.status === 'running')
        .forEach(a => agentManager.cancel(a.id))
    }
    return { ok: true }
  })

  // Очистить агентов чата
  ipcMain.handle('agent:clearChat', (_e, chatId: string) => {
    agentManager.clearChat(chatId)
    return { ok: true }
  })

  // Настройки агента
  ipcMain.handle('agent:getSettings', () => {
    return store.get('agentSettings', DEFAULT_AGENT_SETTINGS)
  })

  ipcMain.handle('agent:setSettings', (_e, settings: unknown) => {
    store.set('agentSettings', settings)
    return { ok: true }
  })
}
