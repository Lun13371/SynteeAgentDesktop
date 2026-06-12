import { contextBridge, ipcRenderer } from 'electron'

// Типизированный API bridge для renderer
const synteeAPI = {
  // Окно
  window: {
    hide: () => ipcRenderer.invoke('window:hide'),
    minimize: () => ipcRenderer.invoke('window:minimize'),
    show: () => ipcRenderer.invoke('window:show'),
  },

  // Настройки
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
    getAll: () => ipcRenderer.invoke('settings:getAll'),
  },

  // Система
  system: {
    info: () => ipcRenderer.invoke('system:info'),
    logError: (message: string, stack?: string) =>
      ipcRenderer.invoke('system:logError', message, stack),
  },

  // Оверлей
  overlay: {
    show: () => ipcRenderer.invoke('overlay:show'),
    hide: () => ipcRenderer.invoke('overlay:hide'),
    getDisplays: () => ipcRenderer.invoke('overlay:getDisplays'),
    captureScreen: () => ipcRenderer.invoke('overlay:captureScreen'),
    analyze: (params: { imageBase64: string; prompt: string; action: string }) =>
      ipcRenderer.invoke('overlay:analyze', params),
    saveScreenshot: (base64: string) => ipcRenderer.invoke('overlay:saveScreenshot', base64),
  },

  // Spotlight
  spotlight: {
    show: () => ipcRenderer.invoke('spotlight:show'),
    hide: () => ipcRenderer.invoke('spotlight:hide'),
    expand: () => ipcRenderer.invoke('spotlight:expand'),
    collapse: () => ipcRenderer.invoke('spotlight:collapse'),
  },

  // Чат
  chat: {
    create: (incognito?: boolean) => ipcRenderer.invoke('chat:create', incognito),
    getAll: () => ipcRenderer.invoke('chat:getAll'),
    getMessages: (chatId: string) => ipcRenderer.invoke('chat:getMessages', chatId),
    send: (params: { chatId: string; content: string; incognito?: boolean }) =>
      ipcRenderer.invoke('chat:send', params),
    delete: (chatId: string) => ipcRenderer.invoke('chat:delete', chatId),
    rename: (chatId: string, title: string) => ipcRenderer.invoke('chat:rename', chatId, title),
    pin: (messageId: string) => ipcRenderer.invoke('chat:pin', messageId),
    unpin: (messageId: string) => ipcRenderer.invoke('chat:unpin', messageId),
    reloadClient: () => ipcRenderer.invoke('chat:reloadClient'),
  },

  // Агент
  agent: {
    run: (query: string) => ipcRenderer.invoke('agent:run', query),
    cancel: () => ipcRenderer.invoke('agent:cancel'),
  },

  // События (подписка)
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const handler = (_: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },

  off: (channel: string, callback: (...args: unknown[]) => void) => {
    ipcRenderer.removeAllListeners(channel)
  },

  once: (channel: string, callback: (...args: unknown[]) => void) => {
    ipcRenderer.once(channel, (_, ...args) => callback(...args))
  },
}

contextBridge.exposeInMainWorld('syntee', synteeAPI)

// Типы для TypeScript в renderer
export type SynteeAPI = typeof synteeAPI
