/**
 * Context Manager — управление контекстом чата и результатами тулов.
 * Настройки читаются из electron-store через storeData.
 */

export interface ContextSettings {
  // Tool truncation
  toolTruncEnabled: boolean
  toolMaxChars: number        // макс символов на один tool result (дефолт 4000)

  // Rolling window + summary
  rollingEnabled: boolean
  rollingTriggerPct: number   // % заполненности контекста для триггера (дефолт 75)
  rollingKeepFirst: number    // сколько первых сообщений всегда сохранять (дефолт 2)
  rollingKeepLast: number     // сколько последних сообщений всегда сохранять (дефолт 12)
  contextLimitTokens: number  // лимит токенов модели (дефолт 100000)

  // Token counter
  tokenCounterEnabled: boolean
}

export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = {
  toolTruncEnabled: true,
  toolMaxChars: 4000,
  rollingEnabled: true,
  rollingTriggerPct: 75,
  rollingKeepFirst: 2,
  rollingKeepLast: 12,
  contextLimitTokens: 100000,
  tokenCounterEnabled: true,
}

// Грубая оценка токенов (1 токен ≈ 4 символа)
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function estimateMessagesTokens(messages: Array<{ role: string; content: string }>): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0)
}

// ─── 1. TOOL RESULT TRUNCATION ───────────────────────────────────────────────

export function truncateToolResult(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output
  const half = Math.floor(maxChars / 2)
  const head = output.slice(0, half)
  const tail = output.slice(-Math.floor(half * 0.3))
  const removed = output.length - half - Math.floor(half * 0.3)
  return `${head}\n\n...[обрезано ${removed} симв, показано начало и конец]...\n\n${tail}`
}

// ─── 2. ROLLING WINDOW + SUMMARY ─────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface CompressResult {
  messages: ChatMessage[]
  compressed: boolean
  removedCount: number
  summaryAdded: boolean
}

/**
 * Применяет rolling window к истории.
 * Если summary уже есть (первое сообщение role=system с [Summary:]) — обновляет его.
 * Возвращает сжатую историю и метаданные.
 */
export function applyRollingWindow(
  messages: ChatMessage[],
  settings: Pick<ContextSettings, 'rollingKeepFirst' | 'rollingKeepLast' | 'rollingTriggerPct' | 'contextLimitTokens'>
): CompressResult {
  const totalTokens = estimateMessagesTokens(messages)
  const limitTokens = settings.contextLimitTokens
  const triggerTokens = Math.floor(limitTokens * settings.rollingTriggerPct / 100)

  if (totalTokens < triggerTokens || messages.length <= settings.rollingKeepFirst + settings.rollingKeepLast) {
    return { messages, compressed: false, removedCount: 0, summaryAdded: false }
  }

  const keepFirst = settings.rollingKeepFirst
  const keepLast = settings.rollingKeepLast

  // Разделяем на части
  const headMessages = messages.slice(0, keepFirst)
  const tailMessages = messages.slice(messages.length - keepLast)
  const middleMessages = messages.slice(keepFirst, messages.length - keepLast)

  if (middleMessages.length === 0) {
    return { messages, compressed: false, removedCount: 0, summaryAdded: false }
  }

  // Собираем текст для резюме
  const summaryText = middleMessages
    .map(m => `${m.role === 'user' ? 'Пользователь' : 'AI'}: ${m.content.slice(0, 500)}`)
    .join('\n')

  // Резюме добавляем как system-сообщение
  const summaryMsg: ChatMessage = {
    role: 'system',
    content: `[Summary — сжатая история ${middleMessages.length} сообщений]:\n${summaryText.slice(0, 2000)}\n[/Summary]`,
  }

  const compressed = [...headMessages, summaryMsg, ...tailMessages]
  return {
    messages: compressed,
    compressed: true,
    removedCount: middleMessages.length,
    summaryAdded: true,
  }
}

/**
 * Для summary с AI — запрашиваем настоящее резюме через отдельный вызов.
 * Возвращает промпт для малой модели.
 */
export function buildSummaryPrompt(messages: ChatMessage[]): string {
  const text = messages
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 800)}`)
    .join('\n\n')
  return `Сделай краткое резюме этого фрагмента разговора в 3-5 предложениях. Сохрани ключевые факты, решения и выводы. Не добавляй ничего лишнего.\n\n${text}`
}

// ─── 3. TOKEN COUNTER ────────────────────────────────────────────────────────

export interface TokenUsage {
  estimated: number
  limit: number
  pct: number        // 0-100
  status: 'ok' | 'warn' | 'critical'  // ok < 60%, warn < 85%, critical >= 85%
}

export function calcTokenUsage(messages: ChatMessage[], limitTokens: number): TokenUsage {
  const estimated = estimateMessagesTokens(messages)
  const pct = Math.min(100, Math.round(estimated / limitTokens * 100))
  const status = pct >= 85 ? 'critical' : pct >= 60 ? 'warn' : 'ok'
  return { estimated, limit: limitTokens, pct, status }
}

// ─── 4. STRUCTURED AGENT STATE ───────────────────────────────────────────────

export interface AgentState {
  task: string
  completedSteps: string[]
  currentStep: string
  keyFindings: Record<string, string>
  pendingActions: string[]
  iterCount: number
}

export function buildAgentStateBlock(state: AgentState): string {
  return [
    `[Agent State]`,
    `Task: ${state.task}`,
    state.completedSteps.length > 0 ? `Done: ${state.completedSteps.join(' | ')}` : '',
    `Current: ${state.currentStep}`,
    Object.keys(state.keyFindings).length > 0
      ? `Findings: ${Object.entries(state.keyFindings).map(([k, v]) => `${k}=${v}`).join('; ')}`
      : '',
    state.pendingActions.length > 0 ? `Next: ${state.pendingActions.join(', ')}` : '',
    `[/Agent State]`,
  ].filter(Boolean).join('\n')
}

export function getContextSettings(storeData: Record<string, unknown>): ContextSettings {
  const saved = (storeData.contextSettings ?? {}) as Partial<ContextSettings>
  return { ...DEFAULT_CONTEXT_SETTINGS, ...saved }
}
