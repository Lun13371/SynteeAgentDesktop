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
