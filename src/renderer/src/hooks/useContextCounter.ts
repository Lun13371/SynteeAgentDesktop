import { useState, useEffect, useRef, useCallback } from 'react'

export interface ContextInfo {
  systemPrompt: number
  history: number
  historyMessages: number
  toolCallsTokens: number
  toolCallsCount: number
  currentInput: number
  reserved: number
  total: number
  limit: number
  percent: number
  pricing: { inputPerM: number; outputPerM: number } | null
  estimatedCostCents: number | null
  sessionCostCents: number | null
  sessionRequests: number
  modelId: string
  warning: boolean
  critical: boolean
}

interface UseContextCounterOptions {
  chatId: string
  currentInput: string
  modelId: string
  incognito?: boolean
  enabled?: boolean
  messageCount?: number // меняется при новых сообщениях → триггер пересчёта
}

export function useContextCounter({
  chatId,
  currentInput,
  modelId,
  incognito,
  enabled = true,
  messageCount = 0,
}: UseContextCounterOptions) {
  const [info, setInfo] = useState<ContextInfo | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastInputRef = useRef('')

  const calculate = useCallback(async () => {
    if (!enabled || !chatId) return
    try {
      const result = await window.syntee.context.calculate({
        chatId,
        currentInput,
        modelId,
        incognito,
      })
      setInfo(result as ContextInfo)
    } catch {
      // тихо — не критично
    }
  }, [chatId, currentInput, modelId, incognito, enabled])

  // При изменении input — debounce 500мс
  useEffect(() => {
    if (!enabled) return
    if (currentInput === lastInputRef.current) return
    lastInputRef.current = currentInput

    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(calculate, 500)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [currentInput, calculate, enabled])

  // При новых сообщениях — считаем сразу
  useEffect(() => {
    if (!enabled) return
    calculate()
  }, [messageCount, chatId, enabled, calculate])

  // Фоновый пересчёт каждые 5 секунд
  useEffect(() => {
    if (!enabled) return
    timerRef.current = setInterval(calculate, 5000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [calculate, enabled])

  return info
}
