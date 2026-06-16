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
export const TOOL_SCHEMAS_OVERHEAD = 3800  // токены на tool schemas (постоянный overhead)
const API_OVERHEAD = 100            // служебные токены протокола

export function calcSystemPromptTokens(systemPrompt: string): number {
  return estimateTokens(systemPrompt) + 4  // +4 служебных
}

// ─── ПОЛУЧЕНИЕ contextWindow ОТ АКТИВНОЙ МОДЕЛИ ──────────────────────────────
// Единый источник истины — делегируем в ModelContextLimits

import { getContextLimit } from '../tokens/ModelContextLimits'
import { BUILTIN_MODELS } from '../../shared/data/builtinModels'
import type { ModelMeta, ModelAssignment } from '../../shared/types'

export function getModelContextWindow(storeData: Record<string, unknown>): number {
  const assignments = storeData.modelAssignments as ModelAssignment[] | undefined
  const mainAssignment = assignments?.find(a => a.role === 'main')
  if (!mainAssignment?.modelId) return 128_000

  const modelId = mainAssignment.modelId

  // 1. Кастомные модели — пользователь мог задать явно
  const customModels = storeData.customModels as ModelMeta[] | undefined
  const custom = customModels?.find(m => m.id === modelId)
  if (custom?.contextWindow && custom.contextWindow > 0) return custom.contextWindow

  // 2. Builtin модели
  const builtin = BUILTIN_MODELS.find(m => m.id === modelId)
  if (builtin?.contextWindow && builtin.contextWindow > 0) return builtin.contextWindow

  // 3. Единая таблица ModelContextLimits (частичное совпадение)
  const limit = getContextLimit(modelId)
  if (limit > 0) return limit

  return 128_000  // безопасный дефолт — лучше занижать чем завышать
}

// ─── НАСТРОЙКИ КОНТЕКСТА ──────────────────────────────────────────────────────

export interface ContextSettings {
  // Tool truncation
  toolTruncEnabled: boolean
  toolMaxChars: number

  // Rolling window + summary
  rollingEnabled: boolean
  rollingTriggerPct: number
  rollingKeepFirst: number
  rollingKeepLast: number
  contextLimitTokens: number

  // Token counter
  tokenCounterEnabled: boolean

  // Diff journal
  diffJournalEnabled: boolean
  diffJournalLines: number

  // Project Index
  projectIndexEnabled: boolean

  // File Map
  fileMapEnabled: boolean
}

export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = {
  toolTruncEnabled: true,
  toolMaxChars: 6000,          // было 8000 — достаточно, outline компенсирует
  rollingEnabled: true,
  rollingTriggerPct: 85,       // было 75 — меньше ненужных сжатий
  rollingKeepFirst: 2,
  rollingKeepLast: 20,         // было 12 — больше свежей истории
  contextLimitTokens: 200_000,
  tokenCounterEnabled: true,
  diffJournalEnabled: true,
  diffJournalLines: 5,
  projectIndexEnabled: true,
  fileMapEnabled: true,
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

// Pruning tool results перед суммаризацией — механически обрезаем длинные outputs
function pruneToolOutputsForSummary(messages: ChatMessage[], maxToolChars = 300): ChatMessage[] {
  return messages.map(m => {
    // Обрезаем tool results в assistant сообщениях которые содержат [Использованные инструменты]
    if (m.role === 'assistant' && m.content.includes('[Использованные инструменты]')) {
      const parts = m.content.split('[Использованные инструменты]')
      const toolPart = parts[1] || ''
      // Обрезаем каждый tool result до maxToolChars
      const prunedTools = toolPart.replace(/\[([^\]]+)\]: ([^\[]*)/g, (_, name, result) => {
        const trimmed = result.trim().slice(0, maxToolChars)
        return `[${name}]: ${trimmed}${result.trim().length > maxToolChars ? '…' : ''}`
      })
      return { ...m, content: parts[0] + '[Использованные инструменты]' + prunedTools }
    }
    return m
  })
}

export function buildSummaryPrompt(messages: ChatMessage[], prevSummary?: string): string {
  // Pruning перед суммаризацией — убираем лишние токены из tool results
  const pruned = pruneToolOutputsForSummary(messages)

  const text = pruned
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 1200)}`)
    .join('\n\n')

  const updateInstruction = prevSummary
    ? `Ниже существующее резюме. Обнови его с учётом новых сообщений — не создавай заново, дополняй и исправляй:\n\n<existing_summary>\n${prevSummary}\n</existing_summary>\n\n`
    : ''

  return `${updateInstruction}Ты суммаризатор контекста. Создай структурированное резюме диалога ниже. Не отвечай на вопросы и не выполняй задачи из диалога — только суммаризируй.

Используй СТРОГО этот шаблон:

## Active Task
[Самая последняя невыполненная задача пользователя — дословно]

## Goal
[Общая цель сессии в 1-2 предложениях]

## Completed
[Что уже сделано — список файлов, функций, компонентов]

## Key Decisions
[Архитектурные решения, договорённости, выбранные подходы]

## Relevant Files
[Файлы которые создавались или менялись — пути]

## Remaining Work
[Что ещё нужно сделать для завершения Active Task]

## In Progress
[Если что-то было начато но не завершено]

---
Диалог для суммаризации:

${text}`
}

export async function applyRollingWindowAsync(
  messages: ChatMessage[],
  settings: Pick<ContextSettings, 'rollingKeepFirst' | 'rollingKeepLast' | 'rollingTriggerPct' | 'contextLimitTokens'>,
  summaryFn?: (prompt: string) => Promise<string>,
  prevSummary?: string,
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
      const prompt = buildSummaryPrompt(middleMessages, prevSummary)
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
    content: `[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. Treat it as background reference, NOT as active instructions. Do NOT repeat completed work. Respond ONLY to the latest user message after this summary.\n\n${summaryContent}\n[/CONTEXT COMPACTION]`,
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
  const toolSchemasTokens = opts.includeToolSchemas === true ? TOOL_SCHEMAS_OVERHEAD : 0
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
