import { ipcMain } from 'electron'
import type Store from 'electron-store'
import { getMessages, getWorkingMemory } from '../../core/db/database'
import { getAllMemoriesForContext } from '../../core/memory/MemoryEngine'
import { countTokens, countMessages } from '../../core/tokens/TokenCounter'
import { getContextLimit } from '../../core/tokens/ModelContextLimits'
import { getModelPrice, estimateCost } from '../../core/tokens/ModelPricing'
import { buildSystemPrompt } from '../../core/prompts/buildSystemPrompt'
import { TOOL_SCHEMAS_OVERHEAD } from '../../core/context/contextManager'
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

    // System prompt — ТОЧНО такой же как в реальном запросе (с working memory)
    const userName = store.get('userName') as string || ''
    let memoryContext = ''
    let workingMemory = ''
    try { memoryContext = getAllMemoriesForContext() } catch { /* ok */ }
    try { if (chatId) workingMemory = getWorkingMemory(chatId) } catch { /* ok */ }
    const systemPromptText = buildSystemPrompt({ userName, memoryContext, workingMemory })
    const systemPromptTokens = countTokens(systemPromptText)

    // История — только m.content как в реальном запросе (toolSteps НЕ идут в API)
    let historyTokens = 0
    let historyMsgCount = 0

    if (!incognito && chatId) {
      try {
        const messages = getMessages(chatId) as Message[]
        historyTokens = countMessages(messages.map(m => ({ role: m.role, content: m.content })))
        historyMsgCount = messages.length
      } catch { /* DB ошибка — не критично */ }
    }

    // Текущий ввод
    const inputTokens = countTokens(currentInput)

    // Tool schemas — всегда присутствуют в запросе
    const toolSchemasTokens = TOOL_SCHEMAS_OVERHEAD

    // Итого — точно то что пойдёт в следующий запрос
    const total = systemPromptTokens + historyTokens + inputTokens + toolSchemasTokens + RESERVED_FOR_OUTPUT
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
      toolCallsTokens: toolSchemasTokens,  // теперь это tool schemas overhead
      toolCallsCount: 0,                    // не считаем отдельно
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
