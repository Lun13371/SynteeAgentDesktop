import { useState, useEffect, useRef } from 'react'
import { IPC_EVENTS } from '@shared/constants'

/**
 * Контекст-информация для ContextRing.
 * Формируется из push-событий context:usage (реальные/оценочные данные от main)
 * + локальная надбавка за текущий ввод (для live-обновления при печати).
 */
export interface ContextInfo {
  estimated: number         // всего токенов (история + system + tools + input)
  limit: number
  percent: number
  source: 'real' | 'estimate'
  breakdown: {
    history: number
    system: number
    tools: number
    current: number
    toolResults?: number
    completionTokens?: number
  }
  sessionCostCents: number | null
  sessionRequests: number
  // Поля для совместимости с ContextRing.tsx (legacy naming)
  total: number
  modelId: string
  warning: boolean
  critical: boolean
  systemPrompt: number
  history: number
  historyMessages: number
  toolCallsTokens: number
  toolCallsCount: number
  currentInput: number
  reserved: number
  pricing: { inputPerM: number; outputPerM: number } | null
  estimatedCostCents: number | null
  compressed?: boolean
}

interface UseContextCounterOptions {
  chatId: string
  currentInput: string
  modelId: string
  incognito?: boolean
  enabled?: boolean
  messageCount?: number
}

interface UsagePush {
  pct: number
  estimated: number
  limit: number
  status: 'ok' | 'warn' | 'critical'
  source?: 'real' | 'estimate'
  compressed?: boolean
  breakdown?: {
    history: number
    system: number
    tools: number
    current: number
    toolResults?: number
    completionTokens?: number
    real?: boolean
  }
  sessionCostCents?: number | null
  sessionRequests?: number
}

export function useContextCounter({
  chatId,
  currentInput,
  modelId,
  enabled = true,
}: UseContextCounterOptions) {
  const [info, setInfo] = useState<ContextInfo | null>(null)
  const lastPushRef = useRef<UsagePush | null>(null)
  const inputTokensRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Подписка на push-события context:usage из main (заменяет polling context:calculate)
  useEffect(() => {
    if (!enabled) return
    const handler = (data: UsagePush) => {
      lastPushRef.current = data
      setInfo(buildContextInfo(data, inputTokensRef.current, modelId))
    }
    const off = window.syntee.on(IPC_EVENTS.CONTEXT_USAGE, handler as (...args: unknown[]) => void)
    return off
  }, [enabled, modelId])

  // Live-обновление при печати — лёгкий estimateInput (только текущий текст, без истории)
  useEffect(() => {
    if (!enabled) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      try {
        const result = await window.syntee.context.estimateInput({ text: currentInput }) as { tokens: number }
        inputTokensRef.current = result.tokens
        if (lastPushRef.current) {
          setInfo(buildContextInfo(lastPushRef.current, result.tokens, modelId))
        }
      } catch {
        // тихо — не критично
      }
    }, 500)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [currentInput, enabled, modelId])

  return info
}

function buildContextInfo(push: UsagePush, inputTokens: number, modelId: string): ContextInfo {
  const breakdown = push.breakdown ?? { history: 0, system: 0, tools: 0, current: 0 }
  // Добавляем токены текущего ввода к estimate (если ещё не учтены)
  const currentInputTokens = Math.max(0, inputTokens - (breakdown.current ?? 0))
  const total = push.estimated + currentInputTokens
  const percent = push.limit > 0 ? Math.min(100, (total / push.limit) * 100) : push.pct

  return {
    estimated: total,
    limit: push.limit,
    percent,
    source: push.source ?? (breakdown.real ? 'real' : 'estimate'),
    breakdown,
    sessionCostCents: push.sessionCostCents ?? null,
    sessionRequests: push.sessionRequests ?? 0,
    // Legacy поля для ContextRing
    total,
    modelId,
    warning: percent > 80,
    critical: percent > 95,
    systemPrompt: breakdown.system,
    history: breakdown.history,
    historyMessages: 0,
    toolCallsTokens: breakdown.tools,
    toolCallsCount: 0,
    currentInput: inputTokens,
    reserved: 2000,
    pricing: null,
    estimatedCostCents: null,
    compressed: push.compressed,
  }
}
