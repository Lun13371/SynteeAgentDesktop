import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/globals.css'

// Типизация window.syntee
declare global {
  interface Window {
    syntee: import('../../preload/index').SynteeAPI
  }
}

// Заглушка для браузерного режима (вне Electron)
if (!window.syntee) {
  const noop = () => Promise.resolve()
  const mockStore: Record<string, unknown> = {
    theme: 'dark', accentColor: '#ffffff', userName: '',
    apiKey: '', apiEndpoint: 'https://api.onlysq.ru/ai/openai',
    mainModel: 'claude-sonnet-4-6', sidebarOpen: true,
  }
  window.syntee = {
    window: { hide: noop, minimize: noop, show: noop },
    settings: {
      get: (key: string) => Promise.resolve(mockStore[key]),
      set: (key: string, val: unknown) => { mockStore[key] = val; return Promise.resolve() },
      getAll: () => Promise.resolve(mockStore),
    },
    system: {
      info: () => Promise.resolve({ platform: 'win32', version: '10', appVersion: '0.1.0' }),
      logError: noop,
    },
    overlay: { show: noop, hide: noop, getDisplays: () => Promise.resolve([]),
      captureScreen: () => Promise.resolve([]),
      analyze: noop, saveScreenshot: () => Promise.resolve('') },
    spotlight: { show: noop, hide: noop, expand: noop, collapse: noop },
    voice: { start: noop, stop: noop },
    chat: {
      create: () => Promise.resolve({ id: 'demo-' + Date.now(), title: 'Новый чат', createdAt: Date.now(), updatedAt: Date.now(), isIncognito: 0, messageCount: 0 }),
      getAll: () => Promise.resolve([]),
      getMessages: () => Promise.resolve([]),
      send: noop,
      delete: noop,
      rename: noop,
      pin: noop,
      unpin: noop,
      reloadClient: noop,
    },
    on: (_ch: string, _cb: (...args: unknown[]) => void) => () => {},
    off: noop,
    once: noop,
  } as unknown as typeof window.syntee
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
