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
    create: (incognito?: boolean, mode?: 'code' | 'work', projectId?: string) => ipcRenderer.invoke('chat:create', incognito, mode, projectId),
    getAll: () => ipcRenderer.invoke('chat:getAll'),
    getMessages: (chatId: string) => ipcRenderer.invoke('chat:getMessages', chatId),
    send: (params: { chatId: string; content: string; incognito?: boolean; mode?: 'code' | 'work' }) =>
      ipcRenderer.invoke('chat:send', params),
    delete: (chatId: string) => ipcRenderer.invoke('chat:delete', chatId),
    rename: (chatId: string, title: string) => ipcRenderer.invoke('chat:rename', chatId, title),
    pin: (messageId: string) => ipcRenderer.invoke('chat:pinMsg', messageId),
    unpin: (messageId: string) => ipcRenderer.invoke('chat:unpinMsg', messageId),
    reloadClient: () => ipcRenderer.invoke('chat:reloadClient'),
    stop: (chatId?: string) => ipcRenderer.invoke('chat:stop', chatId),
    getLiveState: (chatId: string) => ipcRenderer.invoke('chat:getLiveState', chatId),
    archive: (chatId: string, archived: boolean) => ipcRenderer.invoke('chat:archive', chatId, archived),
    pinChat: (chatId: string, pinned: boolean) => ipcRenderer.invoke('chat:pinChat', chatId, pinned),
    setColor: (chatId: string, color: string | null) => ipcRenderer.invoke('chat:setColor', chatId, color),
    duplicate: (chatId: string) => ipcRenderer.invoke('chat:duplicate', chatId),
    export: (chatId: string, format: 'txt' | 'md') => ipcRenderer.invoke('chat:export', chatId, format),
    // ── Очередь запросов чата ──
    // getQueue возвращает meta ожидающих запросов (без активного).
    // queueRemove убирает запрос из очереди по queueId.
    // queueReorder переставляет очередь под новый порядок queueId.
    getQueue: (chatId: string) => ipcRenderer.invoke('chat:getQueue', chatId),
    queueRemove: (chatId: string, queueId: string) => ipcRenderer.invoke('chat:queueRemove', chatId, queueId),
    queueReorder: (chatId: string, queueIds: string[]) => ipcRenderer.invoke('chat:queueReorder', chatId, queueIds),
    // ── Checkpoint / rewind ──
    // getSessionTimeline — список всех точек отката чата (для правой панели).
    // getLastTurnFilesChanged — кол-во файлов в последнем turn'е (для badge).
    // rewindTo — откатить сессию к указанному user-сообщению.
    getSessionTimeline: (chatId: string) => ipcRenderer.invoke('chat:getSessionTimeline', chatId),
    getLastTurnFilesChanged: (chatId: string) => ipcRenderer.invoke('chat:getLastTurnFilesChanged', chatId),
    rewindTo: (chatId: string, userMessageId: string) => ipcRenderer.invoke('chat:rewindTo', chatId, userMessageId),
    redo: (chatId: string, rewindMessageId: string) => ipcRenderer.invoke('chat:redo', chatId, rewindMessageId),
    canRedo: (chatId: string, rewindMessageId: string) => ipcRenderer.invoke('chat:canRedo', chatId, rewindMessageId),
    // ── Параллельный доп-чат (side chat) ──
    // Эфемерный чат-в-чате: incognito, не пишется в БД. ИИ получает сводку
    // родителя + тул get_main_chat_messages. chatId = 'sidechat:'+parentChatId.
    sideSend: (params: { parentChatId: string; content: string; sideMessages: unknown[] }) =>
      ipcRenderer.invoke('chat:sideSend', params),
  },

  // Проекты (рабочие директории) — сущность верхнего уровня над чатами.
  // Проект = папка + зафиксированный скан. Чаты создаются внутри проекта.
  projects: {
    pickWorkdir: () => ipcRenderer.invoke('projects:pickWorkdir'),
    pickNewWorkdir: () => ipcRenderer.invoke('projects:pickNewWorkdir'),
    create: (workdir: string) => ipcRenderer.invoke('projects:create', workdir),
    getAll: () => ipcRenderer.invoke('projects:getAll'),
    rename: (id: string, name: string) => ipcRenderer.invoke('projects:rename', id, name),
    delete: (id: string) => ipcRenderer.invoke('projects:delete', id),
    getById: (id: string) => ipcRenderer.invoke('projects:getById', id),
    touch: (id: string) => ipcRenderer.invoke('projects:touch', id),
    setVerificationCommand: (id: string, command: string | null) => ipcRenderer.invoke('projects:setVerificationCommand', id, command),
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
    cancel: (id?: string) => ipcRenderer.invoke('agent:cancel', id),
    list: () => ipcRenderer.invoke('agent:list'),
    get: (id: string) => ipcRenderer.invoke('agent:get', id),
    children: (parentId: string) => ipcRenderer.invoke('agent:children', parentId),
    clearChat: (chatId: string) => ipcRenderer.invoke('agent:clearChat', chatId),
    getSettings: () => ipcRenderer.invoke('agent:getSettings'),
    setSettings: (s: unknown) => ipcRenderer.invoke('agent:setSettings', s),
    onConfirm: (cb: (data: { reqId: string; toolName: string; args: unknown; dangerLevel?: string; dangerReason?: string; previewDiff?: string }) => void) => {
      const wrapper = (_: unknown, data: unknown) => cb(data as { reqId: string; toolName: string; args: unknown; dangerLevel?: string; dangerReason?: string; previewDiff?: string })
      ipcRenderer.on('agent:confirm', wrapper)
      return wrapper  // возвращаем wrapper для последующего offConfirm
    },
    offConfirm: (wrapper: (...args: unknown[]) => void) => {
      ipcRenderer.removeListener('agent:confirm', wrapper)
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
    estimateInput: (params: { text: string }) =>
      ipcRenderer.invoke('context:estimateInput', params),
    calculate: (chatId: string) =>
      ipcRenderer.invoke('context:calculate', chatId),
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

  // callback не используется — removeAllListeners снимает все подписки на
  // канал сразу, без разбора по конкретной функции. Параметр оставлен в
  // сигнатуре для симметрии с on()/once() в публичном preload-контракте.
  off: (channel: string, _callback: (...args: unknown[]) => void) => {
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

  // Генерация изображений
  image: {
    generate: (params: unknown) => ipcRenderer.invoke('image:generate', params),
    getSettings: () => ipcRenderer.invoke('image:getSettings'),
    setSettings: (s: unknown) => ipcRenderer.invoke('image:setSettings', s),
  },

  // Shell
  shell: {
    openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
    getExtensionsPaths: () => ipcRenderer.invoke('extensions:getPaths'),
  },

  // Файловый просмотрщик (read-only) для правой панели
  fs: {
    getWorkdir: (chatId: string) => ipcRenderer.invoke('fs:getWorkdir', chatId),
    listDirectory: (params: { root: string; relPath?: string; maxEntries?: number }) =>
      ipcRenderer.invoke('fs:listDirectory', params),
    readFile: (params: { root: string; relPath: string; maxBytes?: number }) =>
      ipcRenderer.invoke('fs:readFile', params),
  },

  // Git-статус для правой панели
  git: {
    status: (workdir: string) => ipcRenderer.invoke('git:status', workdir),
    diff: (params: { workdir: string; file?: string; staged?: boolean }) =>
      ipcRenderer.invoke('git:diff', params),
    show: (params: { workdir: string; hash: string; file?: string }) =>
      ipcRenderer.invoke('git:show', params),
    log: (params: { workdir: string; limit?: number }) =>
      ipcRenderer.invoke('git:log', params),
    branch: (workdir: string) => ipcRenderer.invoke('git:branch', workdir),
    isRepo: (workdir: string) => ipcRenderer.invoke('git:isRepo', workdir),
  },

  // Skills — markdown-инструкции в system prompt.
  // getAll — все скиллы (с состоянием) для popover; projectId опционально.
  // setState — обновить enabled/scope скилла.
  // reload — сбросить кэш и перечитать .md с диска.
  // getActive — активные скиллы для конкретного чата (для бейджа).
  skills: {
    getAll: (params?: { projectId?: string }) => ipcRenderer.invoke('skills:getAll', params),
    setState: (params: { skillId: string; state: unknown; source: 'builtin' | 'user' | 'project' }) =>
      ipcRenderer.invoke('skills:setState', params),
    reload: () => ipcRenderer.invoke('skills:reload'),
    getActive: (params: { chatId: string; isIncognito?: boolean }) =>
      ipcRenderer.invoke('skills:getActive', params),
    installFromUrl: (params: { url: string; scope: 'global' | { workdir: string } }) =>
      ipcRenderer.invoke('skills:installFromUrl', params),
  },

  // MCP (Model Context Protocol) — внешние серверы с инструментами.
  // getAll — все серверы с runtime-состоянием (для popover).
  // save/delete — CRUD глобальных серверов.
  // connect/disconnect/reconnect — управление подключением.
  // setServerState — enabled/scope сервера.
  // setToolState — per-tool enabled/requireApproval.
  mcp: {
    getAll: (params?: { projectId?: string }) => ipcRenderer.invoke('mcp:getAll', params),
    getActiveForChat: (params: { chatId: string; isIncognito?: boolean }) =>
      ipcRenderer.invoke('mcp:getActiveForChat', params),
    save: (config: unknown) => ipcRenderer.invoke('mcp:save', config),
    delete: (id: string) => ipcRenderer.invoke('mcp:delete', id),
    connect: (serverId: string) => ipcRenderer.invoke('mcp:connect', serverId),
    disconnect: (serverId: string) => ipcRenderer.invoke('mcp:disconnect', serverId),
    reconnect: (serverId: string) => ipcRenderer.invoke('mcp:reconnect', serverId),
    setServerState: (params: { serverId: string; enabled?: boolean; scope?: unknown }) =>
      ipcRenderer.invoke('mcp:setServerState', params),
    setToolState: (params: { serverId: string; toolFullName: string; state: unknown }) =>
      ipcRenderer.invoke('mcp:setToolState', params),
    installDirect: (params: {
      name: string
      transport: 'stdio' | 'sse' | 'streamable-http'
      command?: string
      args?: string[]
      env?: Record<string, string>
      url?: string
      headers?: Record<string, string>
      scope: 'global' | { workdir: string }
    }) => ipcRenderer.invoke('mcp:installDirect', params),
    updateServer: (params: {
      serverId: string
      env?: Record<string, string>
      args?: string[]
    }) => ipcRenderer.invoke('mcp:updateServer', params),
  },

  // Marketplace — каталог MCP-серверов (официальный registry) и Skills
  // (GitHub Search API). Только поиск/детали — установка идёт через агента.
  marketplace: {
    searchMcp: (params: { query: string; limit?: number; cursor?: string }) =>
      ipcRenderer.invoke('marketplace:searchMcp', params),
    cancelMcpSearch: () => ipcRenderer.invoke('marketplace:cancelMcpSearch'),
    searchSkills: (params: { query: string; page?: number; perPage?: number }) =>
      ipcRenderer.invoke('marketplace:searchSkills', params),
    cancelSkillsSearch: () => ipcRenderer.invoke('marketplace:cancelSkillsSearch'),
    getSkillReadme: (params: { fullName: string }) =>
      ipcRenderer.invoke('marketplace:getSkillReadme', params),
    buildMcpInstruction: (params: unknown) => ipcRenderer.invoke('marketplace:buildMcpInstruction', params),
    buildSkillInstruction: (params: unknown) => ipcRenderer.invoke('marketplace:buildSkillInstruction', params),
    buildMcpUrlInstruction: (params: { url: string; scope: 'global' | { workdir: string } }) =>
      ipcRenderer.invoke('marketplace:buildMcpUrlInstruction', params),
  },
}

contextBridge.exposeInMainWorld('syntee', synteeAPI)

// Типы для TypeScript в renderer
export type SynteeAPI = typeof synteeAPI
