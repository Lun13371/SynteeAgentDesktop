import { ipcMain, BrowserWindow } from 'electron'
import type Store from 'electron-store'
import { Agent } from '../../core/agent/Agent'

export function registerAgentIPC(
  store: Store,
  getMainWin: () => BrowserWindow | null
): void {

  ipcMain.handle('agent:run', async (_, userMessage: string) => {
    const win = getMainWin()
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
    })

    return { started: true }
  })

  ipcMain.handle('agent:cancel', () => {
    // TODO: реализовать отмену через AbortController
    return { cancelled: true }
  })
}
