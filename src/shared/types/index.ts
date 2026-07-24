// Shared types for IPC communication
export interface IPCChannels {
  // Window
  'window:hide': () => void
  'window:minimize': () => void
  'window:show': () => void
  // Settings
  'settings:get': (key: string) => unknown
  'settings:set': (key: string, value: unknown) => void
  'settings:getAll': () => Record<string, unknown>
  // Chat
  'chat:send': (params: { chatId: string; content: string; incognito?: boolean; mode?: ChatMode }) => void
  'chat:create': (incognito?: boolean, mode?: ChatMode) => string
  'chat:getAll': () => Chat[]
  'chat:getMessages': (chatId: string) => Message[]
  'chat:delete': (chatId: string) => void
  'chat:rename': (chatId: string, title: string) => void
  // System
  'system:info': () => SystemInfo
  'system:logError': (message: string, stack?: string) => void
  // Overlay
  'overlay:show': () => void
  'overlay:hide': () => void
  'overlay:getDisplays': () => DisplayInfo[]
  // Voice
  'voice:toggle': () => void
  'voice:start': () => void
  'voice:stop': () => void
  // Spotlight
  'spotlight:show': () => void
  'spotlight:hide': () => void
}

export interface Chat {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  isIncognito: number
  isPinned: number
  isArchived: number
  mode: ChatMode
  color?: string
  workdir?: string  // денормализованный кэш из projects (обратная совместимость)
  projectId?: string  // FK на projects.id; NULL = «Без проекта»
  lastMessage?: string
  messageCount?: number
}

export interface Project {
  id: string
  name: string
  workdir: string
  projectContext?: string  // результат analyzeProject при создании; не гоняем по IPC в каждый chats.list
  verificationCommand?: string  // команда авто-проверки после серии правок (напр. "npm test")
  createdAt: number
  lastUsed: number
}

export interface Message {
  id: string
  chatId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
  isPinned: number
  model?: string
  toolSteps?: ToolStep[]
  thinking?: string
  thinkingMs?: number
  slashCommand?: { name: string; args: string }
  iterations?: Array<{ label?: string; textBefore: string; thinking?: string; thinkingMs?: number; steps: ToolStep[] }>
  liveSegments?: Array<{ text: string; steps: ToolStep[] }>
  imageUrl?: string
  planData?: { title: string; content: string; summary: string; filePath: string }
  todo?: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>
  /** Снимок резюме на момент сжатия контекста (для разворачивания разделителя).
   *  Заполняется только у system-сообщений с slashCommand.name === 'compact'. */
  compactSummary?: string
  /** Статистика сжатия (заполняется только у compact-разделителей).
   *  Используется ContextRing для показа кол-ва сжатий и сэкономленных токенов. */
  compactStats?: { removedCount: number; tokensBefore: number; tokensAfter: number; tokensSaved: number }
}

export interface ToolStep {
  id: string
  type: 'tool_call' | 'tool_result'
  toolName?: string
  toolArgs?: Record<string, unknown>
  content: string
  success?: boolean
  timestamp: number
  imageUrl?: string  // путь к сгенерированному изображению
  diff?: string      // unified diff для edit_file / multi_edit_file
  callId?: string    // ID tool_call для связи call→result (реконструкция истории)
  /** Имя MCP-сервера для MCP-тулов (mcp__server__tool). undefined для встроенных. */
  serverName?: string
}

// ─── Checkpoint / Rewind ─────────────────────────────────────────────────────
// Точка отката сессии: пара (user_message_id, assistant_message_id) одного turn'а.
// Используется правой панелью "Сессия" для таймлайна и кнопкой "Откатить" на
// user-сообщениях.
export interface CheckpointMeta {
  id: string
  chatId: string
  userMessageId: string
  assistantMessageId: string | null
  userPromptPreview: string  // первые 120 символов user-промпта
  filesChanged: number       // кол-во файлов, изменённых в этом turn'е
  filePaths: string[]        // список путей изменённых файлов
  createdAt: number
}

// Результат chat:rewindTo — либо обновлённый массив сообщений, либо ошибка.
export interface RewindResult {
  messages?: Message[]
  error?: string
}

// Метаданные одного запроса в очереди или активного запуска чата.
// Используется UI-панелью очереди для отображения preview/управления.
export interface QueueItemMeta {
  queueId: string       // уникальный ID элемента (uuid)
  chatId: string
  msgId: string         // assistantMsgId (будущего ответа)
  userMsgId: string     // id user-сообщения
  preview: string       // первые ~80 симв. текста запроса
  enqueuedAt: number    // ts постановки в очередь
  startedAt?: number    // ts старта воркера (для active run)
}

export interface DisplayInfo {
  id: number
  bounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
  isPrimary: boolean
}

export interface SystemInfo {
  platform: string
  version: string
  appVersion: string
}

export interface AgentAction {
  type: 'tool_call' | 'tool_result' | 'thinking' | 'done' | 'error'
  tool?: string
  args?: unknown
  result?: string
  error?: string
  timestamp: number
}

// ─── AI Providers & Models ───────────────────────────────────────────────────

export type ProviderType =
  | 'openai' | 'anthropic' | 'google' | 'groq' | 'mistral'
  | 'ollama' | 'cohere' | 'together' | 'fireworks' | 'deepseek'
  | 'xai' | 'onlysq' | 'voidai' | 'custom'
  | 'opencode' | 'opencode-free' | 'opencode-go'

export interface Provider {
  id: string               // уникальный slug: 'openai', 'my-custom-1'
  type: ProviderType
  name: string             // отображаемое название
  baseUrl: string          // https://api.openai.com/v1
  apiKey: string           // основной ключ (обратная совместимость)
  apiKeys?: string[]       // несколько ключей — round-robin
  rrIndex?: number         // текущий индекс round-robin
  enabled: boolean
  isCustom: boolean
  iconUrl?: string         // для кастомных провайдеров
  lastModelsFetch?: number // timestamp последнего парсинга
  modelsOverride?: string[]// ручные модели добавленные пользователем
  /** Провайдер работает без API-ключа (анонимный, шлёт Bearer public). */
  anonymous?: boolean
}

export type ModelCapability = 'vision' | 'tools' | 'reasoning' | 'code' | 'embedding' | 'tts' | 'stt' | 'image_gen'

export type ModelSpeed = 'fast' | 'medium' | 'slow'

export interface ModelMeta {
  id: string               // 'gpt-4o', 'claude-3-5-sonnet-20241022'
  providerId: string       // ссылка на Provider.id
  name: string             // красивое название
  contextWindow: number    // в токенах
  inputPrice?: number      // $ за 1M input токенов
  outputPrice?: number     // $ за 1M output токенов
  speed: ModelSpeed
  capabilities: ModelCapability[]
  description?: string
  isCustom?: boolean       // добавлена пользователем вручную
}

export type ModelRole =
  | 'main'        // основной чат
  | 'fast'        // быстрые ответы, автотайтлы
  | 'vision'      // анализ изображений
  | 'stt'         // speech-to-text
  | 'tts'         // text-to-speech
  | 'embedding'   // векторный поиск / память
  | 'memory'      // анализ памяти
  | 'summary'     // авто-заголовки чатов
  | 'subagent'    // суб-агенты

export interface ModelAssignment {
  role: ModelRole
  modelId: string
  providerId: string
}

export interface ModelParams {
  systemPrompt: string     // глобальная доп. инструкция (аппендится, не перезаписывает)
  streaming: boolean
}

export type ApprovalMode = 'ask' | 'auto' | 'full'
export type ToolOutputMode = 'compact' | 'normal' | 'detailed'
export type ChatMode = 'code' | 'work'

export interface AgentSettings {
  approvalMode: ApprovalMode
  maxSteps: number
  toolOutputMode: ToolOutputMode
  enableThinking: boolean
  maxParallelSubAgents: number
  readFileCache: boolean
  autoMemoryInterval: number
  maxRepeatedToolCalls: number
  maxRepeatedErrors: number
}

// IPC channels для провайдеров/моделей
export interface ProviderIPC {
  'providers:getAll': () => Provider[]
  'providers:save': (provider: Provider) => void
  'providers:delete': (id: string) => void
  'providers:fetchModels': (providerId: string) => ModelMeta[]
  'providers:testKey': (providerId: string) => { ok: boolean; error?: string }
  'models:getAll': () => ModelMeta[]
  'models:saveCustom': (model: ModelMeta) => void
  'models:deleteCustom': (modelId: string, providerId: string) => void
  'models:getAssignments': () => ModelAssignment[]
  'models:setAssignment': (assignment: ModelAssignment) => void
  'models:getParams': () => ModelParams
  'models:setParams': (params: Partial<ModelParams>) => void
}

// ─── MCP (Model Context Protocol) ───────────────────────────────────────────

/** Транспорт подключения к MCP-серверу. */
export type McpTransport = 'stdio' | 'sse' | 'streamable-http'

/**
 * Область применения расширения (MCP-сервера или скилла).
 * - global  → применяется ко всем чатам
 * - projects → применяется только к чатам выбранных проектов (projectIds)
 */
export interface ExtensionScope {
  type: 'global' | 'projects'
  projectIds?: string[]
}

/** Конфигурация MCP-сервера (хранится в electron-store / .mcp.json). */
export interface McpServerConfig {
  /** Уникальный slug. Для проектных серверов — имя из .mcp.json. */
  id: string
  /** Отображаемое имя. */
  name: string
  transport: McpTransport
  // stdio-only
  command?: string
  args?: string[]
  env?: Record<string, string>
  // sse-only
  url?: string
  headers?: Record<string, string>
  /** Включён ли сервер (глобальный тумблер). */
  enabled: boolean
  scope: ExtensionScope
  /** 'global' (из electron-store) или 'project' (из .mcp.json). */
  source: 'global' | 'project'
  /** Для проектных серверов — id проекта, из workdir которого загружен. */
  projectId?: string
}

/** Per-tool состояние (включён / подтверждение) — хранится отдельно от конфига. */
export interface McpToolState {
  enabled: boolean
  /** Спрашивать подтверждение перед вызовом этого тула. */
  requireApproval: boolean
}

/** Runtime-описание тулза MCP, агрегированное McpManager-ом для агента. */
export interface McpToolRuntime {
  serverId: string
  serverName: string
  /** Полное имя тула: mcp__{serverName}__{toolName}. */
  name: string
  /** Короткое имя тула (без префикса). */
  shortName: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Статус подключения MCP-сервера. */
export type McpConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'

/** Уровень записи в журнале подключения MCP-сервера. */
export type McpLogLevel = 'info' | 'warn' | 'error'

/** Одна запись журнала подключения MCP-сервера (для UI лог-вьюера). */
export interface McpLogEntry {
  /** Unix ms. */
  ts: number
  level: McpLogLevel
  message: string
}

/** Полное состояние сервера для UI (конфиг + runtime). */
export interface McpServerRuntime extends McpServerConfig {
  status: McpConnectionStatus
  error?: string
  tools: McpToolRuntime[]
  /** Per-tool состояние, сгруппированное по полному имени тула. */
  toolStates: Record<string, McpToolState>
  /** Timestamp начала последней попытки подключения (для UI-таймера). */
  connectStartedAt?: number
  /** Журнал подключения (хронологически; накопительно, cap на стороне main). */
  logs?: McpLogEntry[]
}

// ─── Skills ─────────────────────────────────────────────────────────────────

/** Источник скилла. */
export type SkillSource = 'builtin' | 'user' | 'project'

/**
 * Скилл = markdown-инструкция, инжектищаяся в system prompt когда включён.
 * Загружается из .md-файла с YAML frontmatter.
 */
export interface Skill {
  /** Стабильный id: source + ':' + относительный путь/имя. */
  id: string
  name: string
  description: string
  /** Тело файла (инструкции) — попадает в system prompt. */
  instructions: string
  source: SkillSource
  /** Абсолютный путь к файлу. */
  filePath: string
  /** Для проектных — id проекта. */
  projectId?: string
  /** mtime файла для инвалидации кэша. */
  mtimeMs: number
}

/** Per-skill состояние (включён + область применения). */
export interface SkillState {
  enabled: boolean
  scope: ExtensionScope
}

// ─── Marketplace (каталог MCP-серверов и Skills) ────────────────────────────

/** Требование к переменной окружения MCP-сервера (из registry). */
export interface McpEnvVarRequirement {
  name: string
  description: string
  isRequired: boolean
  isSecret: boolean
}

/** Требование к HTTP-заголовку удалённого MCP-сервера. */
export interface McpHeaderRequirement {
  name: string
  description: string
  isRequired: boolean
  isSecret: boolean
  value?: string
}

/** Вариант установки через удалённый транспорт (sse / streamable-http). */
export interface McpRemoteOption {
  type: 'sse' | 'streamable-http'
  url: string
  headers?: McpHeaderRequirement[]
}

/** Вариант установки через локальный пакет (stdio). */
export interface McpPackageOption {
  registryType: 'npm' | 'pypi' | 'oci'
  identifier: string
  version: string
  /** Подсказка исполняемой среды: 'npx' | 'uvx' | 'docker'. */
  runtimeHint?: string
  packageArguments?: string[]
  environmentVariables?: McpEnvVarRequirement[]
  /** Позиционные параметры для GUI (пути, строки подключения и т.д.). */
  positionalArgs?: Array<{
    label: string
    placeholder: string
    defaultValue?: string
    isRequired?: boolean
  }>
}

/** Элемент каталога MCP Registry для маркетплейса. */
export interface MarketplaceMcpServer {
  id: string
  title: string
  description: string
  version: string
  repositoryUrl?: string
  websiteUrl?: string
  iconUrl?: string
  remotes: McpRemoteOption[]
  packages: McpPackageOption[]
}

/** Элемент каталога Skills (GitHub-репозиторий) для маркетплейса. */
export interface MarketplaceSkill {
  id: string
  name: string
  fullName: string
  description: string
  htmlUrl: string
  stars: number
  language: string | null
  topics: string[]
  license: string | null
  updatedAt: string
}
