import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import Store from 'electron-store'
import { DEFAULT_SETTINGS } from '../shared/constants'
import { MainWindow } from './windows/MainWindow'
import { OverlayWindow } from './windows/OverlayWindow'
import { VoiceWindow } from './windows/VoiceWindow'
import { SpotlightWindow } from './windows/SpotlightWindow'
import { TrayManager } from './tray/TrayManager'
import { HotkeyManager } from './hotkeys/HotkeyManager'
import { registerAllIPC } from './ipc'
import { registerChatIPC } from './ipc/chat.ipc'
import { registerOverlayIPC } from './ipc/overlay.ipc'
import { registerSettingsIPC } from './ipc/settings.ipc'
import { registerVoiceIPC } from './ipc/voice.ipc'
import { registerAgentIPC } from './ipc/agent.ipc'
import { registerMemoryIPC } from './ipc/memory.ipc'
import { registerProviderIPC } from './ipc/providers.ipc'
import { registerDebugIPC } from './ipc/debug.ipc'
import { registerImageIPC } from './ipc/image.ipc'
import { initModelCatalog, refreshCatalog } from '../core/tokens/modelCatalog'
import { ipcMain } from 'electron'

// Имя приложения — ДОЛЖНО быть ДО создания Store и app.whenReady
app.setName('SynteeHelper')

// Инициализируем store с дефолтными настройками
const store = new Store({ defaults: DEFAULT_SETTINGS, name: 'config', cwd: undefined })

// Глобальные окна
let mainWindow: MainWindow
let overlayWindow: OverlayWindow
let voiceWindow: VoiceWindow
let spotlightWindow: SpotlightWindow
let trayManager: TrayManager
let hotkeyManager: HotkeyManager

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.synteehelper.app')

  // Оптимизация dev tools
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Создаём окна
  mainWindow = new MainWindow(store)
  overlayWindow = new OverlayWindow()
  voiceWindow = new VoiceWindow()
  spotlightWindow = new SpotlightWindow()

  const main = mainWindow.create()
  overlayWindow.create()
  voiceWindow.create()
  spotlightWindow.create()

  // Трей
  trayManager = new TrayManager(store, {
    showMain: () => mainWindow.show(),
    showSpotlight: () => spotlightWindow.show(),
    showVoice: () => voiceWindow.show(),
    quit: () => app.quit(),
  })
  trayManager.init()

  // Горячие клавиши
  hotkeyManager = new HotkeyManager(store, {
    toggleMain: () => mainWindow.toggle(),
    showOverlay: () => overlayWindow.show(),
    toggleVoice: () => voiceWindow.toggle(),
    toggleSpotlight: () => spotlightWindow.toggle(),
    quickQuestion: () => spotlightWindow.showQuick(),
  })
  hotkeyManager.registerAll()

  // Каталог моделей (models.dev) — инициализируем из диск-кэша синхронно ДО IPC
  const catalogCachePath = join(app.getPath('userData'), 'modelsCatalog.json')
  initModelCatalog(catalogCachePath)
  // Фоновое обновление (не блокирует старт). Периодически — раз в 24ч.
  refreshCatalog(catalogCachePath).catch(() => { /* ok — работаем на кэше/fallback */ })
  setInterval(() => { refreshCatalog(catalogCachePath).catch(() => {}) }, 86_400_000)

  // IPC
  registerAllIPC({ store, mainWindow, overlayWindow, voiceWindow, spotlightWindow })
  registerChatIPC(store, mainWindow)
  registerOverlayIPC(store, overlayWindow)
  registerVoiceIPC(store, () => mainWindow.getWindow(), () => voiceWindow.getWindow())
  registerAgentIPC(store, () => mainWindow.getWindow())
  registerMemoryIPC(store)
  registerProviderIPC(store)
  registerDebugIPC(store)
  registerImageIPC(store, mainWindow)

  // Лёгкий обработчик оценки токенов текущего ввода (для live-обновления кольца при печати)
  ipcMain.handle('context:estimateInput', (_e, params: { text: string }) => {
    try {
      // estimateTokens импортируется ленично, чтобы не тащить tiktoken в main-бандл раньше времени
      const { estimateTokens } = require('../core/tokens/usageTracker') as typeof import('../core/tokens/usageTracker')
      return { tokens: estimateTokens(params.text || '') }
    } catch {
      return { tokens: 0 }
    }
  })

  // Первый запуск
  if (!store.get('firstRunComplete')) {
    await onFirstRun()
  }

  // Показываем главное окно
  main.once('ready-to-show', () => {
    main.show()
    const devtools = process.env.NODE_ENV === 'development'
      || process.env.ELECTRON_ENABLE_DEVTOOLS === '1'
      || process.argv.includes('--devtools')
    if (devtools) {
      main.webContents.openDevTools({ mode: 'detach' })
    }
  })
})

async function onFirstRun(): Promise<void> {
  const { mkdirSync } = await import('fs')
  const { join } = await import('path')
  const userData = app.getPath('userData')

  // Создаём нужные папки но НЕ ставим firstRunComplete —
  // это делает renderer после завершения онбординга
  const dirs = [
    join(userData, 'generated'),
    join(userData, 'recordings'),
    join(userData, 'backups'),
    join(userData, 'voices'),
    join(userData, 'screenshots'),
    join(userData, 'logs'),
  ]
  dirs.forEach(d => mkdirSync(d, { recursive: true }))
}

// Не закрывать при закрытии всех окон — живём в трее
app.on('window-all-closed', (e) => {
  e.preventDefault()
})

// Реальный выход (а не скрытие в трей) — сохраняем размер/позицию главного окна.
// 'close' на окне перехватывается для hide(), поэтому persistим здесь.
app.on('before-quit', () => {
  mainWindow?.flushBounds()
})

app.on('will-quit', () => {
  hotkeyManager?.unregisterAll()
})

app.on('activate', () => {
  mainWindow?.show()
})
