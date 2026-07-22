/**
 * Конвертеры и детектор для нативного Anthropic Messages API пути.
 *
 * Anthropic использует формат, отличный от OpenAI Chat Completions:
 *   - system prompt — отдельный top-level параметр, не message в массиве
 *   - content — массив content-блоков ({type:'text'}, {type:'tool_use'}, {type:'tool_result'}, {type:'thinking'})
 *   - tools — {name, description, input_schema} вместо {type:'function', function:{...}}
 *   - tool results — role:'user' с {type:'tool_result'} блоками, не role:'tool'
 *
 * Prompt caching: cache_control:{type:'ephemeral'} на content-блоке system
 * и на последнем tool definition — кэширует статичный префикс (system + tools).
 */

import type { Provider } from '../../shared/types'

// ─── Детектор Anthropic-совместимого провайдера ──────────────────────────────

/**
 * Определяет, является ли провайдер Anthropic-совместимым.
 * Срабатывает по provider.type === 'anthropic' или по URL api.anthropic.com.
 * OnlySQ-прокси (type:'onlysq') НЕ матчится — остаётся на OpenAI-пути.
 */
export function isAnthropicProvider(provider: Provider | null | undefined): boolean {
  if (!provider) return false
  if (provider.type === 'anthropic') return true
  if (provider.baseUrl && provider.baseUrl.includes('api.anthropic.com')) return true
  return false
}

// ─── Типы для конвертации ────────────────────────────────────────────────────

interface CacheControl {
  type: 'ephemeral'
}

export interface AnthropicSystemBlock {
  type: 'text'
  text: string
  cache_control?: CacheControl
}

export interface AnthropicTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
  cache_control?: CacheControl
}

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | Array<Record<string, unknown>>
}

export interface AnthropicConverted {
  system: AnthropicSystemBlock[]
  messages: AnthropicMessage[]
}

// Входной тип сообщений (OpenAI-формат, как используется в Agent.ts)
interface OpenAIMessage {
  role: string
  content: string
  tool_calls?: unknown[]
  tool_call_id?: string
  name?: string
}

// ─── Конвертер tools: OpenAI → Anthropic ─────────────────────────────────────

/**
 * Конвертирует tools из OpenAI function-calling формата в Anthropic формат.
 * Ставит cache_control:{type:'ephemeral'} на ПОСЛЕДНИЙ tool — это кэширует
 * весь массив tools (Anthropic кэширует префикс до маркера включительно).
 *
 * OpenAI:  {type:'function', function:{name, description, parameters}}
 * Anthropic: {name, description, input_schema}
 */
export function convertToolsToAnthropic(tools: unknown[]): AnthropicTool[] {
  const result: AnthropicTool[] = []
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i] as {
      type?: string
      function?: {
        name?: string
        description?: string
        parameters?: Record<string, unknown>
      }
    }
    if (!t?.function) continue
    const tool: AnthropicTool = {
      name: t.function.name || '',
      description: t.function.description || '',
      input_schema: t.function.parameters || { type: 'object', properties: {} },
    }
    // cache_control на последний tool — кэширует весь массив tools
    if (i === tools.length - 1) {
      tool.cache_control = { type: 'ephemeral' }
    }
    result.push(tool)
  }
  return result
}

// ─── Конвертер messages: OpenAI → Anthropic ──────────────────────────────────

/**
 * Конвертирует messages из OpenAI формата в Anthropic {system, messages}.
 *
 * Ключевые отличия:
 *   - role:'system' → top-level system (с cache_control для prompt caching)
 *   - role:'tool'   → role:'user' с {type:'tool_result'} content-блоком
 *   - assistant с tool_calls → content-блоки {type:'tool_use'} вместо tool_calls
 *   - consecutive tool results объединяются в одну user-мессагу (Anthropic
 *     требует чередование user/assistant, несколько подряд 'tool' → один 'user')
 *
 * System prompt получает cache_control:{type:'ephemeral'} — кэширует
 * статичный префикс (system prompt не меняется в рамках сессии).
 */
export function convertMessagesToAnthropic(messages: OpenAIMessage[]): AnthropicConverted {
  const system: AnthropicSystemBlock[] = []
  const result: AnthropicMessage[] = []

  let i = 0
  while (i < messages.length) {
    const m = messages[i]

    // system → top-level system с cache_control
    if (m.role === 'system') {
      system.push({
        type: 'text',
        text: m.content || '',
        cache_control: { type: 'ephemeral' },
      })
      i++
      continue
    }

    // tool → user с tool_result блоками (объединяем consecutive)
    if (m.role === 'tool') {
      const toolResults: Array<Record<string, unknown>> = []
      while (i < messages.length && messages[i].role === 'tool') {
        const tr = messages[i]
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tr.tool_call_id || '',
          content: tr.content || '',
        })
        i++
      }
      result.push({ role: 'user', content: toolResults })
      continue
    }

    // assistant с tool_calls → content-блоки с tool_use
    if (m.role === 'assistant' && m.tool_calls && (m.tool_calls as unknown[]).length > 0) {
      const blocks: Array<Record<string, unknown>> = []
      // Текст перед tool_calls (если есть)
      if (m.content && typeof m.content === 'string' && m.content.trim()) {
        blocks.push({ type: 'text', text: m.content })
      }
      for (const tc of m.tool_calls as Array<{
        id?: string
        function?: { name?: string; arguments?: string }
      }>) {
        let input: unknown = {}
        try {
          input = JSON.parse(tc?.function?.arguments || '{}')
        } catch {
          input = {}
        }
        blocks.push({
          type: 'tool_use',
          id: tc?.id || '',
          name: tc?.function?.name || '',
          input,
        })
      }
      result.push({ role: 'assistant', content: blocks })
      i++
      continue
    }

    // обычное user/assistant сообщение — строковый content
    result.push({
      role: m.role as 'user' | 'assistant',
      content: m.content || '',
    })
    i++
  }

  return { system, messages: result }
}
