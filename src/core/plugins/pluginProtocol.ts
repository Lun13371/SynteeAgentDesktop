/**
 * Протокол сообщений между PluginManager (main) и процессом плагина
 * (utilityProcess). Файл импортируется ОБЕИМИ сторонами — поэтому здесь
 * только типы и константы, без electron/node-зависимостей.
 *
 * Схема: main → plugin — команды (с requestId для RPC-ответов),
 * plugin → main — события и ответы.
 */

/** main → plugin: инициализация (после spawn). Несёт конфиг плагина. */
export interface PluginMsgInit {
  type: 'init'
  requestId: string
  /** Абсолютный путь до папки плагина (для чтения своих ресурсов). */
  pluginDir: string
  /** Права из манифеста (host уже отфильтровал по подтверждению). */
  permissions: string[]
  /** Глобальные настройки приложения, полезные плагину. */
  env: {
    platform: string
    appVersion: string
    locale: string
  }
}

/** main → plugin: RPC-вызов тула. */
export interface PluginMsgCallTool {
  type: 'callTool'
  requestId: string
  toolName: string
  args: Record<string, unknown>
}

/** main → plugin: RPC-вызов слэш-команды. */
export interface PluginMsgCallCommand {
  type: 'callCommand'
  requestId: string
  commandName: string
  /** Строка аргументов после /name. */
  args: string
}

/** main → plugin: graceful shutdown (перед kill). */
export interface PluginMsgShutdown {
  type: 'shutdown'
  requestId: string
}

/** main → plugin: событие хоста (chat:message и др.). Fire-and-forget. */
export interface PluginMsgEvent {
  type: 'event'
  event: string
  payload: Record<string, unknown>
}

/** main → plugin: сообщение из iframe-панели плагина. Fire-and-forget. */
export interface PluginMsgUiMessage {
  type: 'uiMessage'
  data: unknown
}

/** main → plugin: RPC-вызов из iframe-панели (мост synteeBridge.call). */
export interface PluginMsgUiCall {
  type: 'uiCall'
  requestId: string
  /** Имя метода, зарегистрированного через syntee.ui.handle(). */
  method: string
  args: Record<string, unknown>
}

/** main → plugin: хук с ответом (chat:before-send). Плагин отвечает
 *  hookResult { action: 'allow' | 'modify' | 'reject', content? }. */
export interface PluginMsgHook {
  type: 'hook'
  requestId: string
  event: string
  payload: Record<string, unknown>
}

/** plugin → main: ответ на init (успех/ошибка активации). */
export interface PluginMsgInitResult {
  type: 'initResult'
  requestId: string
  ok: boolean
  error?: string
}

/** plugin → main: ответ на вызов тула. */
export interface PluginMsgCallToolResult {
  type: 'callToolResult'
  requestId: string
  ok: boolean
  /** Текстовый результат (строка — как у всех тулов агента). */
  output?: string
  error?: string
}

/** plugin → main: ответ на вызов слэш-команды. */
export interface PluginMsgCallCommandResult {
  type: 'callCommandResult'
  requestId: string
  ok: boolean
  output?: string
  error?: string
}

/** plugin → main: зарегистрировать слэш-команду. */
export interface PluginMsgRegisterCommand {
  type: 'registerCommand'
  name: string
  description: string
  icon?: string
}

/** plugin → main: зарегистрировать UI-вклад (кнопка/панель/таб в слоте). */
export interface PluginMsgRegisterUi {
  type: 'registerUi'
  slot: 'sidebar' | 'right' | 'modal'
  uiType: 'button' | 'panel'
  label: string
  icon?: string
  command?: string
  /** Для right/modal — уникальный id панели. */
  panelId?: string
  /** HTML-файл панели (по умолчанию — manifest.ui). */
  entry?: string
}

/** plugin → main: плагин подписался на события (для short-circuit хуков). */
export interface PluginMsgSubscribeEvents {
  type: 'subscribeEvents'
  events: string[]
}

/** plugin → main: ответ на RPC-вызов из iframe (ui.handle). */
export interface PluginMsgUiCallResult {
  type: 'uiCallResult'
  requestId: string
  ok: boolean
  result?: unknown
  error?: string
}

/** plugin → main: ответ на хук (chat:before-send). */
export interface PluginMsgHookResult {
  type: 'hookResult'
  requestId: string
  ok: boolean
  /** 'allow' (по умолчанию) | 'modify' | 'reject'. */
  action?: 'allow' | 'modify' | 'reject'
  /** Новое содержимое при action='modify'. */
  content?: string
  error?: string
}

/** plugin → main: сообщение в свою iframe-панель (renderer перешлёт в iframe). */
export interface PluginMsgUiPostMessage {
  type: 'uiPostMessage'
  data: unknown
}

/** plugin → main: ответ на shutdown. */
export interface PluginMsgShutdownResult {
  type: 'shutdownResult'
  requestId: string
}

/** plugin → main: зарегистрировать тул. */
export interface PluginMsgRegisterTool {
  type: 'registerTool'
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** plugin → main: лог (уходит в кольцевой буфер + UI). */
export interface PluginMsgLog {
  type: 'log'
  level: 'info' | 'warn' | 'error'
  message: string
}

/** plugin → main: запрос к host-API (storage, clipboard, notifications, net,
 *  fs, config, ui.*, chat.*, chats.*, projects.*, memory.*, window.*). */
export interface PluginMsgHostRequest {
  type: 'hostRequest'
  requestId: string
  method: 'storage.get' | 'storage.set' | 'storage.delete'
    | 'clipboard.readText' | 'clipboard.writeText'
    | 'notification.show'
    | 'net.fetch'
    | 'fs.readFile' | 'fs.writeFile' | 'fs.listDir'
    | 'config.get' | 'config.getAll'
    | 'ui.openPanel' | 'ui.closePanel' | 'ui.setBadge' | 'ui.getTheme'
    | 'chat.send' | 'chat.reply'
    | 'chats.list' | 'chats.get'
    | 'projects.list'
    | 'memory.search' | 'memory.save'
    | 'window.toast' | 'window.dialog'
  params: Record<string, unknown>
}

/** main → plugin: ответ на host-запрос. */
export interface PluginMsgHostResponse {
  type: 'hostResponse'
  requestId: string
  ok: boolean
  result?: unknown
  error?: string
}

export type PluginMsgHostToPlugin =
  | PluginMsgInit
  | PluginMsgCallTool
  | PluginMsgCallCommand
  | PluginMsgShutdown
  | PluginMsgEvent
  | PluginMsgUiMessage
  | PluginMsgUiCall
  | PluginMsgHook
  | PluginMsgHostResponse

export type PluginMsgPluginToHost =
  | PluginMsgInitResult
  | PluginMsgCallToolResult
  | PluginMsgCallCommandResult
  | PluginMsgShutdownResult
  | PluginMsgRegisterTool
  | PluginMsgRegisterCommand
  | PluginMsgRegisterUi
  | PluginMsgSubscribeEvents
  | PluginMsgUiCallResult
  | PluginMsgHookResult
  | PluginMsgLog
  | PluginMsgHostRequest
  | PluginMsgUiPostMessage
