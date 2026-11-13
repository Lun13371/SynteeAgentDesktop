import { ipcMain } from 'electron'
import {
  getAssistantsSettings, updateAssistantsSettings,
  getAssistantLog, pruneAssistantLog,
  downloadAndStart, getAgentStats,
} from '../assistants/bridge'
import { localModels } from '../localModels/LocalModelManager'
import type { AssistantsSettings } from '../../shared/assistants'

export function registerAssistantsIPC(): void {
  ipcMain.handle('assistants:getSettings', () => getAssistantsSettings())

  ipcMain.handle('assistants:updateSettings', (_, patch: Partial<AssistantsSettings>) => {
    return updateAssistantsSettings(patch)
  })

  ipcMain.handle('assistants:getLog', (_, since?: number) => {
    pruneAssistantLog()
    return getAssistantLog(since)
  })

  ipcMain.handle('assistants:getStats', () => getAgentStats())

  ipcMain.handle('assistants:getStatus', () => {
    const s = localModels.getStatus()
    return {
      serverState: s.state,
      modelSize: s.modelSize,
      modelDownloaded: s.modelDownloaded,
      binaryReady: s.binaryReady,
      restarts: s.restarts,
      active: s.active,
      queueLength: s.queueLength,
      idleUnloaded: s.idleUnloaded,
      lastError: s.lastError,
    }
  })

  ipcMain.handle('assistants:setup', () => downloadAndStart())
  ipcMain.handle('assistants:downloadModel', () => downloadAndStart())
}