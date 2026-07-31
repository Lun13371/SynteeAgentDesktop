import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import TrayMenuApp from './pages/TrayMenu/TrayMenuApp'
import './styles/fonts.css'
import './styles/globals.css'
import '@xterm/xterm/css/xterm.css'

// Типизация window.syntee
declare global {
  interface Window {
    syntee: import('../../preload/index').SynteeAPI
  }
}

// Трей-меню — отдельное лёгкое окно (#/tray-menu). Рендерим TrayMenuApp
// НАПРЯМУЮ, минуя App, чтобы не запускать messenger WS / gateway polling /
// chat preload в этом окне (это frameless-меню, ему нужен только UI).
function isTrayMenuRoute(): boolean {
  return window.location.hash.replace('#/', '') === 'tray-menu'
}

// Заглушка для браузерного режима (вне Electron)
if (!window.syntee) {
  const noop = () => Promise.resolve()
  const mockStore: Record<string, unknown> = {
    theme: 'dark', accentColor: '#ffffff', userName: '',
    apiKey: '', apiEndpoint: '',
    mainModel: 'claude-sonnet-4-6', sidebarOpen: true,
    firstRunComplete: true,
  }
  window.syntee = {
    window: { hide: noop, minimize: noop, show: noop },
    settings: {
      get: (key: string) => Promise.resolve(mockStore[key]),
      set: (key: string, val: unknown) => { mockStore[key] = val; return Promise.resolve() },
      getAll: () => Promise.resolve(mockStore),
    },
    bgImage: {
      save: () => Promise.resolve(null),
      load: () => Promise.resolve(null),
      clear: () => Promise.resolve(true),
    },
    system: {
      info: () => Promise.resolve({ platform: 'win32', version: '10', appVersion: '0.1.0' }),
      logError: noop,
    },
    overlay: { show: noop, hide: noop, getDisplays: () => Promise.resolve([]),
      captureScreen: () => Promise.resolve([]),
      analyze: noop, saveScreenshot: () => Promise.resolve('') },
    spotlight: { show: noop, hide: noop, expand: noop, collapse: noop },
    trayMenu: { hide: noop, action: noop, getMeta: () => Promise.resolve({ version: '0.0.0' }) },
    voice: { start: noop, stop: noop },
    chat: {
      getAll: () => Promise.resolve([]),
      create: () => Promise.resolve({ id: 'mock', title: 'Новый чат', createdAt: Date.now(), isIncognito: 0, isPinned: 0 }),
      getMessages: () => Promise.resolve([]),
      send: () => Promise.resolve(null),
      delete: noop,
      rename: noop,
      pin: noop,
      unpin: noop,
      reloadClient: noop,
    },
    memory: {
      getAll: () => Promise.resolve([]),
      save: () => Promise.resolve(null),
      delete: () => Promise.resolve(true),
      search: () => Promise.resolve([]),
    },
    agent: {
      run: () => Promise.resolve({ started: true }),
      cancel: () => Promise.resolve({ cancelled: true }),
    },
    on: (_ch: string, _cb: (...args: unknown[]) => void) => () => {},
    off: noop,
    once: noop,
  } as unknown as typeof window.syntee
}

// Предотвращаем навигацию окна при drag&drop файлов из ОС.
// Без этого Electron открывает file:// URL вместо drop-события.
// Chat-input-box имеет собственные handlers (с stopPropagation), поэтому
// эти document-level listeners срабатывают только для drop вне инпута.
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => e.preventDefault())

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isTrayMenuRoute() ? <TrayMenuApp /> : <App />}
  </React.StrictMode>
)
