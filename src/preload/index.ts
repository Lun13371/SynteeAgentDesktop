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
  },

  // Spotlight
  spotlight: {
    show: () => ipcRenderer.invoke('spotlight:show'),
    hide: () => ipcRenderer.invoke('spotlight:hide'),
    expand: () => ipcRenderer.invoke('spotlight:expand'),
    collapse: () => ipcRenderer.invoke('spotlight:collapse'),
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
