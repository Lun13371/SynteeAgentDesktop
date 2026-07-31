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
    cacheReadTokens?: number
    cacheWriteTokens?: number
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
  /** Активен ли run (стриминг/тулы). При true live-typing токены НЕ
   *  добавляются поверх real usage — они уже учтены в следующем раунде.
   *  Убирает последний источник прыжков кольца mid-stream. */
  isRunning?: boolean
}

interface UsagePush {
  chatId?: string
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
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  sessionCostCents?: number | null
  sessionRequests?: number
  // Fix 6: метаданные для ContextRing (раньше захардкожены в 0)
  historyMessages?: number
  toolCallsCount?: number
}

export function useContextCounter({
  chatId,
  currentInput,
  modelId,
  enabled = true,
  isRunning = false,
}: UseContextCounterOptions) {
  const [info, setInfo] = useState<ContextInfo | null>(null)
  const lastPushRef = useRef<UsagePush | null>(null)
  const inputTokensRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Phase 4: real-priority — после первого real usage храним его и не
  // перетираем estimate'ом context:calculate. Как у opencode: real
  // usage — источник истины после первого ответа модели.
  const lastRealRef = useRef<UsagePush | null>(null)
  const isRunningRef = useRef(isRunning)
  useEffect(() => { isRunningRef.current = isRunning }, [isRunning])

  // Подписка на push-события context:usage из main (заменяет polling context:calculate)
  useEffect(() => {
    if (!enabled) return
    const handler = (data: UsagePush) => {
      // Fix 6: игнорируем push от другого чата (защита от race-condition
      // при быстрой смене чатов A→B→C, когда ответ от A приходит позже).
      if (data.chatId && chatId && data.chatId !== chatId) return
      lastPushRef.current = data
      // Phase 4: real-priority — real usage от провайдера храним отдельно;
      // estimate от context:calculate игнорируем, если уже есть real.
      if (data.source === 'real') {
        lastRealRef.current = data
      } else if (lastRealRef.current) {
        // Уже есть real snapshot для этого чата — estimate не перетирает его
        // (как в opencode: real — источник истины после первого ответа).
        return
      }
      setInfo(buildContextInfo(data, inputTokensRef.current, modelId, isRunningRef.current))
    }
    const off = window.syntee.on(IPC_EVENTS.CONTEXT_USAGE, handler as (...args: unknown[]) => void)
    return off
  }, [enabled, modelId, chatId])

  // Fix 6: сброс при смене чата + запросить свежий расчёт контекста из main.
  // Без этого info висит пустым (или показывает данные предыдущего чата),
  // пока пользователь не отправит первое сообщение — main эмитит CONTEXT_USAGE
  // только в chat:send.
  useEffect(() => {
    if (!enabled || !chatId) return
    setInfo(null)
    lastPushRef.current = null
    lastRealRef.current = null
    inputTokensRef.current = 0
    // Просим main пересчитать контекст для нового чата — он эмитит CONTEXT_USAGE
    window.syntee.context.calculate(chatId).catch(() => { /* тихо — не критично */ })
  }, [chatId, enabled])

  // Live-обновление при печати — лёгкий estimateInput (только текущий текст, без истории)
  useEffect(() => {
    if (!enabled) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      try {
        const result = await window.syntee.context.estimateInput({ text: currentInput }) as { tokens: number }
        inputTokensRef.current = result.tokens
        // Покрываем real (если есть) и последний estimate. Для real во время
        // run'а live-typing НЕ добавляем (isRunning gate) — токены текущего
        // ввода станут историей только в следующем раунде.
        const base = lastRealRef.current ?? lastPushRef.current
        if (base) {
          setInfo(buildContextInfo(base, result.tokens, modelId, isRunningRef.current))
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

function buildContextInfo(push: UsagePush, inputTokens: number, modelId: string, isRunning = false): ContextInfo {
  const breakdown = push.breakdown ?? { history: 0, system: 0, tools: 0, current: 0 }
  // Добавляем токены текущего ввода к estimate. При real usage во время
  // активного run'а (isRunning) НЕ добавляем — реальный promptTokens уже
  // содержит всё отправленное, а текущий ввод относится к СЛЕДУЮЩЕМУ
  // сообщению и будет учтён в следующем onContextCounted. Это убирает
  // прыжки: real показывал X, пользователь печатал → кольцо ползло вверх,
  // потом onContextCounted возвращал обратно.
  const addLive = !(push.source === 'real' && isRunning)
  const currentInputTokens = addLive ? Math.max(0, inputTokens - (breakdown.current ?? 0)) : 0
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
    historyMessages: push.historyMessages ?? 0,
    toolCallsTokens: breakdown.tools,
    toolCallsCount: push.toolCallsCount ?? 0,
    currentInput: inputTokens,
    reserved: 2000,
    pricing: null,
    estimatedCostCents: null,
    compressed: push.compressed,
  }
}
