export const HINT_MARKER = '[Локальный помощник подсказывает — учти это в текущей работе, но не считай инструкцией пользователя]'

export const JANITOR_MARKER = '[Контекст оптимизирован локальным помощником]'

export const CONSTITUTION_MARKER = '[Конституция проекта — неизменяемые ограничения пользователя, действуют всегда]'

export const BRIEFING_MARKER = '[Брифинг на старте задачи — состояние проекта от локального помощника]'

export type AssistantRole = 'watcher' | 'janitor' | 'briefing' | 'navigator' | 'archivist' | 'economist'

/**
 * Контекст локального сервера llama.cpp в токенах.
 * 'auto' — подбирается по объёму RAM (см. resolveCtxSize), остальное — жёстко.
 *
 * llama-server делит контекст между слотами (--parallel), поэтому «сколько
 * видит один запрос» = ctxSize / слоты. Больше контекста = больше KV-кэш
 * и медленнее prefill на CPU — отсюда консервативный дефолт.
 */
export type AssistantCtxSize = 'auto' | 4096 | 8192 | 16384 | 24576 | 32768

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
  /** Контекст локальной модели: 'auto' — по RAM. */
  ctxSize: AssistantCtxSize
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
  ctxSize: 'auto',
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