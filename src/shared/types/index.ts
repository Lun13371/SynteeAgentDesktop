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
  'chat:send': (params: { chatId: string; content: string; incognito?: boolean }) => void
  'chat:create': (incognito?: boolean) => string
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
  color?: string
  lastMessage?: string
  messageCount?: number
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
  iterations?: Array<{ label?: string; textBefore: string; steps: ToolStep[] }>
  liveSegments?: Array<{ text: string; steps: ToolStep[] }>
  imageUrl?: string
  planData?: { title: string; content: string; summary: string; filePath: string }
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
  temperature: number      // 0–2, default 0.7
  maxTokens: number        // default 4096
  systemPrompt: string     // глобальный system prompt
  streaming: boolean
}

export type ApprovalMode = 'ask' | 'auto' | 'full'
export type ToolOutputMode = 'compact' | 'normal' | 'detailed'

export interface AgentSettings {
  approvalMode: ApprovalMode
  maxSteps: number
  toolOutputMode: ToolOutputMode
  enableThinking: boolean
  maxParallelSubAgents: number
  readFileCache: boolean
  toolSummarization: boolean
  autoMemoryInterval: number
  maxRepeatedToolCalls: number
  maxRepeatedErrors: number
  contextCompactionPct: number
  preserveRecentToolRounds: number
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
