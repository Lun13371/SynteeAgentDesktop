import { ipcMain } from 'electron'
import type Store from 'electron-store'
import { getMessages } from '../../core/db/database'
import { getAllMemoriesForContext } from '../../core/memory/MemoryEngine'
import { countTokens, countMessages } from '../../core/tokens/TokenCounter'
import { getContextLimit } from '../../core/tokens/ModelContextLimits'
import { getModelPrice, estimateCost } from '../../core/tokens/ModelPricing'
import type { AgentSettings } from '../../shared/types'

const RESERVED_FOR_OUTPUT = 2000

export interface ContextInfo {
  systemPrompt: number
  history: number
  historyMessages: number
  currentInput: number
  reserved: number
  total: number
  limit: number
  percent: number
  pricing: { inputPerM: number; outputPerM: number } | null
  estimatedCostCents: number | null
  modelId: string
  warning: boolean  // > 80%
  critical: boolean // > 95%
}

export function registerContextIPC(store: Store): void {
  ipcMain.handle('context:calculate', (_, params: {
    chatId: string
    currentInput: string
    modelId: string
    incognito?: boolean
  }): ContextInfo => {
    const { chatId, currentInput, modelId, incognito } = params

    // System prompt токены
    const userName = store.get('userName') as string || ''
    const memoryContext = getAllMemoriesForContext()
    const systemPromptText = buildSystemPromptText(userName, memoryContext)
    const systemPromptTokens = countTokens(systemPromptText)

    // История чата
    const agentSettings = store.get('agentSettings', {}) as AgentSettings
    let historyTokens = 0
    let historyMsgCount = 0

    if (!incognito && chatId) {
      const messages = getMessages(chatId)
      const slice = agentSettings.enableTools ? messages.slice(-10) : messages.slice(-20)
      historyTokens = countMessages(slice.map(m => ({ role: m.role, content: m.content })))
      historyMsgCount = slice.length
    }

    // Текущий ввод
    const inputTokens = countTokens(currentInput)

    // Итого
    const total = systemPromptTokens + historyTokens + inputTokens + RESERVED_FOR_OUTPUT
    const limit = getContextLimit(modelId)
    const percent = limit > 0 ? Math.min(100, (total / limit) * 100) : 0

    // Цены
    const pricing = getModelPrice(modelId)
    const estimatedCostCents = estimateCost(total, RESERVED_FOR_OUTPUT, modelId)

    return {
      systemPrompt: systemPromptTokens,
      history: historyTokens,
      historyMessages: historyMsgCount,
      currentInput: inputTokens,
      reserved: RESERVED_FOR_OUTPUT,
      total,
      limit,
      percent,
      pricing,
      estimatedCostCents,
      modelId,
      warning: percent > 80,
      critical: percent > 95,
    }
  })
}

function buildSystemPromptText(userName: string, memoryContext: string): string {
  return `Ты Syntee — персональный AI-ассистент для Windows. Умный, дружелюбный, с лёгким юмором.
${userName ? `Пользователя зовут ${userName}.` : ''}
${memoryContext || ''}
Дата и время: ${new Date().toLocaleString('ru')}.`
}
