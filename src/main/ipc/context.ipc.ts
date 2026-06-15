import { ipcMain } from 'electron'
import type Store from 'electron-store'
import { getMessages } from '../../core/db/database'
import { getAllMemoriesForContext } from '../../core/memory/MemoryEngine'
import { countTokens, countMessages } from '../../core/tokens/TokenCounter'
import { getContextLimit } from '../../core/tokens/ModelContextLimits'
import { getModelPrice, estimateCost } from '../../core/tokens/ModelPricing'
import { buildSystemPrompt } from '../../core/prompts/buildSystemPrompt'
import type { AgentSettings, Message } from '../../shared/types'

const RESERVED_FOR_OUTPUT = 2000

export interface ContextInfo {
  systemPrompt: number
  history: number
  historyMessages: number
  toolCallsTokens: number    // токены tool_calls в истории
  toolCallsCount: number     // кол-во вызовов инструментов
  currentInput: number
  reserved: number
  total: number
  limit: number
  percent: number
  pricing: { inputPerM: number; outputPerM: number } | null
  estimatedCostCents: number | null
  sessionCostCents: number | null  // накопленная стоимость сессии
  sessionRequests: number          // кол-во запросов в сессии
  modelId: string
  warning: boolean
  critical: boolean
}

// Накапливаем стоимость сессий в памяти (сбрасывается при перезапуске)
const sessionCosts: Record<string, { totalCents: number; requests: number }> = {}

export function addSessionCost(chatId: string, inputTokens: number, outputTokens: number, modelId: string): void {
  const pricing = getModelPrice(modelId)
  if (!pricing) return
  const cents = (inputTokens / 1_000_000) * pricing.inputPerM + (outputTokens / 1_000_000) * pricing.outputPerM
  if (!sessionCosts[chatId]) sessionCosts[chatId] = { totalCents: 0, requests: 0 }
  sessionCosts[chatId].totalCents += cents
  sessionCosts[chatId].requests += 1
}

export function registerContextIPC(store: Store): void {
  ipcMain.handle('context:calculate', (_, params: {
    chatId: string
    currentInput: string
    modelId: string
    incognito?: boolean
  }): ContextInfo => {
    const { chatId, currentInput, modelId, incognito } = params

    // System prompt — те же данные что и в ai-worker
    const userName = store.get('userName') as string || ''
    let memoryContext = ''
    try {
      memoryContext = getAllMemoriesForContext()
    } catch { /* нет памяти — не критично */ }

    const systemPromptText = buildSystemPrompt({ userName, memoryContext })
    const systemPromptTokens = countTokens(systemPromptText)

    // История чата + tool_calls токены
    const agentSettings = store.get('agentSettings', {}) as AgentSettings
    let historyTokens = 0
    let historyMsgCount = 0
    let toolCallsTokens = 0
    let toolCallsCount = 0

    if (!incognito && chatId) {
      try {
        const messages = getMessages(chatId) as Message[]
        const slice = messages.slice(-10)

        historyTokens = countMessages(slice.map(m => ({ role: m.role, content: m.content })))
        historyMsgCount = slice.length

        // Считаем токены tool_steps (tool_call + tool_result JSON)
        for (const msg of slice) {
          if (msg.toolSteps?.length) {
            for (const step of msg.toolSteps) {
              const stepText = JSON.stringify(step)
              toolCallsTokens += countTokens(stepText)
              if (step.type === 'tool_call') toolCallsCount++
            }
          }
        }
      } catch { /* DB ошибка — не критично */ }
    }

    // Текущий ввод
    const inputTokens = countTokens(currentInput)

    // Итого
    const total = systemPromptTokens + historyTokens + toolCallsTokens + inputTokens + RESERVED_FOR_OUTPUT
    const limit = getContextLimit(modelId)
    const percent = limit > 0 ? Math.min(100, (total / limit) * 100) : 0

    // Цены
    const pricing = getModelPrice(modelId)
    const estimatedCostCents = estimateCost(total, RESERVED_FOR_OUTPUT, modelId)

    // Стоимость сессии
    const sess = sessionCosts[chatId]
    const sessionCostCents = sess ? sess.totalCents : null
    const sessionRequests = sess ? sess.requests : 0

    return {
      systemPrompt: systemPromptTokens,
      history: historyTokens,
      historyMessages: historyMsgCount,
      toolCallsTokens,
      toolCallsCount,
      currentInput: inputTokens,
      reserved: RESERVED_FOR_OUTPUT,
      total,
      limit,
      percent,
      pricing,
      estimatedCostCents,
      sessionCostCents,
      sessionRequests,
      modelId,
      warning: percent > 80,
      critical: percent > 95,
    }
  })
}
