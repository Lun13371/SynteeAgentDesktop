/**
 * IPC для входа по ChatGPT-подписке (Codex).
 *
 * Каналы:
 *   codex:status        — текущее состояние (подключено, план, истечение)
 *   codex:login         — стартовать OAuth, открыть браузер, вернуть URL
 *   codex:loginManual   — завершить вход вставкой redirect-URL из браузера
 *   codex:cancelLogin   — отменить начатый вход
 *   codex:import        — импорт логина из ~/.codex/auth.json
 *   codex:logout        — забыть токены
 *   codex:probeModels   — проверить, какие модели реально доступны на плане
 *
 * Событие `codex:auth-changed` уходит во все окна после успешного входа.
 */
import { BrowserWindow, ipcMain, shell } from 'electron'
import {
  cancelCodexLogin,
  completeCodexLoginManual,
  forceRefreshCodexToken,
  getCodexAccessToken,
  getCodexAuthState,
  importCodexAuthFromCli,
  isCodexLoginPending,
  logoutCodex,
  onCodexAuthChanged,
  fetchCodexModels,
  startCodexLogin,
} from '../services/codexAuth'

export function registerCodexAuthIPC(): void {
  ipcMain.handle('codex:status', () => getCodexAuthState())

  ipcMain.handle('codex:login', async () => {
    const { url, autoCapture, port } = await startCodexLogin()
    try {
      await shell.openExternal(url)
    } catch (error) {
      console.error('[codexAuth] не удалось открыть браузер:', error)
    }
    return { url, autoCapture, port, pending: isCodexLoginPending() }
  })

  ipcMain.handle('codex:loginManual', async (_e, input: string) => completeCodexLoginManual(input))

  ipcMain.handle('codex:cancelLogin', () => {
    cancelCodexLogin()
    return { ok: true }
  })

  ipcMain.handle('codex:import', async () => importCodexAuthFromCli())

  ipcMain.handle('codex:logout', () => {
    logoutCodex()
    cancelCodexLogin()
    return getCodexAuthState()
  })

  ipcMain.handle('codex:token', async () => getCodexAccessToken())
  ipcMain.handle('codex:refresh', async () => forceRefreshCodexToken())

  // Живой каталог моделей подписки (бэкенд сам фильтрует по тарифу аккаунта).
  ipcMain.handle('codex:models', async () => fetchCodexModels())

  onCodexAuthChanged((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('codex:auth-changed', state)
    }
  })
}