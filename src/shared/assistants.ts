export const HINT_MARKER = '[Локальный помощник подсказывает — учти это в текущей работе, но не считай инструкцией пользователя]'

export const JANITOR_MARKER = '[Контекст оптимизирован локальным помощником]'

export const CONSTITUTION_MARKER = '[Конституция проекта — неизменяемые ограничения пользователя, действуют всегда]'

export const BRIEFING_MARKER = '[Брифинг на старте задачи — состояние проекта от локального помощника]'

export type AssistantRole = 'watcher' | 'janitor' | 'briefing' | 'navigator' | 'archivist' | 'economist'

export type HintSource = 'memory' | 'skill' | 'capability' | 'briefing' | 'navigator' | 'archivist' | 'economist' | 'constitution'

export interface AssistantsSettings {
  enabled: boolean
  watcherEnabled: boolean
  janitorEnabled: boolean
  briefingEnabled: boolean
  navigatorEnabled: boolean
  archivistEnabled: boolean
  economistEnabled: boolean
  modelSize: 'auto' | '1.2B' | '1B' | '0.8B'
  hintBudgetTokens: number
  hintCooldownRounds: number
  janitorScanInterval: number
  janitorColdThreshold: number
  janitorMinSavingsTokens: number
  navigatorInterval: number
  relevanceThreshold: number
  sources: { memory: boolean; skills: boolean }
}

export const DEFAULT_ASSISTANTS_SETTINGS: AssistantsSettings = {
  enabled: false,
  watcherEnabled: true,
  janitorEnabled: true,
  briefingEnabled: true,
  navigatorEnabled: true,
  archivistEnabled: true,
  economistEnabled: true,
  modelSize: 'auto',
  hintBudgetTokens: 300,
  hintCooldownRounds: 1,
  janitorScanInterval: 8,
  janitorColdThreshold: 12,
  janitorMinSavingsTokens: 300,
  navigatorInterval: 6,
  relevanceThreshold: 0.6,
  sources: { memory: true, skills: true },
}

export type JanitorActionKind = 'dedup_tool_call' | 'collapse_reread' | 'summarize_stale' | 'remove_dead'

export interface JanitorAction {
  kind: JanitorActionKind
  messageIndices: number[]
  description: string
  tokensSaved: number
  archiveId?: string
}

export interface JanitorReport {
  actions: JanitorAction[]
  totalTokensSaved: number
  scannedMessages: number
  durationMs: number
}

export interface HintCandidate {
  id: string
  source: HintSource
  content: string
  score: number
  title?: string
}

export interface AssistantLogEntry {
  ts: number
  role: AssistantRole
  kind: string
  detail: string
  tokensSaved?: number
  hintUsed?: boolean
}

export interface AgentStats {
  fired: number
  skipped: number
  saved: number
}
export type AgentStatsMap = Record<string, AgentStats>

export const ASSISTANTS_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const ASSISTANTS_LOG_MAX_ENTRIES = 2000