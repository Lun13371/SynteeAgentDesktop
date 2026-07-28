import { app } from 'electron'
import { join } from 'path'

// ── ВАЖНО: setPath ДО любых импортов которые создают electron-store ──
// electron-store при создании читает app.getPath('userData'). Если запустить
// electron.exe напрямую (не packaged), userData = AppData\Roaming\Electron\
// вместо AppData\Roaming\SynteeHelper\. setPath фиксит это, но должен
// выполниться ДО импорта tokenStore/gatewayClient (они создают Store при
// импорте). Поэтому setPath — первое что выполняется в модуле.
app.setName('SynteeHelper')
app.setPath('userData', join(app.getPath('appData'), 'SynteeHelper'))

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
import { registerVoiceIPC } from './ipc/voice.ipc'
import { registerAgentIPC } from './ipc/agent.ipc'
import { registerMemoryIPC } from './ipc/memory.ipc'
import { registerProviderIPC } from './ipc/providers.ipc'
import { registerDebugIPC } from './ipc/debug.ipc'
import { registerImageIPC } from './ipc/image.ipc'
import { stopAllWatchers as stopAllFastContextWatchers } from '../core/context/fastContextWatcher'
import { registerFsIPC } from './ipc/fs.ipc'
import { registerGitIPC } from './ipc/git.ipc'
import { registerSkillsIPC } from './ipc/skills.ipc'
import { registerMcpIPC } from './ipc/mcp.ipc'
import { registerMarketplaceIPC } from './ipc/marketplace.ipc'
import { registerPtyIPC } from './ipc/pty.ipc'
import { registerFastContextIPC } from './ipc/fastContext.ipc'
import { registerCommandsIPC } from './ipc/commands.ipc'
import { registerMentionsIPC, shutdownMentions } from './ipc/mentions.ipc'
import { registerAuthIPC, registerDeepLinks } from './ipc/auth.ipc'
import { registerGatewayIPC } from './ipc/gateway.ipc'
import { registerBillingIPC } from './ipc/billing.ipc'
import { registerMessengerIPC } from './ipc/messenger.ipc'
import { initModelCatalog, refreshCatalog } from '../core/tokens/modelCatalog'
import { initSkillManager } from '../core/skills/skillManager'
import { initCommandManager } from '../core/commands/commandManager'
import { initMcpManager } from '../core/mcp/McpManager'
import { migrateGlobalMcpToFile } from '../core/mcp/mcpConfig'
import { ptyManager } from './PtyManager'
import { ipcMain } from 'electron'

// Single-instance lock — обязателен для deep-link flow (synteehelper://).
// Второй запуск с deep-link URL приходит в событие second-instance.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

// Инициализируем store с дефолтными настройками.
// Явно указываем generic <Record<string, unknown>> — без него TS выводит тип
// из DEFAULT_SETTINGS (конкретная форма объекта), и store перестаёт быть
// совместим с сигнатурами register*IPC(store: Store), которые типизированы
// через `import type Store from 'electron-store'` (дефолтный generic —
// Record<string, unknown>).
const store = new Store<Record<string, unknown>>({ defaults: DEFAULT_SETTINGS, name: 'config', cwd: undefined })

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
  trayManager = new TrayManager({
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

  // Skills-менеджер (загрузка .md-скиллов, состояние вкл/выкл, scope).
  // Инициализируем ДО IPC — handlers используют getSkillManager().
  initSkillManager(store)

  // Commands-менеджер (загрузка .md-кастомных slash-команд). Также до IPC.
  initCommandManager()

  // Миграция: переносим старые глобальные MCP из electron-store в файл
  // ~/.syntee/mcp.json (чтобы агент мог редактировать их через edit_file).
  migrateGlobalMcpToFile(store)

  // MCP-менеджер (подключение серверов, тулы, approval). Также до IPC.
  const mcpManager = initMcpManager(store)
  mcpManager.setWindow(mainWindow.getWindow())
  // Прогреваем включённые глобальные серверы сразу при старте приложения,
  // в фоне (не await — не блокирует запуск). Раньше подключение было чисто
  // lazy (при первом chat:send) — это делало ПЕРВОЕ сообщение в любом чате
  // синхронно зависающим на холодном старте stdio-процесса.
  mcpManager.warmupGlobalServers()

  // IPC
  registerAllIPC({ store, mainWindow, overlayWindow, voiceWindow, spotlightWindow })
  registerChatIPC(store, mainWindow)
  registerOverlayIPC(store, overlayWindow)
  registerVoiceIPC(store, () => mainWindow.getWindow())
  registerAgentIPC(store, () => mainWindow.getWindow())
  registerMemoryIPC(store)
  registerProviderIPC(store)
  registerDebugIPC(store)
  registerImageIPC(store, mainWindow)
  registerFsIPC()
  registerGitIPC()
  registerSkillsIPC(store)
  registerMcpIPC(store, () => mainWindow.getWindow())
  registerMarketplaceIPC(store)
  registerPtyIPC(mainWindow)
  registerFastContextIPC(store, () => mainWindow.getWindow())
  registerCommandsIPC()
  registerMentionsIPC()

  // Syntee-Gateway auth + profile + deep-link (synteehelper://)
  registerDeepLinks(() => mainWindow.getWindow())
  registerAuthIPC(() => mainWindow.getWindow())
  // Syntee-Gateway models & status (фаза 2)
  registerGatewayIPC()
  // Syntee-Gateway биллинг (фаза 3)
  registerBillingIPC()
  // Syntee-Gateway мессенджер: друзья + ЛС (фаза 1)
  registerMessengerIPC(() => mainWindow.getWindow())

  // PTY-менеджер: фиксируем sender для стриминга данных в renderer.
  ptyManager.setSender(mainWindow.getWindow())

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
    join(userData, 'sounds'),
  ]
  dirs.forEach(d => mkdirSync(d, { recursive: true }))
}

// Не закрывать при закрытии всех окон — живём в трее.
// window-all-closed не передаёт Event и не имеет preventDefault (в отличие
// от will-quit) — просто подписка на событие уже отключает Electron'овское
// поведение "quit по умолчанию", вызывать preventDefault не нужно и раньше
// это было опечаткой, из-за которой tsc не мог сматчить сигнатуру listener'а.
app.on('window-all-closed', () => {})

// Реальный выход (а не скрытие в трей) — сохраняем размер/позицию главного окна.
// 'close' на окне перехватывается для hide(), поэтому persistim здесь.
app.on('before-quit', () => {
  mainWindow?.flushBounds()
  ptyManager.killAll()
  // Останавливаем все fast context watchers (chokidar) — иначе process может зависеть.
  stopAllFastContextWatchers().catch(() => { /* watchers опциональны */ })
  // Останавливаем file indexer для @mention-пикера.
  shutdownMentions().catch(() => { /* indexer опционален */ })
})

app.on('will-quit', () => {
  hotkeyManager?.unregisterAll()
})

app.on('activate', () => {
  mainWindow?.show()
})
