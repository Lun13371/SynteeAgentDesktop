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

// Инициализируем store с дефолтными настройками
const store = new Store({ defaults: DEFAULT_SETTINGS })

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

  // IPC
  registerAllIPC({ store, mainWindow, overlayWindow, voiceWindow, spotlightWindow })
  registerChatIPC(store, mainWindow)
  registerOverlayIPC(store, overlayWindow)

  // Первый запуск
  if (!store.get('firstRunComplete')) {
    await onFirstRun()
  }

  // Показываем главное окно
  main.once('ready-to-show', () => {
    main.show()
    if (process.env.NODE_ENV === 'development') {
      main.webContents.openDevTools({ mode: 'detach' })
    }
  })
})

async function onFirstRun(): Promise<void> {
  const { mkdirSync } = await import('fs')
  const { join } = await import('path')
  const userData = app.getPath('userData')

  const dirs = [
    join(userData, 'generated'),
    join(userData, 'recordings'),
    join(userData, 'backups'),
    join(userData, 'voices'),
    join(userData, 'screenshots'),
    join(userData, 'logs'),
  ]
  dirs.forEach(d => mkdirSync(d, { recursive: true }))
  store.set('firstRunComplete', true)
  store.set('firstRunDate', Date.now())
}

// Не закрывать при закрытии всех окон — живём в трее
app.on('window-all-closed', (e) => {
  e.preventDefault()
})

app.on('will-quit', () => {
  hotkeyManager?.unregisterAll()
})

app.on('activate', () => {
  mainWindow?.show()
})
