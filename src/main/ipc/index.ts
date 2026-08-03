import { ipcMain } from 'electron'
import { join } from 'path'
import { app } from 'electron'
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, existsSync, readFileSync, statSync } from 'fs'
import type Store from 'electron-store'
import type { MainWindow } from '../windows/MainWindow'
import type { OverlayWindow } from '../windows/OverlayWindow'
import type { VoiceWindow } from '../windows/VoiceWindow'
import type { SpotlightWindow } from '../windows/SpotlightWindow'
import type { TrayMenuWindow } from '../windows/TrayMenuWindow'

interface IPCContext {
  store: Store
  mainWindow: MainWindow
  overlayWindow: OverlayWindow
  voiceWindow: VoiceWindow
  spotlightWindow: SpotlightWindow
  trayMenuWindow: TrayMenuWindow
}

export function registerAllIPC(ctx: IPCContext): void {
  registerWindowIPC(ctx)
  registerSettingsIPC(ctx)
  registerSystemIPC(ctx)
  registerOverlayIPC(ctx)
  registerSpotlightIPC(ctx)
  registerTrayMenuIPC(ctx)
}

function registerWindowIPC({ mainWindow }: IPCContext): void {
  ipcMain.handle('window:hide', () => mainWindow.hide())
  ipcMain.handle('window:minimize', () => mainWindow.minimize())
  ipcMain.handle('window:show', () => mainWindow.show())
  ipcMain.handle('window:maximizeToggle', () => mainWindow.maximizeToggle())
  ipcMain.handle('window:isMaximized', () => mainWindow.isMaximized())
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
  // Папка = библиотека: юзер может держать несколько картинок и
  // переключаться между ними. Активная = bgImage.src.
  const bgDir = join(app.getPath('userData'), 'bg-images')

  // Защита от path traversal: убеждаемся, что filename не содержит
  // разделителей путей и резолвится внутри bgDir.
  function safeBgPath(filename: string): string | null {
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return null
    }
    const filepath = join(bgDir, filename)
    if (!filepath.startsWith(bgDir)) return null
    return filepath
  }

  ipcMain.handle('bgImage:save', async (_, data: Uint8Array, ext: string) => {
    try {
      if (!existsSync(bgDir)) mkdirSync(bgDir, { recursive: true })
      const filename = `bg-${Date.now()}.${ext || 'png'}`
      const filepath = join(bgDir, filename)
      writeFileSync(filepath, Buffer.from(data))
      return `bg-images://${filename}`
    } catch (e) {
      console.error('[bgImage:save]', e)
      return null
    }
  })

  ipcMain.handle('bgImage:list', async () => {
    try {
      if (!existsSync(bgDir)) return []
      return readdirSync(bgDir)
        .filter(f => !f.startsWith('.'))
        .map(f => {
          const filepath = join(bgDir, f)
          let size = 0, mtime = 0
          try { const st = statSync(filepath); size = st.size; mtime = st.mtimeMs } catch { /* ok */ }
          return { src: `bg-images://${f}`, name: f, size, mtime }
        })
        .sort((a, b) => b.mtime - a.mtime)
    } catch (e) {
      console.error('[bgImage:list]', e)
      return []
    }
  })

  ipcMain.handle('bgImage:delete', async (_, src: string) => {
    try {
      if (!src || !src.startsWith('bg-images://')) return false
      const filename = src.replace('bg-images://', '')
      const filepath = safeBgPath(filename)
      if (!filepath || !existsSync(filepath)) return false
      unlinkSync(filepath)
      return true
    } catch (e) {
      console.error('[bgImage:delete]', e)
      return false
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

  // ── Sound files persistence ───────────────────────────────────
  // Кастомные звуки интерфейса хранятся как файлы в userData/sounds/.
  // Схема та же что и bg-images: soundId = custom://<filename>.
  // Встроенные звуки (synth.*) генерируются через Web Audio API в renderer.
  const soundDir = join(app.getPath('userData'), 'sounds')

  function safeSoundPath(filename: string): string | null {
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return null
    }
    const filepath = join(soundDir, filename)
    if (!filepath.startsWith(soundDir)) return null
    return filepath
  }

  function extToMime(ext: string): string {
    return ext === 'mp3' ? 'audio/mpeg'
      : ext === 'wav' ? 'audio/wav'
      : ext === 'ogg' ? 'audio/ogg'
      : ext === 'm4a' ? 'audio/mp4'
      : 'audio/mpeg'
  }

  ipcMain.handle('sound:save', async (_, data: Uint8Array, ext: string, originalName?: string) => {
    try {
      if (!existsSync(soundDir)) mkdirSync(soundDir, { recursive: true })
      const safeExt = (ext || 'mp3').toLowerCase().replace(/[^a-z0-9]/g, '')
      // Имя файла: из оригинала (sanitized) или timestamp
      let base = `sound-${Date.now()}`
      if (originalName) {
        base = originalName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9а-яА-Я_-]/g, '_').slice(0, 40) || base
      }
      const filename = `${base}-${Date.now()}.${safeExt}`
      const filepath = join(soundDir, filename)
      writeFileSync(filepath, Buffer.from(data))
      return `custom://${filename}`
    } catch (e) {
      console.error('[sound:save]', e)
      return null
    }
  })

  ipcMain.handle('sound:list', async () => {
    try {
      if (!existsSync(soundDir)) return []
      return readdirSync(soundDir)
        .filter(f => !f.startsWith('.'))
        .map(f => {
          const filepath = join(soundDir, f)
          let size = 0, mtime = 0
          try { const st = statSync(filepath); size = st.size; mtime = st.mtimeMs } catch { /* ok */ }
          return { id: `custom://${f}`, name: f, size, mtime }
        })
        .sort((a, b) => b.mtime - a.mtime)
    } catch (e) {
      console.error('[sound:list]', e)
      return []
    }
  })

  ipcMain.handle('sound:load', async (_, id: string) => {
    if (!id || !id.startsWith('custom://')) return null
    try {
      const filename = id.replace('custom://', '')
      const filepath = safeSoundPath(filename)
      if (!filepath || !existsSync(filepath)) return null
      const buf = readFileSync(filepath)
      const base64 = buf.toString('base64')
      const ext = filename.split('.').pop()?.toLowerCase() || 'mp3'
      return `data:${extToMime(ext)};base64,${base64}`
    } catch (e) {
      console.error('[sound:load]', e)
      return null
    }
  })

  ipcMain.handle('sound:delete', async (_, id: string) => {
    try {
      if (!id || !id.startsWith('custom://')) return false
      const filename = id.replace('custom://', '')
      const filepath = safeSoundPath(filename)
      if (!filepath || !existsSync(filepath)) return false
      unlinkSync(filepath)
      return true
    } catch (e) {
      console.error('[sound:delete]', e)
      return false
    }
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

// ── Кастомное трей-меню ──────────────────────────────────────────────
// Действия меню выполняются в main-процессе (доступ к окнам), renderer
// только триггерит их по id и скрывает меню. openSettings показывает
// главное окно и шлёт ему nav-событие — App.tsx слушает и переключает
// страницу на settings.
function registerTrayMenuIPC({ trayMenuWindow, mainWindow, voiceWindow, spotlightWindow }: IPCContext): void {
  ipcMain.handle('tray-menu:hide', () => trayMenuWindow.hide())
  ipcMain.handle('tray-menu:getMeta', () => ({ version: app.getVersion() }))
  ipcMain.handle('tray-menu:action', (_, action: string) => {
    switch (action) {
      case 'showMain':
        mainWindow.show()
        break
      case 'showVoice':
        voiceWindow.show()
        break
      case 'showSpotlight':
        spotlightWindow.show()
        break
      case 'openSettings':
        mainWindow.show()
        mainWindow.getWindow()?.webContents.send('nav:open-settings')
        break
      case 'quit':
        app.exit(0)
        break
    }
  })
}
