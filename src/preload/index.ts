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
    pin: (messageId: string) => ipcRenderer.invoke('chat:pinMsg', messageId),
    unpin: (messageId: string) => ipcRenderer.invoke('chat:unpinMsg', messageId),
    reloadClient: () => ipcRenderer.invoke('chat:reloadClient'),
    stop: () => ipcRenderer.invoke('chat:stop'),
    archive: (chatId: string, archived: boolean) => ipcRenderer.invoke('chat:archive', chatId, archived),
    pinChat: (chatId: string, pinned: boolean) => ipcRenderer.invoke('chat:pinChat', chatId, pinned),
    setColor: (chatId: string, color: string | null) => ipcRenderer.invoke('chat:setColor', chatId, color),
    duplicate: (chatId: string) => ipcRenderer.invoke('chat:duplicate', chatId),
    export: (chatId: string, format: 'txt' | 'md') => ipcRenderer.invoke('chat:export', chatId, format),
  },

  // Память
  memory: {
    getAll: (category?: string) => ipcRenderer.invoke('memory:getAll', category),
    save: (entry: unknown) => ipcRenderer.invoke('memory:save', entry),
    delete: (id: string) => ipcRenderer.invoke('memory:delete', id),
    search: (query: string) => ipcRenderer.invoke('memory:search', query),
  },

  // Агент
  agent: {
    run: (query: string) => ipcRenderer.invoke('agent:run', query),
    cancel: () => ipcRenderer.invoke('agent:cancel'),
    getSettings: () => ipcRenderer.invoke('agent:getSettings'),
    setSettings: (s: unknown) => ipcRenderer.invoke('agent:setSettings', s),
    onConfirm: (cb: (data: { reqId: string; toolName: string; args: unknown }) => void) => {
      ipcRenderer.on('agent:confirm', (_, data) => cb(data))
    },
    confirmResponse: (reqId: string, approved: boolean) => {
      ipcRenderer.send(`agent:confirm:response:${reqId}`, approved)
    },
  },

  // Провайдеры и модели
  providers: {
    getAll: () => ipcRenderer.invoke('providers:getAll'),
    save: (provider: unknown) => ipcRenderer.invoke('providers:save', provider),
    delete: (id: string) => ipcRenderer.invoke('providers:delete', id),
    testKey: (providerId: string) => ipcRenderer.invoke('providers:testKey', providerId),
    fetchModels: (providerId: string) => ipcRenderer.invoke('providers:fetchModels', providerId),
  },

  // Счётчик контекста
  context: {
    calculate: (params: { chatId: string; currentInput: string; modelId: string; incognito?: boolean }) =>
      ipcRenderer.invoke('context:calculate', params),
  },

  models: {
    getAll: () => ipcRenderer.invoke('models:getAll'),
    saveCustom: (model: unknown) => ipcRenderer.invoke('models:saveCustom', model),
    deleteCustom: (modelId: string, providerId: string) => ipcRenderer.invoke('models:deleteCustom', modelId, providerId),
    getAssignments: () => ipcRenderer.invoke('models:getAssignments'),
    setAssignment: (assignment: unknown) => ipcRenderer.invoke('models:setAssignment', assignment),
    getParams: () => ipcRenderer.invoke('models:getParams'),
    setParams: (params: unknown) => ipcRenderer.invoke('models:setParams', params),
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

  // Диагностика — вызывается из DevTools консоли:
  // window.syntee.debug.streamTest().then(r => console.log(JSON.stringify(r, null, 2)))
  debug: {
    streamTest: () => ipcRenderer.invoke('debug:stream-test'),
    openDevTools: () => ipcRenderer.invoke('debug:open-devtools'),
  },
}

contextBridge.exposeInMainWorld('syntee', synteeAPI)

// Типы для TypeScript в renderer
export type SynteeAPI = typeof synteeAPI
