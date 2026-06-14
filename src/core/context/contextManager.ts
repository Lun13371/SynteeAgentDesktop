/**
 * Context Manager — управление контекстом чата и результатами тулов.
 * Использует js-tiktoken для точного подсчёта токенов (cl100k_base — стандарт OpenAI/Anthropic/Gemini).
 */

import { getEncoding } from 'js-tiktoken'

// Кешируем энкодер — инициализация ~50ms, потом мгновенно
let _enc: ReturnType<typeof getEncoding> | null = null
function getEncoder(): ReturnType<typeof getEncoding> {
  if (!_enc) _enc = getEncoding('cl100k_base')
  return _enc
}

// ─── ТОЧНЫЙ ПОДСЧЁТ ТОКЕНОВ через tiktoken ───────────────────────────────────

export function estimateTokens(text: string): number {
  if (!text) return 0
  try {
    return getEncoder().encode(text).length
  } catch {
    // fallback если tiktoken упал (очень редко)
    return Math.ceil(text.length / 3.5)
  }
}

export function estimateMessagesTokens(messages: Array<{ role: string; content: string }>): number {
  // Каждое сообщение = ~4 служебных токена (role, разделители) + контент
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0)
}

// ─── OVERHEAD: реальные постоянные расходы контекста ─────────────────────────

// system prompt buildSystemPrompt ≈ 500-700 токенов (считаем точнее ниже)
// tool schemas (20+ тулов) ≈ 3500-4000 токенов
// служебные структуры OpenAI API ≈ 100 токенов
const TOOL_SCHEMAS_OVERHEAD = 3800  // токены на tool schemas (постоянный overhead)
const API_OVERHEAD = 100            // служебные токены протокола

export function calcSystemPromptTokens(systemPrompt: string): number {
  return estimateTokens(systemPrompt) + 4  // +4 служебных
}

// ─── ПОЛУЧЕНИЕ contextWindow ОТ АКТИВНОЙ МОДЕЛИ ──────────────────────────────

import { BUILTIN_MODELS } from '../../shared/data/builtinModels'
import type { ModelMeta, ModelAssignment } from '../../shared/types'

export function getModelContextWindow(storeData: Record<string, unknown>): number {
  const assignments = storeData.modelAssignments as ModelAssignment[] | undefined
  const mainAssignment = assignments?.find(a => a.role === 'main')
  if (!mainAssignment?.modelId) return 200_000  // разумный дефолт

  const modelId = mainAssignment.modelId

  // 1. Ищем в builtin моделях
  const builtin = BUILTIN_MODELS.find(m => m.id === modelId)
  if (builtin?.contextWindow && builtin.contextWindow > 0) return builtin.contextWindow

  // 2. Ищем в кастомных моделях
  const customModels = storeData.customModels as ModelMeta[] | undefined
  const custom = customModels?.find(m => m.id === modelId)
  if (custom?.contextWindow && custom.contextWindow > 0) return custom.contextWindow

  // 3. Эвристика по имени модели
  const id = modelId.toLowerCase()
  if (id.includes('gemini-2.5') || id.includes('gpt-4.1')) return 1_000_000
  if (id.includes('claude') || id.includes('gpt-4o') || id.includes('o3') || id.includes('o4')) return 200_000
  if (id.includes('gemini')) return 1_000_000
  if (id.includes('deepseek')) return 64_000
  if (id.includes('llama') || id.includes('grok')) return 128_000

  return 200_000  // безопасный дефолт
}

// ─── НАСТРОЙКИ КОНТЕКСТА ──────────────────────────────────────────────────────

export interface ContextSettings {
  // Tool truncation
  toolTruncEnabled: boolean
  toolMaxChars: number        // макс символов на один tool result (дефолт 4000)

  // Rolling window + summary
  rollingEnabled: boolean
  rollingTriggerPct: number   // % заполненности контекста для триггера (дефолт 75)
  rollingKeepFirst: number    // сколько первых сообщений всегда сохранять (дефолт 2)
  rollingKeepLast: number     // сколько последних сообщений всегда сохранять (дефолт 12)
  contextLimitTokens: number  // лимит токенов модели — теперь берётся из провайдера

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
  contextLimitTokens: 200_000,  // дефолт — перекрывается реальным из провайдера
  tokenCounterEnabled: true,
}

export function getContextSettings(input: Record<string, unknown> | Partial<ContextSettings>): ContextSettings {
  const rec = input as Record<string, unknown>
  const saved = ('toolTruncEnabled' in rec || 'rollingEnabled' in rec || 'tokenCounterEnabled' in rec)
    ? rec as Partial<ContextSettings>
    : (rec['contextSettings'] ?? {}) as Partial<ContextSettings>
  return { ...DEFAULT_CONTEXT_SETTINGS, ...saved }
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

export function buildSummaryPrompt(messages: ChatMessage[]): string {
  const text = messages
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 800)}`)
    .join('\n\n')
  return `Сделай краткое резюме этого фрагмента разговора в 3-5 предложениях. Сохрани ключевые факты, решения и выводы. Не добавляй ничего лишнего.\n\n${text}`
}

export async function applyRollingWindowAsync(
  messages: ChatMessage[],
  settings: Pick<ContextSettings, 'rollingKeepFirst' | 'rollingKeepLast' | 'rollingTriggerPct' | 'contextLimitTokens'>,
  summaryFn?: (prompt: string) => Promise<string>,
): Promise<CompressResult> {
  const totalTokens = estimateMessagesTokens(messages)
  const limitTokens = settings.contextLimitTokens
  const triggerTokens = Math.floor(limitTokens * settings.rollingTriggerPct / 100)

  if (totalTokens < triggerTokens || messages.length <= settings.rollingKeepFirst + settings.rollingKeepLast) {
    return { messages, compressed: false, removedCount: 0, summaryAdded: false }
  }

  const keepFirst = settings.rollingKeepFirst
  const keepLast = settings.rollingKeepLast
  const headMessages = messages.slice(0, keepFirst)
  const tailMessages = messages.slice(messages.length - keepLast)
  const middleMessages = messages.slice(keepFirst, messages.length - keepLast)

  if (middleMessages.length === 0) {
    return { messages, compressed: false, removedCount: 0, summaryAdded: false }
  }

  let summaryContent: string
  if (summaryFn) {
    try {
      const prompt = buildSummaryPrompt(middleMessages)
      summaryContent = await summaryFn(prompt)
    } catch {
      summaryContent = middleMessages
        .map(m => `${m.role === 'user' ? 'Пользователь' : 'AI'}: ${m.content.slice(0, 300)}`)
        .join('\n')
        .slice(0, 1500)
    }
  } else {
    summaryContent = middleMessages
      .map(m => `${m.role === 'user' ? 'Пользователь' : 'AI'}: ${m.content.slice(0, 300)}`)
      .join('\n')
      .slice(0, 1500)
  }

  const summaryMsg: ChatMessage = {
    role: 'system',
    content: `[Резюме предыдущего разговора (${middleMessages.length} сообщений сжаты)]:\n${summaryContent}\n[/Резюме]`,
  }

  return {
    messages: [...headMessages, summaryMsg, ...tailMessages],
    compressed: true,
    removedCount: middleMessages.length,
    summaryAdded: true,
  }
}

// ─── 3. TOKEN COUNTER — ПОЛНЫЙ РЕАЛЬНЫЙ ПОДСЧЁТ ──────────────────────────────

export interface TokenUsage {
  estimated: number           // реальная оценка через tiktoken
  historyTokens: number       // токены истории
  systemPromptTokens: number  // токены system prompt
  toolSchemasTokens: number   // токены tool schemas (константа)
  currentMsgTokens: number    // токены текущего сообщения
  limit: number               // лимит контекста модели
  pct: number                 // 0-100
  status: 'ok' | 'warn' | 'critical'
}

export function calcTokenUsage(
  messages: ChatMessage[],
  limitTokens: number,
  opts: {
    systemPrompt?: string
    currentMsgTokens?: number
    includeToolSchemas?: boolean
  } = {}
): TokenUsage {
  const historyTokens = estimateMessagesTokens(messages)
  const systemPromptTokens = opts.systemPrompt ? calcSystemPromptTokens(opts.systemPrompt) : 600
  const toolSchemasTokens = opts.includeToolSchemas !== false ? TOOL_SCHEMAS_OVERHEAD : 0
  const currentMsgTokens = opts.currentMsgTokens ?? 0

  const estimated = historyTokens + systemPromptTokens + toolSchemasTokens + currentMsgTokens + API_OVERHEAD
  const pct = Math.min(100, Math.round(estimated / limitTokens * 100))
  const status = pct >= 85 ? 'critical' : pct >= 60 ? 'warn' : 'ok'

  return { estimated, historyTokens, systemPromptTokens, toolSchemasTokens, currentMsgTokens, limit: limitTokens, pct, status }
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
