import { ipcMain } from 'electron'
import type Store from 'electron-store/ts'
import type { MainWindow } from '../windows/MainWindow'
import type { OverlayWindow } from '../windows/OverlayWindow'
import type { VoiceWindow } from '../windows/VoiceWindow'
import type { SpotlightWindow } from '../windows/SpotlightWindow'

interface IPCContext {
  store: Store
  mainWindow: MainWindow
  overlayWindow: OverlayWindow
  voiceWindow: VoiceWindow
  spotlightWindow: SpotlightWindow
}

export function registerAllIPC(ctx: IPCContext): void {
  registerWindowIPC(ctx)
  registerSettingsIPC(ctx)
  registerSystemIPC(ctx)
  registerOverlayIPC(ctx)
  registerSpotlightIPC(ctx)
}

function registerWindowIPC({ mainWindow }: IPCContext): void {
  ipcMain.handle('window:hide', () => mainWindow.hide())
  ipcMain.handle('window:minimize', () => mainWindow.minimize())
  ipcMain.handle('window:show', () => mainWindow.show())
}

function registerSettingsIPC({ store }: IPCContext): void {
  ipcMain.handle('settings:get', (_, key: string) => store.get(key))
  ipcMain.handle('settings:set', (_, key: string, value: unknown) => {
    store.set(key, value)
  })
  ipcMain.handle('settings:getAll', () => store.store)
}

function registerSystemIPC(_ctx: IPCContext): void {
  const { app } = require('electron')
  ipcMain.handle('system:info', () => ({
    platform: process.platform,
    version: process.getSystemVersion(),
    appVersion: app.getVersion(),
  }))
  ipcMain.handle('system:logError', (_, message: string, stack?: string) => {
    console.error('[Renderer Error]', message, stack)
  })
}

function registerOverlayIPC({ overlayWindow }: IPCContext): void {
  ipcMain.handle('overlay:show', () => overlayWindow.show())
  ipcMain.handle('overlay:hide', () => overlayWindow.hide())
  ipcMain.handle('overlay:getDisplays', () => overlayWindow.getDisplaysInfo())
}

function registerSpotlightIPC({ spotlightWindow }: IPCContext): void {
  ipcMain.handle('spotlight:show', () => spotlightWindow.show())
  ipcMain.handle('spotlight:hide', () => spotlightWindow.hide())
  ipcMain.handle('spotlight:expand', () => spotlightWindow.expand())
  ipcMain.handle('spotlight:collapse', () => spotlightWindow.collapse())
}
