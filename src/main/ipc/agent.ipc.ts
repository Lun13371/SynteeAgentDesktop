import { ipcMain, BrowserWindow } from 'electron'
import type Store from 'electron-store'
import { Agent } from '../../core/agent/Agent'
import type { AgentSettings } from '../../shared/types'

const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  approvalMode: 'ask',
  maxSteps: 8,
  enableTools: true,
  toolOutputMode: 'normal',
}

export function registerAgentIPC(
  store: Store,
  getMainWin: () => BrowserWindow | null
): void {

  ipcMain.handle('agent:getSettings', () => {
    return store.get('agentSettings', DEFAULT_AGENT_SETTINGS) as AgentSettings
  })

  ipcMain.handle('agent:setSettings', (_, settings: Partial<AgentSettings>) => {
    const current = store.get('agentSettings', DEFAULT_AGENT_SETTINGS) as AgentSettings
    store.set('agentSettings', { ...current, ...settings })
  })

  ipcMain.handle('agent:run', async (_, userMessage: string) => {
    const win = getMainWin()
    const settings = store.get('agentSettings', DEFAULT_AGENT_SETTINGS) as AgentSettings
    const agent = new Agent(store)

    agent.run(userMessage, {
      onStep: (step) => win?.webContents.send('agent:step', step),
      onDone: (answer) => win?.webContents.send('agent:done', { answer }),
      onError: (err) => win?.webContents.send('agent:error', { error: err.message }),
      approvalMode: settings.approvalMode,
      onConfirm: (toolName, args) => new Promise<boolean>((resolve) => {
        if (!win) return resolve(true)
        const reqId = `${Date.now()}-${Math.random()}`
        win.webContents.send('agent:confirm', { reqId, toolName, args })
        ipcMain.once(`agent:confirm:response:${reqId}`, (_, approved: boolean) => {
          resolve(approved)
        })
        // Таймаут 60 сек — если нет ответа, отклоняем
        setTimeout(() => resolve(false), 60_000)
      }),
    }, settings.maxSteps)

    return { started: true }
  })

  ipcMain.handle('agent:cancel', () => {
    return { cancelled: true }
  })
}
