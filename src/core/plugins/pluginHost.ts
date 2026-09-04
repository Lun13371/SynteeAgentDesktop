/**
 * pluginHost — рантайм ВНУТРИ utilityProcess плагина.
 *
 * Этот файл бандлится отдельной точкой входа (out/main/plugin-host.js,
 * см. electron.vite.config.ts) и форкается через utilityProcess.fork()
 * из pluginProcess.ts. Он НЕ импортируется main-бандлом.
 *
 * Обязанности:
 *   - принять 'init' от main, загрузить entry плагина (require, CJS)
 *   - собрать PluginHostApi (registerTool / storage / clipboard / net / ...)
 *     и вызвать activate(syntee) экспортируемый плагином
 *   - маршрутизировать RPC: callTool → handler плагина, hostRequest → main
 *   - graceful shutdown: вызвать deactivate() плагина и ответить
 *
 * Плагин получает доступ к Node API своего процесса (это изоляция процесса,
 * а не песочница) — права из манифеста гейтят host-мосты (net.fetch,
 * clipboard, notifications) и показываются пользователю при включении.
 */

// Локальный тип parentPort (Electron utilityProcess) — без импорта electron,
// чтобы файл остался чистым Node-модулём и не тянул main-зависимости.
interface ParentPortLike {
  on(event: 'message', listener: (e: { data: unknown }) => void): void
  postMessage(message: unknown): void
  start(): void
}

const port = (process as unknown as { parentPort: ParentPortLike }).parentPort

import type {
  PluginMsgHostToPlugin,
  PluginMsgPluginToHost,
  PluginMsgHostRequest,
} from './pluginProtocol'

// ── Состояние хоста ────────────────────────────────────────────────────────

interface RegisteredTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>) => unknown
}

interface RegisteredCommand {
  name: string
  description: string
  icon?: string
  handler: (args: string) => unknown
}

type EventHandler = (payload: Record<string, unknown>) => void | Record<string, unknown> | undefined | Promise<Record<string, unknown> | void | undefined>
type UiMessageHandler = (data: unknown) => void
type UiRpcHandler = (args: Record<string, unknown>) => unknown

const tools = new Map<string, RegisteredTool>()
const commands = new Map<string, RegisteredCommand>()
const eventHandlers = new Map<string, Set<EventHandler>>()
const uiMessageHandlers = new Set<UiMessageHandler>()
const uiRpcHandlers = new Map<string, UiRpcHandler>()
let deactivateFn: (() => void | Promise<void>) | null = null
let active = false
let permissions: Set<string> = new Set()
let pluginDir = ''
let hostVersion = ''

const send = (msg: PluginMsgPluginToHost): void => {
  try { port.postMessage(msg) } catch { /* процесс умирает — ок */ }
}

// ── RPC в main (hostRequest → hostResponse) ────────────────────────────────

const hostWaiters = new Map<string, (resp: { ok: boolean; result?: unknown; error?: string }) => void>()

function hostRequest(method: PluginMsgHostRequest['method'], params: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve) => {
    const requestId = `hr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    hostWaiters.set(requestId, resolve)
    send({ type: 'hostRequest', requestId, method, params })
    // Страховка: если main не ответил за 30с — резолвим ошибкой, чтобы
    // промис плагина не висел вечно.
    setTimeout(() => {
      const w = hostWaiters.get(requestId)
      if (w) {
        hostWaiters.delete(requestId)
        w({ ok: false, error: `hostRequest timeout: ${method}` })
      }
    }, 30_000)
  })
}

// ── PluginHostApi — то, что получает плагин в activate(syntee) ─────────────

export interface SynteePluginApi {
  /** Абсолютный путь до папки плагина (свои ресурсы). */
  pluginDir: string
  /** Права, выданные плагину (из манифеста, подтверждённые пользователем). */
  permissions: string[]
  /** Версия хоста (приложения) — для совместимости API. */
  version: string
  /** Зарегистрировать тул для AI. Имя — короткое (без plugin__ префикса). */
  registerTool(def: {
    name: string
    description: string
    parameters?: Record<string, unknown>
    handler: (args: Record<string, unknown>) => unknown
  }): void
  /** Зарегистрировать слэш-команду: /name args → handler(args).
   *  Имя без слэша, [a-zA-Z][a-zA-Z0-9_]*. */
  registerCommand(def: {
    name: string
    description: string
    icon?: string
    handler: (args: string) => unknown
  }): void
  /** Зарегистрировать UI-вклад: кнопку или панель в слоте приложения.
   *  slot 'sidebar' — низ сайдбара. type 'button' — клик выполняет command
   *  (имя команды плагина); 'panel' — открывает iframe-панель с ui-файлом
   *  из манифеста (требует permission 'ui'). */
  registerUi(def: {
    slot: 'sidebar'
    type: 'button' | 'panel'
    label: string
    icon?: string
    command?: string
  }): void
  /** Зарегистрировать панель плагина в слоте приложения (permission 'ui').
   *  slot 'right' — таб в правой панели (с бейджами, keep-alive);
   *  slot 'modal' — модальная iframe-панель; slot 'sidebar' — как registerUi.
   *  id — уникальный id панели (для openPanel/setBadge), entry — HTML-файл
   *  относительно папки плагина (по умолчанию manifest.ui). */
  registerPanel(def: {
    id: string
    slot?: 'right' | 'modal' | 'sidebar'
    title: string
    icon?: string
    entry?: string
  }): void
  /** Подписаться на событие хоста:
   *   'chat:message'     — { chatId, content }, fire-and-forget;
   *   'chat:before-send' — { chatId, content }, хук с ответом: вернуть
   *                        undefined/'allow' | { action:'modify', content }
   *                        | { action:'reject', reason? };
   *   'tool:call'        — { toolName, args }, fire-and-forget;
   *   'theme:changed'    — { theme, accentColor, dark }. */
  on(event: 'chat:message' | 'chat:before-send' | 'tool:call' | 'theme:changed',
     handler: (payload: Record<string, unknown>) => void | Record<string, unknown> | undefined | Promise<Record<string, unknown> | void | undefined>): void
  /** Лог в журнал плагина (виден в UI вкладки Плагины). */
  log(...args: unknown[]): void
  /** Per-plugin KV-хранилище (персистится в main, изолировано по pluginId). */
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
  }
  /** Настройки плагина (схема в манифесте config, форма — в UI приложения).
   *  Значения редактирует пользователь в карточке плагина. */
  config: {
    get<T = unknown>(key: string): Promise<T | undefined>
    getAll(): Promise<Record<string, unknown>>
  }
  /** Файлы. readFile/listDir — любые пути (permission 'fs:read');
   *  writeFile — только внутри папки плагина (permission 'fs:write'). */
  fs: {
    readFile(path: string): Promise<string>
    writeFile(path: string, content: string): Promise<void>
    listDir(path: string): Promise<string[]>
  }
  /** Буфер обмена (требует permission 'clipboard'). */
  clipboard: {
    readText(): Promise<string>
    writeText(text: string): Promise<void>
  }
  /** Уведомление (требует permission 'notifications'). */
  notifications: {
    show(title: string, body: string): Promise<void>
  }
  /** HTTP-запрос через main (требует permission 'net'). Возвращает
   *  { status, headers, body } — body это текст (до 1 МБ). */
  net: {
    fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string>; body: string }>
  }
  /** Мост к iframe-панелям плагина. Каналы:
   *   - legacy postMessage: панель → onMessage, postMessage → все панели;
   *   - RPC: панель вызывает synteeBridge.call(method, args) → handle(method);
   *   - push: emit(method, data) → все панели (synteeBridge.on). */
  ui: {
    onMessage(handler: (data: unknown) => void): void
    postMessage(data: unknown): void
    /** RPC-хендлер: вызывается из iframe через synteeBridge.call(method, args). */
    handle(method: string, handler: (args: Record<string, unknown>) => unknown): void
    /** Push в все iframe-панели плагина (synteeBridge.on(method, cb) в панели). */
    emit(method: string, data?: unknown): void
    /** Тема приложения (для стилизации панели). */
    getTheme(): Promise<{ theme: string; accentColor: string; dark: boolean }>
  }
  /** Действия в чате (permission 'chat'). */
  chat: {
    /** Отправить сообщение от имени пользователя (запускает агент).
     *  opts.silent — только вставить текст в инпут, не отправлять. */
    send(text: string, opts?: { silent?: boolean }): Promise<void>
    /** Вставить ответ от имени плагина в текущий чат. */
    reply(text: string): Promise<void>
  }
  /** Чтение чатов приложения (permission 'chats:read'). */
  chats: {
    list(): Promise<Array<{ id: string; title: string; createdAt: number; updatedAt: number }>>
    get(chatId: string): Promise<{ chat: Record<string, unknown>; messages: Array<Record<string, unknown>> } | null>
  }
  /** Чтение проектов (permission 'projects:read'). */
  projects: {
    list(): Promise<Array<{ id: string; name: string; workdir: string }>>
  }
  /** Долговременная память приложения (permission 'memory'). */
  memory: {
    search(query: string): Promise<Array<Record<string, unknown>>>
    save(key: string, value: string, category?: string): Promise<void>
  }
  /** Окно приложения: тосты и диалоги (permission 'ui'). */
  window: {
    toast(text: string, kind?: 'info' | 'success' | 'error'): Promise<void>
    /** Нативный диалог. Возвращает индекс нажатой кнопки (0 — default OK). */
    dialog(title: string, body: string, buttons?: string[]): Promise<number>
  }
}

function requirePermission(perm: string, what: string): void {
  if (!permissions.has(perm)) {
    throw new Error(`Permission denied: ${what} требует "${perm}" — добавьте его в permissions в plugin.json`)
  }
}

function buildApi(): SynteePluginApi {
  return {
    pluginDir,
    permissions: [...permissions],
    version: hostVersion,
    registerTool(def) {
      if (!def || typeof def.name !== 'string' || !def.name) {
        throw new Error('registerTool: name обязателен')
      }
      if (typeof def.handler !== 'function') {
        throw new Error(`registerTool(${def.name}): handler обязателен`)
      }
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(def.name)) {
        throw new Error(`registerTool: имя "${def.name}" должно быть [a-zA-Z][a-zA-Z0-9_]*`)
      }
      tools.set(def.name, {
        name: def.name,
        description: def.description || `Tool ${def.name}`,
        inputSchema: def.parameters ?? { type: 'object', properties: {} },
        handler: def.handler,
      })
      send({ type: 'registerTool', name: def.name, description: def.description || '', inputSchema: def.parameters ?? { type: 'object', properties: {} } })
    },
    registerCommand(def) {
      if (!def || typeof def.name !== 'string' || !def.name) {
        throw new Error('registerCommand: name обязателен')
      }
      if (typeof def.handler !== 'function') {
        throw new Error(`registerCommand(${def.name}): handler обязателен`)
      }
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(def.name)) {
        throw new Error(`registerCommand: имя "${def.name}" должно быть [a-zA-Z][a-zA-Z0-9_]*`)
      }
      commands.set(def.name, {
        name: def.name,
        description: def.description || `Command ${def.name}`,
        icon: def.icon,
        handler: def.handler,
      })
      send({ type: 'registerCommand', name: def.name, description: def.description || '', icon: def.icon })
    },
    registerUi(def) {
      requirePermission('ui', 'registerUi')
      if (!def || typeof def.label !== 'string' || !def.label) {
        throw new Error('registerUi: label обязателен')
      }
      if (def.type === 'button' && !def.command) {
        throw new Error('registerUi: type "button" требует command (имя команды плагина)')
      }
      send({
        type: 'registerUi',
        slot: def.slot ?? 'sidebar',
        uiType: def.type ?? 'button',
        label: def.label,
        icon: def.icon,
        command: def.command,
      })
    },
    registerPanel(def) {
      requirePermission('ui', 'registerPanel')
      if (!def || typeof def.id !== 'string' || !def.id) {
        throw new Error('registerPanel: id обязателен')
      }
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(def.id)) {
        throw new Error(`registerPanel: id "${def.id}" должно быть [a-zA-Z][a-zA-Z0-9_-]*`)
      }
      if (!def.title) throw new Error('registerPanel: title обязателен')
      send({
        type: 'registerUi',
        slot: def.slot ?? 'right',
        uiType: 'panel',
        label: def.title,
        icon: def.icon,
        panelId: def.id,
        entry: def.entry,
      })
    },
    on(event, handler) {
      if (typeof handler !== 'function') return
      if (!eventHandlers.has(event)) eventHandlers.set(event, new Set())
      eventHandlers.get(event)!.add(handler)
      // Сообщаем main, на какие события есть подписчики (short-circuit хуков).
      send({ type: 'subscribeEvents', events: [...eventHandlers.keys()] })
    },
    log(...args: unknown[]) {
      send({ type: 'log', level: 'info', message: args.map(a => (typeof a === 'string' ? a : safeStringify(a))).join(' ') })
    },
    storage: {
      async get<T>(key: string): Promise<T | undefined> {
        const r = await hostRequest('storage.get', { key })
        if (!r.ok) throw new Error(r.error || 'storage.get failed')
        return r.result as T | undefined
      },
      async set(key: string, value: unknown) {
        const r = await hostRequest('storage.set', { key, value })
        if (!r.ok) throw new Error(r.error || 'storage.set failed')
      },
      async delete(key: string) {
        const r = await hostRequest('storage.delete', { key })
        if (!r.ok) throw new Error(r.error || 'storage.delete failed')
      },
    },
    clipboard: {
      async readText() {
        requirePermission('clipboard', 'clipboard.readText')
        const r = await hostRequest('clipboard.readText', {})
        if (!r.ok) throw new Error(r.error || 'clipboard.readText failed')
        return (r.result as string) ?? ''
      },
      async writeText(text: string) {
        requirePermission('clipboard', 'clipboard.writeText')
        const r = await hostRequest('clipboard.writeText', { text })
        if (!r.ok) throw new Error(r.error || 'clipboard.writeText failed')
      },
    },
    notifications: {
      async show(title: string, body: string) {
        requirePermission('notifications', 'notifications.show')
        const r = await hostRequest('notification.show', { title, body })
        if (!r.ok) throw new Error(r.error || 'notification.show failed')
      },
    },
    net: {
      async fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) {
        requirePermission('net', 'net.fetch')
        const r = await hostRequest('net.fetch', { url, init: init ?? {} })
        if (!r.ok) throw new Error(r.error || 'net.fetch failed')
        return r.result as { status: number; headers: Record<string, string>; body: string }
      },
    },
    config: {
      async get<T>(key: string): Promise<T | undefined> {
        const r = await hostRequest('config.get', { key })
        if (!r.ok) throw new Error(r.error || 'config.get failed')
        return r.result as T | undefined
      },
      async getAll(): Promise<Record<string, unknown>> {
        const r = await hostRequest('config.getAll', {})
        if (!r.ok) throw new Error(r.error || 'config.getAll failed')
        return (r.result as Record<string, unknown>) ?? {}
      },
    },
    fs: {
      async readFile(path: string): Promise<string> {
        requirePermission('fs:read', 'fs.readFile')
        const r = await hostRequest('fs.readFile', { path })
        if (!r.ok) throw new Error(r.error || 'fs.readFile failed')
        return (r.result as string) ?? ''
      },
      async writeFile(path: string, content: string): Promise<void> {
        requirePermission('fs:write', 'fs.writeFile')
        const r = await hostRequest('fs.writeFile', { path, content })
        if (!r.ok) throw new Error(r.error || 'fs.writeFile failed')
      },
      async listDir(path: string): Promise<string[]> {
        requirePermission('fs:read', 'fs.listDir')
        const r = await hostRequest('fs.listDir', { path })
        if (!r.ok) throw new Error(r.error || 'fs.listDir failed')
        return (r.result as string[]) ?? []
      },
    },
    ui: {
      onMessage(handler: (data: unknown) => void): void {
        if (typeof handler === 'function') uiMessageHandlers.add(handler)
      },
      postMessage(data: unknown): void {
        send({ type: 'uiPostMessage', data })
      },
      handle(method: string, handler: (args: Record<string, unknown>) => unknown): void {
        uiRpcHandlers.set(method, handler)
      },
      emit(method: string, data?: unknown): void {
        send({ type: 'uiPostMessage', data: { __rpc__: true, method, data: data ?? null } })
      },
      async getTheme() {
        const r = await hostRequest('ui.getTheme', {})
        if (!r.ok) throw new Error(r.error || 'ui.getTheme failed')
        return (r.result as { theme: string; accentColor: string; dark: boolean }) ?? { theme: 'dark', accentColor: '#22d3ee', dark: true }
      },
    },
    chat: {
      async send(text: string, opts?: { silent?: boolean }) {
        requirePermission('chat', 'chat.send')
        const r = await hostRequest('chat.send', { text, silent: opts?.silent ?? false })
        if (!r.ok) throw new Error(r.error || 'chat.send failed')
      },
      async reply(text: string) {
        requirePermission('chat', 'chat.reply')
        const r = await hostRequest('chat.reply', { text })
        if (!r.ok) throw new Error(r.error || 'chat.reply failed')
      },
    },
    chats: {
      async list() {
        requirePermission('chats:read', 'chats.list')
        const r = await hostRequest('chats.list', {})
        if (!r.ok) throw new Error(r.error || 'chats.list failed')
        return (r.result as Array<{ id: string; title: string; createdAt: number; updatedAt: number }>) ?? []
      },
      async get(chatId: string) {
        requirePermission('chats:read', 'chats.get')
        const r = await hostRequest('chats.get', { chatId })
        if (!r.ok) throw new Error(r.error || 'chats.get failed')
        return r.result as { chat: Record<string, unknown>; messages: Array<Record<string, unknown>> } | null
      },
    },
    projects: {
      async list() {
        requirePermission('projects:read', 'projects.list')
        const r = await hostRequest('projects.list', {})
        if (!r.ok) throw new Error(r.error || 'projects.list failed')
        return (r.result as Array<{ id: string; name: string; workdir: string }>) ?? []
      },
    },
    memory: {
      async search(query: string) {
        requirePermission('memory', 'memory.search')
        const r = await hostRequest('memory.search', { query })
        if (!r.ok) throw new Error(r.error || 'memory.search failed')
        return (r.result as Array<Record<string, unknown>>) ?? []
      },
      async save(key: string, value: string, category?: string) {
        requirePermission('memory', 'memory.save')
        const r = await hostRequest('memory.save', { key, value, category })
        if (!r.ok) throw new Error(r.error || 'memory.save failed')
      },
    },
    window: {
      async toast(text: string, kind?: 'info' | 'success' | 'error') {
        requirePermission('ui', 'window.toast')
        const r = await hostRequest('window.toast', { text, kind: kind ?? 'info' })
        if (!r.ok) throw new Error(r.error || 'window.toast failed')
      },
      async dialog(title: string, body: string, buttons?: string[]) {
        requirePermission('ui', 'window.dialog')
        const r = await hostRequest('window.dialog', { title, body, buttons })
        if (!r.ok) throw new Error(r.error || 'window.dialog failed')
        return (r.result as number) ?? 0
      },
    },
  }
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v) } catch { return String(v) }
}

// ── Обработка сообщений от main ────────────────────────────────────────────

port.on('message', (e) => {
  const msg = e.data as PluginMsgHostToPlugin
  switch (msg.type) {
    case 'init': {
      ;(async () => {
        try {
          pluginDir = msg.pluginDir
          permissions = new Set(msg.permissions ?? [])
          hostVersion = msg.env?.appVersion ?? ''
          // Динамическая загрузка кода плагина — только через require в рантайме
          // (путь приходит из манифеста, статический импорт невозможен).
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const manifest = require(`${pluginDir}/plugin.json`) as { main?: string }
          const entryRel = manifest.main || 'dist/index.js'
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const entry = require('path').join(pluginDir, entryRel)
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const mod = require(entry) as {
            activate?: (api: SynteePluginApi) => void | Promise<void>
            deactivate?: () => void | Promise<void>
          }
          if (typeof mod.activate !== 'function') {
            throw new Error(`entry ${entryRel} не экспортирует activate(syntee)`)
          }
          deactivateFn = mod.deactivate ?? null
          await mod.activate(buildApi())
          active = true
          send({ type: 'initResult', requestId: msg.requestId, ok: true })
        } catch (err) {
          send({ type: 'initResult', requestId: msg.requestId, ok: false, error: (err as Error).message })
          // Активация не удалась — процесс больше не нужен.
          setTimeout(() => process.exit(1), 100)
        }
      })()
      break
    }
    case 'callCommand': {
      ;(async () => {
        try {
          if (!active) throw new Error('Плагин не активен')
          const cmd = commands.get(msg.commandName)
          if (!cmd) throw new Error(`Команда не зарегистрирована: ${msg.commandName}`)
          const result = await cmd.handler(msg.args ?? '')
          const output = typeof result === 'string' ? result : safeStringify(result)
          send({ type: 'callCommandResult', requestId: msg.requestId, ok: true, output })
        } catch (err) {
          send({ type: 'callCommandResult', requestId: msg.requestId, ok: false, error: (err as Error).message })
        }
      })()
      break
    }
    case 'event': {
      // Fire-and-forget: хост не ждёт ответа. Ошибки хендлеров — в лог.
      const handlers = eventHandlers.get(msg.event)
      if (handlers) {
        for (const h of handlers) {
          try {
            const r = h(msg.payload ?? {}) as unknown
            if (r && typeof (r as Promise<void>).catch === 'function') {
              ;(r as Promise<void>).catch(e => {
                send({ type: 'log', level: 'error', message: `event ${msg.event} handler error: ${(e as Error).message}` })
              })
            }
          } catch (e) {
            send({ type: 'log', level: 'error', message: `event ${msg.event} handler error: ${(e as Error).message}` })
          }
        }
      }
      break
    }
    case 'uiMessage': {
      for (const h of uiMessageHandlers) {
        try { h(msg.data) } catch (e) {
          send({ type: 'log', level: 'error', message: `uiMessage handler error: ${(e as Error).message}` })
        }
      }
      break
    }
    case 'uiCall': {
      ;(async () => {
        try {
          const handler = uiRpcHandlers.get(msg.method)
          if (!handler) throw new Error(`Метод не зарегистрирован: ${msg.method} (syntee.ui.handle)`)
          const result = await handler(msg.args ?? {})
          send({ type: 'uiCallResult', requestId: msg.requestId, ok: true, result: result === undefined ? null : result })
        } catch (err) {
          send({ type: 'uiCallResult', requestId: msg.requestId, ok: false, error: (err as Error).message })
        }
      })()
      break
    }
    case 'hook': {
      ;(async () => {
        try {
          const handlers = eventHandlers.get(msg.event)
          let action: 'allow' | 'modify' | 'reject' = 'allow'
          let content: string | undefined
          let error: string | undefined
          if (handlers && handlers.size > 0) {
            // Последовательное применение: каждый хендлер может модифицировать
            // контент или отклонить. Первый reject — финален.
            for (const h of handlers) {
              try {
                const cur = msg.payload ?? {}
                const res = await h(content !== undefined ? { ...cur, content } : cur)
                const r = res as { action?: string; content?: string; reason?: string } | void | undefined
                if (r && typeof r === 'object') {
                  if (r.action === 'reject') {
                    action = 'reject'
                    error = r.reason
                    break
                  }
                  if (r.action === 'modify' && typeof r.content === 'string') {
                    action = 'modify'
                    content = r.content
                  }
                }
              } catch (e) {
                // Ошибка хендлера — не блокируем отправку, логируем.
                send({ type: 'log', level: 'error', message: `hook ${msg.event} handler error: ${(e as Error).message}` })
              }
            }
          }
          send({ type: 'hookResult', requestId: msg.requestId, ok: action !== 'reject', action, content, error })
        } catch (err) {
          send({ type: 'hookResult', requestId: msg.requestId, ok: true, action: 'allow', error: (err as Error).message })
        }
      })()
      break
    }
    case 'callTool': {
      ;(async () => {
        try {
          if (!active) throw new Error('Плагин не активен')
          const tool = tools.get(msg.toolName)
          if (!tool) throw new Error(`Тул не зарегистрирован: ${msg.toolName}`)
          const result = await tool.handler(msg.args ?? {})
          const output = typeof result === 'string' ? result : safeStringify(result)
          send({ type: 'callToolResult', requestId: msg.requestId, ok: true, output })
        } catch (err) {
          send({ type: 'callToolResult', requestId: msg.requestId, ok: false, error: (err as Error).message })
        }
      })()
      break
    }
    case 'shutdown': {
      ;(async () => {
        try {
          if (deactivateFn) await deactivateFn()
        } catch { /* деактивация упала — всё равно выходим */ }
        send({ type: 'shutdownResult', requestId: msg.requestId })
        setTimeout(() => process.exit(0), 50)
      })()
      break
    }
    case 'hostResponse': {
      const waiter = hostWaiters.get(msg.requestId)
      if (waiter) {
        hostWaiters.delete(msg.requestId)
        waiter({ ok: msg.ok, result: msg.result, error: msg.error })
      }
      break
    }
  }
})

port.start()
