import { ipcMain } from 'electron'
import { join } from 'path'
import { app } from 'electron'
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, existsSync, readFileSync } from 'fs'
import type Store from 'electron-store'
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
  ipcMain.handle('settings:reset', () => { store.clear(); return true })

  // ── Background image persistence ──────────────────────────────
  // Картинки фона хранятся как файлы в userData/bg-images/, а не как
  // base64 dataURL в config.json (который раздувался бы мегабайтами).
  // settings.bgImage.src хранит путь к файлу (bg-images://filename).
  const bgDir = join(app.getPath('userData'), 'bg-images')

  ipcMain.handle('bgImage:save', async (_, data: Uint8Array, ext: string) => {
    try {
      if (!existsSync(bgDir)) mkdirSync(bgDir, { recursive: true })
      // Очищаем старые картинки — храним только одну активную
      try {
        for (const f of readdirSync(bgDir)) {
          unlinkSync(join(bgDir, f))
        }
      } catch { /* ok */ }
      const filename = `bg-${Date.now()}.${ext || 'png'}`
      const filepath = join(bgDir, filename)
      writeFileSync(filepath, Buffer.from(data))
      return `bg-images://${filename}`
    } catch (e) {
      console.error('[bgImage:save]', e)
      return null
    }
  })

  ipcMain.handle('bgImage:load', async (_, src: string) => {
    if (!src || !src.startsWith('bg-images://')) return null
    try {
      const filename = src.replace('bg-images://', '')
      const filepath = join(bgDir, filename)
      if (!existsSync(filepath)) return null
      const buf = readFileSync(filepath)
      const base64 = buf.toString('base64')
      // Определяем mime по расширению
      const ext = filename.split('.').pop()?.toLowerCase() || 'png'
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'webp' ? 'image/webp'
        : ext === 'gif' ? 'image/gif'
        : 'image/png'
      return `data:${mime};base64,${base64}`
    } catch (e) {
      console.error('[bgImage:load]', e)
      return null
    }
  })

  ipcMain.handle('bgImage:clear', async () => {
    try {
      if (!existsSync(bgDir)) return true
      for (const f of readdirSync(bgDir)) {
        unlinkSync(join(bgDir, f))
      }
      return true
    } catch { return false }
  })
}

function registerSystemIPC(_ctx: IPCContext): void {
  const { app, shell } = require('electron')
  ipcMain.handle('system:info', () => ({
    platform: process.platform,
    version: process.getSystemVersion(),
    appVersion: app.getVersion(),
  }))
  ipcMain.handle('system:logError', (_, message: string, stack?: string) => {
    console.error('[Renderer Error]', message, stack)
  })
  ipcMain.handle('shell:openPath', (_, path: string) => shell.openPath(path))

  ipcMain.handle('extensions:getPaths', () => {
    const { app } = require('electron')
    const { join } = require('path')
    const { homedir } = require('os')
    return {
      mcpConfig: join(homedir(), '.syntee', 'mcp.json'),
      mcpConfigDir: join(homedir(), '.syntee'),
      skillsUserDir: join(app.getPath('userData'), 'skills'),
      skillsBuiltinDir: join(process.resourcesPath ?? app.getAppPath(), 'skills'),
    }
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
