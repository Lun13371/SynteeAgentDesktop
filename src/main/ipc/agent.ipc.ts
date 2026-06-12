import { ipcMain, BrowserWindow } from 'electron'
import type Store from 'electron-store'
import { Agent } from '../../core/agent/Agent'
import type { AgentSettings } from '../../shared/types'

const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  approvalMode: 'ask',
  maxSteps: 8,
  enableTools: true,
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
      onStep: (step) => {
        win?.webContents.send('agent:step', step)
      },
      onDone: (answer) => {
        win?.webContents.send('agent:done', { answer })
      },
      onError: (err) => {
        win?.webContents.send('agent:error', { error: err.message })
      },
      // approval mode передаём для будущего use: сейчас auto/full — выполняем,
      // ask — фронт должен показать confirm перед отправкой
      approvalMode: settings.approvalMode,
    }, settings.maxSteps)

    return { started: true }
  })

  ipcMain.handle('agent:cancel', () => {
    return { cancelled: true }
  })
}
