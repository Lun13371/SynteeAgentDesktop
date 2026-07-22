/**
 * Usage Tracker — единый источник истины для подсчёта токенов и стоимости сессии.
 *
 * Заменяет TokenCounter.ts (удалён) и дублирующий encoder из contextManager.ts.
 * Использует js-tiktoken (cl100k_base) с кэшированным энкодером.
 *
 * Реальные usage-данные от провайдера имеют приоритет над tiktoken-оценкой.
 * Сессионная стоимость накапливается в памяти (живёт пока жив процесс).
 */

import { getEncoding } from 'js-tiktoken'
import { getCatalogModel } from './modelCatalog'
import { BUILTIN_MODELS } from '../../shared/data/builtinModels'
import { getModelPrice as getModelPriceStatic, type ModelPrice } from './ModelPricing'

// ─── Кэшированный энкодер ──────────────────────────────────────────────────────

let _enc: ReturnType<typeof getEncoding> | null = null
function getEncoder(): ReturnType<typeof getEncoding> {
  if (!_enc) _enc = getEncoding('cl100k_base')
  return _enc
}

// ─── Точные оценки через tiktoken ──────────────────────────────────────────────

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

// ─── Единые пороги компакции контекста ────────────────────────────────────────
// Раньше Agent.ts (аварийный клапан dropOldestRoundsIfOverflow) и
// chat.ipc.ts (applyRollingWindowAsync) считали пороги по-разному и от разных
// оценок contextWindow (Agent.ts занижал пол до 32k) — это давало пилообразные
// скачки реального prompt_tokens. Теперь оба места берут проценты отсюда.

// Аварийный клапан — последняя линия защиты от hard-fail API. Держим близко
// к 100%, он не должен быть рабочим механизмом компакции (эту роль играет
// rolling window).
export const HARD_LIMIT_PCT = 99
// После срабатывания клапана — целимся сюда (% от contextWindow, не от
// hard-лимита), с явным запасом (гистерезис), чтобы клапан не триггерился
// повторно на следующем же раунде из-за пары новых сообщений.
export const HARD_LIMIT_TARGET_PCT = 80

// Rolling window (между сообщениями пользователя, chat.ipc.ts) — срабатывает
// раньше аварийного клапана, с summary вместо жёсткого дропа.
export const ROLLING_TRIGGER_PCT = 92

export function getHardLimitTokens(contextWindow: number): number {
  return Math.floor(contextWindow * HARD_LIMIT_PCT / 100)
}

export function getHardLimitTargetTokens(contextWindow: number): number {
  return Math.floor(contextWindow * HARD_LIMIT_TARGET_PCT / 100)
}

// ─── Снапшоты использования ───────────────────────────────────────────────────

export interface RealUsage {
  promptTokens: number
  completionTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface UsageSnapshot {
  estimated: number
  limit: number
  pct: number
  status: 'ok' | 'warn' | 'critical'
  source: 'real' | 'estimate'
  breakdown: {
    history: number
    system: number
    tools: number
    current: number
    toolResults?: number
    completionTokens?: number
    // Prompt caching: токены, прочитанные из кэша (со скидкой) и записанные в кэш
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  compressed?: boolean
  sessionCostCents?: number | null
  sessionRequests?: number
}

// Overhead константы — единственный источник истины. contextManager.ts и
// Agent.ts импортируют TOOL_SCHEMAS_OVERHEAD отсюда (раньше значение было
// продублировано в нескольких местах с риском рассинхрона).
export const TOOL_SCHEMAS_OVERHEAD = 3800
const API_OVERHEAD = 100

export function buildSnapshotFromReal(
  real: RealUsage,
  limit: number,
  prevBreakdown?: UsageSnapshot['breakdown'],
): UsageSnapshot {
  const pct = Math.min(100, Math.round(real.promptTokens / limit * 100))
  const status = pct >= 85 ? 'critical' : pct >= 60 ? 'warn' : 'ok'
  return {
    estimated: real.promptTokens,
    limit,
    pct,
    status,
    source: 'real',
    breakdown: {
      history: prevBreakdown?.history ?? real.promptTokens,
      system: prevBreakdown?.system ?? 0,
      tools: prevBreakdown?.tools ?? 0,
      current: prevBreakdown?.current ?? 0,
      toolResults: prevBreakdown?.toolResults,
      completionTokens: real.completionTokens,
      cacheReadTokens: real.cacheReadTokens,
      cacheWriteTokens: real.cacheWriteTokens,
    },
  }
}

export function buildSnapshotFromEstimate(
  messages: Array<{ role: string; content: string }>,
  limit: number,
  opts: {
    systemPrompt?: string
    currentMsgTokens?: number
    toolResultTokens?: number
    includeToolSchemas?: boolean
  } = {},
): UsageSnapshot {
  const historyTokens = estimateMessagesTokens(messages)
  const systemPromptTokens = opts.systemPrompt ? estimateTokens(opts.systemPrompt) + 4 : 600
  const toolSchemasTokens = opts.includeToolSchemas === true ? TOOL_SCHEMAS_OVERHEAD : 0
  const currentMsgTokens = opts.currentMsgTokens ?? 0
  const toolResultTokens = opts.toolResultTokens ?? 0

  const estimated = historyTokens + systemPromptTokens + toolSchemasTokens + currentMsgTokens + toolResultTokens + API_OVERHEAD
  const pct = Math.min(100, Math.round(estimated / limit * 100))
  const status = pct >= 85 ? 'critical' : pct >= 60 ? 'warn' : 'ok'

  return {
    estimated,
    limit,
    pct,
    status,
    source: 'estimate',
    breakdown: {
      history: historyTokens,
      system: systemPromptTokens,
      tools: toolSchemasTokens,
      current: currentMsgTokens,
      toolResults: toolResultTokens > 0 ? toolResultTokens : undefined,
    },
  }
}

// ─── Сессионная стоимость ─────────────────────────────────────────────────────
// Map<chatId, { totalCents, requests }> — живёт пока жив процесс
const sessionCosts = new Map<string, { totalCents: number; requests: number }>()

export function recordSessionCost(
  chatId: string,
  providerId: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens?: number,
  cacheWriteTokens?: number,
): { totalCents: number; requests: number } | null {
  const pricing = getModelPriceInfo(providerId, modelId)
  if (!pricing) return null

  // Anthropic prompt caching тарификация:
  //   - input_tokens (non-cached) — полная цена (inputPerM)
  //   - cache_read_input_tokens   — цена со скидкой ~90% (cacheReadPerM)
  //   - cache_creation_input_tokens — премия ~25% (cacheWritePerM)
  //
  // Семантика promptTokens в колбэке onUsage:
  //   - OpenAI:   prompt_tokens = TOTAL (включая cached_tokens)
  //   - Anthropic: promptTokens = total (input + cacheRead + cacheWrite), т.к.
  //     AIClient нормализует: totalPrompt = input + cache_read + cache_creation
  //
  // Поэтому nonCachedInput = promptTokens - cacheRead - cacheWrite
  const nonCachedInput = Math.max(0, inputTokens - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0))
  let cents = (nonCachedInput / 1_000_000) * pricing.inputPerM
  cents += (outputTokens / 1_000_000) * pricing.outputPerM
  if (cacheReadTokens && pricing.cacheReadPerM) {
    cents += (cacheReadTokens / 1_000_000) * pricing.cacheReadPerM
  }
  if (cacheWriteTokens && pricing.cacheWritePerM) {
    cents += (cacheWriteTokens / 1_000_000) * pricing.cacheWritePerM
  }

  const entry = sessionCosts.get(chatId) ?? { totalCents: 0, requests: 0 }
  entry.totalCents += cents
  entry.requests += 1
  sessionCosts.set(chatId, entry)
  return { totalCents: entry.totalCents, requests: entry.requests }
}

export function getSessionCost(chatId: string): { totalCents: number; requests: number } | null {
  return sessionCosts.get(chatId) ?? null
}

export function resetSessionCost(chatId: string): void {
  sessionCosts.delete(chatId)
}

// ─── Цены моделей (catalog → builtin → static pricing table) ──────────────────

export function getModelPriceInfo(providerId: string, modelId: string): ModelPrice | null {
  if (!modelId) return null

  // 1. Каталог models.dev
  const fromCatalog = getCatalogModel(providerId, modelId)
  if (fromCatalog && (fromCatalog.inputPricePerM > 0 || fromCatalog.outputPricePerM > 0)) {
    return {
      inputPerM: fromCatalog.inputPricePerM,
      outputPerM: fromCatalog.outputPricePerM,
      cacheReadPerM: fromCatalog.cacheReadPerM,
      cacheWritePerM: fromCatalog.cacheWritePerM,
    }
  }

  // 2. Builtin модели (цены в $ за 1M → переводим в центы ×100)
  const builtin = BUILTIN_MODELS.find(m => m.id === modelId && (providerId ? m.providerId === providerId : true))
  if (builtin?.inputPrice != null && builtin?.outputPrice != null) {
    return { inputPerM: Math.round(builtin.inputPrice * 100), outputPerM: Math.round(builtin.outputPrice * 100) }
  }

  // 3. Статичная таблица ModelPricing (substring fallback)
  return getModelPriceStatic(modelId)
}

export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  providerId: string,
  modelId: string,
): number | null {
  const price = getModelPriceInfo(providerId, modelId)
  if (!price) return null
  return (inputTokens / 1_000_000) * price.inputPerM + (outputTokens / 1_000_000) * price.outputPerM
}
