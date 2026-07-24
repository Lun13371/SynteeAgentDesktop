import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import type Store from 'electron-store'
import { buildReasoningParams } from '../../shared/reasoningModels'
import { getNextApiKey } from '../../shared/roundRobin'
import type { Provider } from '../../shared/types'
import { log } from '../logger'
import {
  isAnthropicProvider,
  convertToolsToAnthropic,
  convertMessagesToAnthropic,
} from './anthropicConverters'

// Извлекает строку из любого формата reasoning токена
// Провайдеры могут слать: string, {text: "..."}, {thinking: "..."}, {content: "..."}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReasoningText(val: any): string {
  if (val == null) return ''
  if (typeof val === 'string') return val
  if (typeof val === 'object') {
    // Anthropic: { type: "thinking", thinking: "..." }
    if (typeof val.thinking === 'string') return val.thinking
    // Некоторые прокси: { text: "..." }
    if (typeof val.text === 'string') return val.text
    // { content: "..." }
    if (typeof val.content === 'string') return val.content
    // { delta: { thinking: "..." } }
    if (val.delta && typeof val.delta.thinking === 'string') return val.delta.thinking
    // Массив блоков: [{type:"thinking", thinking:"..."}]
    if (Array.isArray(val)) {
      return val
        .map((b: any) => typeof b === 'string' ? b : (b.thinking ?? b.text ?? b.content ?? ''))
        .filter(Boolean)
        .join('')
    }
  }
  return ''
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function backoffDelay(attempt: number): number {
  const base = 1000 * Math.pow(2, attempt)
  const jitter = base * 0.3 * Math.random()
  return Math.min(base + jitter, 60000)  // max 60с
}

// Общий wall-clock deadline на все retry-попытки одного запроса.
// Если суммарное время ожидания (с учётом backoff) превысит этот лимит,
// цикл прерывается с понятным сообщением вместо тихого ожидания 8-10 минут.
const OVERALL_TIMEOUT_MS = 4 * 60 * 1000  // 4 минуты

// Дефолтные параметры генерации. Ранее читались из store ('temperature' /
// 'maxTokens'), но UI-контролы сохраняли в другой ключ (modelParams) —
// настройки пользователя фактически ни на что не влияли. Поля убраны из UI;
// используем фиксированные значения (Anthropic API требует max_tokens).
const DEFAULT_TEMPERATURE = 0.7
const DEFAULT_MAX_TOKENS = 16384

export interface StreamCallbacks {
  onToken: (token: string) => void
  onDone: (fullText: string) => void
  onError: (error: Error) => void
  onRateLimit?: (waitSec: number) => void
  onThinkingToken?: (token: string) => void
  onThinkingDone?: (ms: number) => void
  onUsage?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void
  onContextCounted?: (promptTokens: number) => void
  onWaiting?: () => void                                      // запрос ушёл, ждём первый токен
  onRetry?: (attempt: number, reason: string, waitSec?: number) => void  // ретрай с причиной
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export class AIClient {
  private client: OpenAI
  private maxRetries = 6

  constructor(private store: Store) {
    this.client = this.createClient()
  }

  private createClient(): OpenAI {
    const apiKey = (this.store.get('apiKey') as string) || '***'
    const endpoint = (this.store.get('apiEndpoint') as string) || 'https://api.onlysq.ru/ai/openai'
    return new OpenAI({ apiKey, baseURL: endpoint })
  }

  reload(): void {
    this.client = this.createClient()
  }

  private getModel(type: 'main' | 'fast' | 'vision' | 'summary' | 'router' | 'emotion' | 'subagent'): string {
    const defaults: Record<string, string> = {
      main: 'claude-sonnet-4-6', fast: 'claude-haiku-4-5',
      vision: 'gpt-4o', summary: 'claude-haiku-4-5',
      router: 'claude-haiku-4-5', emotion: 'claude-haiku-4-5',
      subagent: '',
    }
    const assignments = this.store.get('modelAssignments') as Array<{ role: string; modelId: string; providerId: string }> | undefined
    const found = assignments?.find(a => a.role === type)
    if (found?.modelId) return found.modelId
    return (this.store.get(`${type}Model`) as string) || defaults[type]
  }

  /**
   * Возвращает информацию о провайдере для указанной роли (с round-robin key rotation).
   * Используется как OpenAI-путём (getClientForRole), так и Anthropic-путём
   * (chatWithToolsAnthropic) для единой логики выбора провайдера и ключа.
   * Возвращает null если назначение не задано — в этом случае используется
   * дефолтный клиент (this.client).
   */
  private getProviderInfoForRole(type: string): { provider: Provider; apiKey: string } | null {
    const assignments = this.store.get('modelAssignments') as Array<{ role: string; modelId: string; providerId: string }> | undefined
    const assignment = assignments?.find(a => a.role === type)
    if (!assignment?.providerId) return null
    const providers = this.store.get('providers') as Provider[] | undefined
    const provider = providers?.find(p => p.id === assignment.providerId && p.enabled)
    if (!provider?.baseUrl) return null

    // Round-robin: выбираем следующий ключ из списка
    const { key, updatedProviders } = getNextApiKey(providers || [], assignment.providerId)
    if (!key) return null

    // Сохраняем обновлённый индекс в store
    this.store.set('providers', updatedProviders)

    return { provider, apiKey: key }
  }

  private getClientForRole(type: string): OpenAI {
    const info = this.getProviderInfoForRole(type)
    if (!info) return this.client
    return new OpenAI({ apiKey: info.apiKey, baseURL: info.provider.baseUrl })
  }

  async streamChat(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    modelType: 'main' | 'fast' = 'main',
    systemPrompt?: string,
    signal?: AbortSignal
  ): Promise<void> {
    const model = this.getModel(modelType)
    const client = this.getClientForRole(modelType)

    const allMessages: OpenAI.Chat.ChatCompletionMessageParam[] = []
    if (systemPrompt) allMessages.push({ role: 'system', content: systemPrompt })
    allMessages.push(...messages)

    // Считаем реальный контекст через tiktoken — то что идёт в запрос
    if (callbacks.onContextCounted && modelType === 'main') {
      try {
        const { estimateTokens } = await import('../context/contextManager')
        let promptTokens = 0
        for (const m of allMessages) {
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          promptTokens += estimateTokens(content) + 4  // +4 per message (role overhead)
        }
        promptTokens += 2  // reply primer
        callbacks.onContextCounted(promptTokens)
      } catch { /* ok — tiktoken не критичен */ }
    }

    // Берём reasoning параметры из store (выбраны пользователем в UI)
    const reasoningValue = (this.store.get('reasoningValue') as string) || ''
    const reasoningExtra = reasoningValue ? buildReasoningParams(model, reasoningValue) : {}

    let attempt = 0
    let fullText = ''
    const deadlineMs = Date.now() + OVERALL_TIMEOUT_MS

    while (attempt <= this.maxRetries) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        callbacks.onWaiting?.()
        const stream = await (client.chat.completions.create as any)({
          model,
          messages: allMessages,
          stream: true,
          stream_options: { include_usage: true },
          temperature: DEFAULT_TEMPERATURE,
          max_tokens: DEFAULT_MAX_TOKENS,
          ...reasoningExtra,
        }, { signal })

        let thinkingStartMs = 0
        let thinkingDoneSent = false
        let inThinkTag = false
        let thinkBuffer = ''

        for await (const chunk of stream) {
          if (signal?.aborted) break

          // Реальные токены из провайдера — последний чанк содержит usage
          if (chunk.usage) {
            const u = chunk.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
            if (u.prompt_tokens != null) {
              callbacks.onUsage?.({
                promptTokens: u.prompt_tokens,
                completionTokens: u.completion_tokens ?? 0,
                totalTokens: u.total_tokens ?? (u.prompt_tokens + (u.completion_tokens ?? 0)),
              })
            }
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const delta = (chunk.choices?.[0]?.delta ?? {}) as Record<string, any>

          // --- Формат 1: delta.reasoning_content ---
          if (delta.reasoning_content != null) {
            const tok = extractReasoningText(delta.reasoning_content)
            if (tok) {
              if (!thinkingStartMs) thinkingStartMs = Date.now()
              callbacks.onThinkingToken?.(tok)
            }
            continue
          }

          // --- Формат 2: delta.thinking (Anthropic extended thinking) ---
          if (delta.thinking != null) {
            const tok = extractReasoningText(delta.thinking)
            if (tok) {
              if (!thinkingStartMs) thinkingStartMs = Date.now()
              callbacks.onThinkingToken?.(tok)
            }
            continue
          }

          // Если был reasoning и теперь его нет — шлём done
          if (thinkingStartMs && !thinkingDoneSent) {
            thinkingDoneSent = true
            callbacks.onThinkingDone?.(Date.now() - thinkingStartMs)
          }

          // --- Формат 3: <think>...</think> теги внутри delta.content ---
          const rawContent: string = delta.content ?? ''
          if (!rawContent) continue

          if (inThinkTag || rawContent.includes('<think>')) {
            thinkBuffer += rawContent
            let searchFrom = 0

            while (true) {
              if (!inThinkTag) {
                const openIdx = thinkBuffer.indexOf('<think>', searchFrom)
                if (openIdx === -1) {
                  const plain = thinkBuffer.slice(searchFrom)
                  if (plain) { fullText += plain; callbacks.onToken(plain) }
                  thinkBuffer = ''
                  break
                }
                const before = thinkBuffer.slice(searchFrom, openIdx)
                if (before) { fullText += before; callbacks.onToken(before) }
                inThinkTag = true
                searchFrom = openIdx + '<think>'.length
                if (!thinkingStartMs) thinkingStartMs = Date.now()
              }

              const closeIdx = thinkBuffer.indexOf('</think>', searchFrom)
              if (closeIdx === -1) {
                // тег ещё не закрыт — накапливаем и шлём partial
                const partial = thinkBuffer.slice(searchFrom)
                if (partial) callbacks.onThinkingToken?.(partial)
                thinkBuffer = '<think>' + thinkBuffer.slice(searchFrom)
                break
              }

              const thinkContent = thinkBuffer.slice(searchFrom, closeIdx)
              if (thinkContent) callbacks.onThinkingToken?.(thinkContent)
              if (!thinkingDoneSent) {
                thinkingDoneSent = true
                callbacks.onThinkingDone?.(Date.now() - (thinkingStartMs || Date.now()))
              }
              inThinkTag = false
              searchFrom = closeIdx + '</think>'.length
            }
          } else {
            // Обычный контент
            fullText += rawContent
            callbacks.onToken(rawContent)
          }
        }

        if (thinkingStartMs && !thinkingDoneSent) {
          callbacks.onThinkingDone?.(Date.now() - thinkingStartMs)
        }

        // Фоллбэк: стрим дал 0 токенов
        if (!fullText) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const res = await (client.chat.completions.create as any)({
            model, messages: allMessages, stream: false,
            temperature: DEFAULT_TEMPERATURE,
            max_tokens: DEFAULT_MAX_TOKENS,
          })
          fullText = res.choices[0]?.message?.content || ''
          if (fullText) callbacks.onToken(fullText)
        }

        callbacks.onDone(fullText)
        return

      } catch (err: unknown) {
        const error = err as { status?: number; message?: string; name?: string }
        if (error?.name === 'AbortError' || signal?.aborted) {
          callbacks.onDone(fullText ?? '')
          return
        }
        if (error?.status === 429) {
          const delay = backoffDelay(attempt)
          const waitSec = Math.round(delay / 1000)
          callbacks.onRateLimit?.(waitSec)
          callbacks.onRetry?.(attempt + 1, 'rate_limit', waitSec)
          if (Date.now() >= deadlineMs) {
            callbacks.onError(new Error(`Превышено общее время ожидания ответа от AI (${Math.round(OVERALL_TIMEOUT_MS / 1000)}с). Попробуйте позже или смените провайдера.`))
            return
          }
          await sleep(delay)
          attempt++
          continue
        }
        const msg = (error?.message ?? '').toLowerCase()
        const isNetwork = !error?.status || error.status >= 500 ||
          msg.includes('econnreset') || msg.includes('etimedout') ||
          msg.includes('enotfound') || msg.includes('fetch failed') ||
          msg.includes('network') || msg.includes('socket')
        if (isNetwork && attempt < this.maxRetries) {
          const delay = backoffDelay(attempt)
          callbacks.onRetry?.(attempt + 1, 'network')
          if (Date.now() >= deadlineMs) {
            callbacks.onError(new Error(`Превышено общее время ожидания ответа от AI (${Math.round(OVERALL_TIMEOUT_MS / 1000)}с). Попробуйте позже или смените провайдера.`))
            return
          }
          await sleep(delay)
          attempt++
          continue
        }
        callbacks.onError(new Error(error?.message || 'Unknown AI error'))
        return
      }
    }

    callbacks.onError(new Error('Превышено число попыток'))
  }

  async complete(
    messages: ChatMessage[],
    modelType: 'main' | 'fast' | 'summary' | 'router' | 'emotion' = 'fast',
    systemPrompt?: string
  ): Promise<string> {
    const model = this.getModel(modelType)
    const client = this.getClientForRole(modelType)
    const allMessages: OpenAI.Chat.ChatCompletionMessageParam[] = []
    if (systemPrompt) allMessages.push({ role: 'system', content: systemPrompt })
    allMessages.push(...messages)

    let attempt = 0
    const deadlineMs = Date.now() + OVERALL_TIMEOUT_MS
    while (attempt <= this.maxRetries) {
      try {
        const res = await client.chat.completions.create({
          model, messages: allMessages, stream: false,
          temperature: 0.3, max_tokens: 1024,
        })
        return res.choices[0]?.message?.content || ''
      } catch (err: unknown) {
        const error = err as { status?: number }
        if (error?.status === 429) {
          if (Date.now() >= deadlineMs) {
            throw new Error(`Превышено общее время ожидания ответа от AI (${Math.round(OVERALL_TIMEOUT_MS / 1000)}с). Попробуйте позже или смените провайдера.`)
          }
          await sleep(backoffDelay(attempt)); attempt++; continue
        }
        throw err
      }
    }
    throw new Error('Rate limit: превышено число попыток')
  }

  async textToSpeech(text: string): Promise<string> {
    const apiKey = this.store.get('apiKey') as string
    const endpoint = (this.store.get('apiEndpoint') as string) || 'https://api.onlysq.ru/ai/openai'
    const voice = (this.store.get('voiceId') as string) || 'alloy'
    const response = await fetch(`${endpoint}/audio/speech`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', input: text, voice }),
    })
    const buffer = await response.arrayBuffer()
    return Buffer.from(buffer).toString('base64')
  }

  async chatWithTools(
    messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }>,
    tools: unknown[],
    signal?: AbortSignal,
    role: 'main' | 'subagent' = 'main',
    onToken?: (token: string) => void,
    onContextCounted?: (promptTokens: number) => void,
    onRateLimit?: (waitSec: number) => void,
    onRetry?: (attempt: number, reason: string, waitSec?: number) => void,
    onUsage?: (promptTokens: number, completionTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number) => void,
    onThinkingToken?: (token: string) => void,
    onThinkingDone?: (ms: number) => void,
    // Вызывается один раз на каждый tool_call, как только известно его имя —
    // ЕЩЁ ДО того, как модель полностью догенерирует JSON аргументов (который
    // может быть большим для edit_file/write_file и занимать заметное время).
    // index стабилен в рамках раунда (см. tc.index у провайдера) — по нему
    // Agent.ts матчит этот ранний сигнал с финальным tool_call.
    onToolCallStarted?: (index: number, toolName: string) => void,
  ): Promise<{ content: string; tool_calls?: unknown[]; reasoning?: string; hadStreamedTokens?: boolean }> {
    const effectiveRole = role === 'subagent' ? 'subagent' as never : 'main'
    const subagentModel = role === 'subagent' ? this.getModel('subagent' as never) : ''
    const resolvedRole = (subagentModel && subagentModel !== '') ? effectiveRole : 'main'
    const model = this.getModel(resolvedRole) || this.getModel('main')
    const providerInfo = this.getProviderInfoForRole(resolvedRole)
    const temperature = DEFAULT_TEMPERATURE
    const maxTokensRaw = DEFAULT_MAX_TOKENS
    const reasoningValue = (this.store.get('reasoningValue') as string) || ''
    const reasoningExtra = reasoningValue ? buildReasoningParams(model, reasoningValue) : {}

    // Для Anthropic extended thinking: max_tokens ВКЛЮЧАЕТ reasoning токены.
    // Если budget_tokens > max_tokens, API обрежет на max_tokens и ответ будет пустой.
    // Решение: max_tokens = max(budget_tokens + maxTokensRaw, maxTokensRaw)
    let maxTokens = maxTokensRaw
    if (reasoningExtra.thinking && typeof reasoningExtra.thinking === 'object') {
      const budget = (reasoningExtra.thinking as { budget_tokens?: number }).budget_tokens
      if (budget && budget > 0) {
        maxTokens = budget + maxTokensRaw
      }
    }

    // Считаем реальный контекст через tiktoken перед каждым раундом агента
    if (onContextCounted) {
      try {
        const { estimateTokens } = await import('../context/contextManager')
        let promptTokens = 0
        for (const m of messages) {
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          promptTokens += estimateTokens(content) + 4
        }
        // tool schemas overhead (статичный)
        promptTokens += 3800 + 2
        onContextCounted(promptTokens)
      } catch { /* ok */ }
    }

    // Anthropic-нативный путь с prompt caching (cache_control на system + tools).
    // Срабатывает когда провайдер имеет type='anthropic' или baseUrl=api.anthropic.com.
    // OnlySQ-прокси (type='onlysq') здесь НЕ матчится — остаётся на OpenAI-пути ниже.
    if (providerInfo && isAnthropicProvider(providerInfo.provider)) {
      const anthropicClient = new Anthropic({
        apiKey: providerInfo.apiKey,
        baseURL: providerInfo.provider.baseUrl,
      })
      return this.chatWithToolsAnthropic(
        anthropicClient, messages, tools, signal, model, temperature, maxTokens, reasoningExtra,
        { onToken, onRateLimit, onRetry, onUsage, onThinkingToken, onThinkingDone, onToolCallStarted }
      )
    }

    // OpenAI-совместимый путь (включая OnlySQ-прокси)
    const client = providerInfo
      ? new OpenAI({ apiKey: providerInfo.apiKey, baseURL: providerInfo.provider.baseUrl })
      : this.client

    let attempt = 0
    const maxAttempts = 15
    const deadlineMs = Date.now() + OVERALL_TIMEOUT_MS
    while (attempt < maxAttempts) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stream = await (client.chat.completions.create as any)({
          model,
          messages,
          tools,
          tool_choice: 'auto',
          stream: true,
          stream_options: { include_usage: true },
          temperature,
          max_tokens: maxTokens,
          ...reasoningExtra,
        }, { signal })

        let content = ''
        let reasoning = ''
        let thinkingStartMs = 0
        let thinkingDoneSent = false
        const toolCallMap: Record<number, { id: string; name: string; arguments: string }> = {}
        const tokenBuffer: string[] = []
        let hasToolCalls = false

        for await (const chunk of stream) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
          if (chunk.usage) {
            const usage = chunk.usage as {
              prompt_tokens?: number
              completion_tokens?: number
              prompt_tokens_details?: { cached_tokens?: number }
            }
            if (usage.prompt_tokens != null) {
              // OpenAI/прокси может вернуть cached_tokens — передаём как cacheReadTokens.
              // cacheWriteTokens для OpenAI не применим (автокэширование без маркеров).
              onUsage?.(usage.prompt_tokens, usage.completion_tokens ?? 0, usage.prompt_tokens_details?.cached_tokens)
            }
          }
          const delta = chunk.choices[0]?.delta
          if (!delta) continue

          // Текстовые токены — буферизуем, стримим только если нет tool_calls
          if (delta.content) {
            content += delta.content
            if (!hasToolCalls) {
              tokenBuffer.push(delta.content)
              onToken?.(delta.content)
            }
          }

          // Reasoning токены — стримим в реальном времени
          const rTok = delta.reasoning_content ?? delta.thinking ?? delta.reasoning_summary
          const reasoningChunk = extractReasoningText(rTok)
          if (reasoningChunk) {
            if (!thinkingStartMs) thinkingStartMs = Date.now()
            reasoning += reasoningChunk
            onThinkingToken?.(reasoningChunk)
          } else if (thinkingStartMs && !thinkingDoneSent && (delta.content || delta.tool_calls)) {
            // Reasoning закончился, пошёл контент или tool_calls
            thinkingDoneSent = true
            onThinkingDone?.(Date.now() - thinkingStartMs)
          }

          // Tool call чанки — собираем по index
          if (delta.tool_calls) {
            hasToolCalls = true
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              const isNewCall = !toolCallMap[idx]
              if (!toolCallMap[idx]) {
                toolCallMap[idx] = {
                  id: tc.id ?? '',
                  name: tc.function?.name ?? '',
                  arguments: tc.function?.arguments ?? '',
                }
              } else {
                if (tc.id && !toolCallMap[idx].id) toolCallMap[idx].id = tc.id
                if (tc.function?.name && !toolCallMap[idx].name) toolCallMap[idx].name = tc.function.name
                if (tc.function?.arguments) toolCallMap[idx].arguments += tc.function.arguments
              }
              // Имя тула обычно приходит целиком в первом чанке этого index —
              // сигналим сразу, не дожидаясь аргументов (которые могут ещё
              // долго стримиться для edit_file/write_file с большим content).
              if (isNewCall && toolCallMap[idx].name) {
                onToolCallStarted?.(idx, toolCallMap[idx].name)
              }
            }
          }
        }

        // Финализация thinking — если стрим закончился, а done не был отправлен
        if (thinkingStartMs && !thinkingDoneSent) {
          onThinkingDone?.(Date.now() - thinkingStartMs)
        }

        // Собираем tool_calls в финальный формат
        const tool_calls = Object.values(toolCallMap).length > 0
          ? Object.values(toolCallMap).map(tc => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            }))
          : undefined

        return {
          content,
          tool_calls,
          reasoning: reasoning ? extractReasoningText(reasoning) : undefined,
          hadStreamedTokens: tokenBuffer.length > 0 && !tool_calls,
        }
      } catch (err: unknown) {
        const error = err as { status?: number; code?: string; name?: string; message?: string }
        // AbortError — не ретраим, бросаем сразу
        if (error?.name === 'AbortError' || signal?.aborted) throw err
        // 429 Rate limit — ретраим с backoff + уведомляем
        if (error?.status === 429) {
          const delay = backoffDelay(attempt)
          const waitSec = Math.round(delay / 1000)
          log('[AIClient] 429 rate-limit, retry %d/%d через %ds (model=%s)', attempt + 1, maxAttempts, waitSec, model)
          onRateLimit?.(waitSec)
          onRetry?.(attempt + 1, 'rate_limit', waitSec)
          if (Date.now() >= deadlineMs) {
            throw new Error(`Превышено общее время ожидания ответа от AI (${Math.round(OVERALL_TIMEOUT_MS / 1000)}с). Попробуйте позже или смените провайдера.`)
          }
          await sleep(delay)
          attempt++
          continue
        }
        // Сетевые ошибки (ECONNRESET, ETIMEDOUT, ENOTFOUND, fetch failed) — ретраим
        const msg = error?.message?.toLowerCase() ?? ''
        const isNetwork = !error?.status || error.status >= 500 ||
          msg.includes('econnreset') || msg.includes('etimedout') ||
          msg.includes('enotfound') || msg.includes('fetch failed') ||
          msg.includes('network') || msg.includes('socket')
        if (isNetwork && attempt < maxAttempts - 1) {
          const delay = backoffDelay(attempt)
          // Это единственная точка, где видна сырая причина обрыва стрима/
          // сетевого сбоя до того, как она превратится в обезличенный текст
          // статуса для UI. Логируем для последующей диагностики инцидентов
          // вида «зависло и само перезапустилось».
          log('[AIClient] сетевая ошибка, retry %d/%d (model=%s status=%s): %s',
            attempt + 1, maxAttempts, model, error?.status ?? '—', error?.message ?? String(err))
          onRetry?.(attempt + 1, 'network')
          if (Date.now() >= deadlineMs) {
            throw new Error(`Превышено общее время ожидания ответа от AI (${Math.round(OVERALL_TIMEOUT_MS / 1000)}с). Попробуйте позже или смените провайдера.`)
          }
          await sleep(delay)
          attempt++
          continue
        }
        // Фатальная ошибка (4xx, неизвестная) — бросаем сразу
        log('[AIClient] фатальная ошибка API (model=%s status=%s): %s',
          model, error?.status ?? '—', error?.message ?? String(err))
        throw err
      }
    }
    throw new Error('Agent: превышено число попыток запросов к API')
  }

  /**
   * Нативный Anthropic Messages API путь с prompt caching.
   *
   * Использует @anthropic-ai/sdk для прямого общения с api.anthropic.com
   * (или Anthropic-совместимым прокси). В отличие от OpenAI-пути:
   *   - system prompt — top-level параметр, не message в массиве
   *   - content — массив content-блоков (tool_use, tool_result, thinking)
   *   - cache_control:{type:'ephemeral'} на system и последнем tool → кэширование
   *   - usage включает cache_read_input_tokens и cache_creation_input_tokens
   *
   * Возвращает тот же формат, что и chatWithTools (OpenAI-совместимый),
   * чтобы Agent.ts работал с обоими путями одинаково.
   */
  private async chatWithToolsAnthropic(
    client: Anthropic,
    messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }>,
    tools: unknown[],
    signal: AbortSignal | undefined,
    model: string,
    temperature: number,
    maxTokens: number,
    reasoningExtra: Record<string, unknown>,
    callbacks: {
      onToken?: (token: string) => void
      onRateLimit?: (waitSec: number) => void
      onRetry?: (attempt: number, reason: string, waitSec?: number) => void
      onUsage?: (promptTokens: number, completionTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number) => void
      onThinkingToken?: (token: string) => void
      onThinkingDone?: (ms: number) => void
      onToolCallStarted?: (index: number, toolName: string) => void
    },
  ): Promise<{ content: string; tool_calls?: unknown[]; reasoning?: string; hadStreamedTokens?: boolean }> {
    const { onToken, onRateLimit, onRetry, onUsage, onThinkingToken, onThinkingDone, onToolCallStarted } = callbacks

    // Конвертируем messages и tools в Anthropic формат (с cache_control)
    const converted = convertMessagesToAnthropic(messages)
    const anthropicTools = convertToolsToAnthropic(tools)

    // Запрос
    const params: Record<string, unknown> = {
      model,
      messages: converted.messages,
      stream: true,
      max_tokens: maxTokens,
    }
    if (converted.system.length > 0) {
      params.system = converted.system
    }
    if (anthropicTools.length > 0) {
      params.tools = anthropicTools
      params.tool_choice = { type: 'auto' }
    }
    // При extended thinking Anthropic требует temperature=1 (или omit)
    if (!reasoningExtra.thinking) {
      params.temperature = temperature
    }
    // reasoningExtra для Claude = {thinking:{type:'enabled', budget_tokens:N}} —
    // формат уже совместим с нативным Anthropic API, передаём as-is
    Object.assign(params, reasoningExtra)

    let attempt = 0
    const maxAttempts = 15
    const deadlineMs = Date.now() + OVERALL_TIMEOUT_MS

    while (attempt < maxAttempts) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      try {
        const stream = await (client.messages.create as any)(params, { signal })

        let content = ''
        let reasoning = ''
        let thinkingStartMs = 0
        let thinkingDoneSent = false
        const tokenBuffer: string[] = []

        // Tool call accumulation: index → {id, name, jsonBuffer}
        const toolCallMap: Record<number, { id: string; name: string; jsonBuffer: string }> = {}
        const toolCallIndices: number[] = [] // preserve insertion order
        let hasToolCalls = false

        // Usage accumulation (input — из message_start, output — из message_delta)
        let inputTokens = 0
        let outputTokens = 0
        let cacheReadTokens = 0
        let cacheWriteTokens = 0

        for await (const event of stream as any) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

          switch (event.type) {
            case 'message_start': {
              const usage = event.message?.usage
              if (usage) {
                inputTokens = usage.input_tokens ?? 0
                cacheReadTokens = usage.cache_read_input_tokens ?? 0
                cacheWriteTokens = usage.cache_creation_input_tokens ?? 0
              }
              break
            }

            case 'content_block_start': {
              const idx: number = event.index ?? 0
              const block = event.content_block

              // Переход от thinking к контенту/tool_use → сигнал thinking done
              if (thinkingStartMs && !thinkingDoneSent && block?.type !== 'thinking') {
                thinkingDoneSent = true
                onThinkingDone?.(Date.now() - thinkingStartMs)
              }

              if (block?.type === 'tool_use') {
                hasToolCalls = true
                toolCallMap[idx] = {
                  id: block.id ?? '',
                  name: block.name ?? '',
                  jsonBuffer: '',
                }
                toolCallIndices.push(idx)
                if (block.name) {
                  onToolCallStarted?.(idx, block.name)
                }
              } else if (block?.type === 'thinking') {
                if (!thinkingStartMs) thinkingStartMs = Date.now()
              }
              break
            }

            case 'content_block_delta': {
              const idx: number = event.index ?? 0
              const delta = event.delta
              if (!delta) break

              if (delta.type === 'text_delta') {
                const text: string = delta.text ?? ''
                if (text) {
                  content += text
                  if (!hasToolCalls) {
                    tokenBuffer.push(text)
                    onToken?.(text)
                  }
                }
              } else if (delta.type === 'input_json_delta') {
                const partial: string = delta.partial_json ?? ''
                if (toolCallMap[idx]) {
                  toolCallMap[idx].jsonBuffer += partial
                }
              } else if (delta.type === 'thinking_delta') {
                const think: string = delta.thinking ?? ''
                if (think) {
                  if (!thinkingStartMs) thinkingStartMs = Date.now()
                  reasoning += think
                  onThinkingToken?.(think)
                }
              }
              // signature_delta — игнорируем (служебные данные для верификации thinking)
              break
            }

            case 'content_block_stop':
              // tool_use блок завершён — JSON аргументов накоплен в jsonBuffer
              break

            case 'message_delta': {
              const usage = event.usage
              if (usage?.output_tokens != null) {
                outputTokens = usage.output_tokens
              }
              break
            }

            case 'message_stop':
              break
          }
        }

        // Финализация thinking
        if (thinkingStartMs && !thinkingDoneSent) {
          onThinkingDone?.(Date.now() - thinkingStartMs)
        }

        // Usage callback с cache-токенами.
        // Anthropic: input_tokens = только non-cached, cache — отдельно.
        // Нормализуем: totalPrompt = input + cacheRead + cacheWrite (как OpenAI),
        // cache-токены передаём отдельно для тарификации и UI.
        if (inputTokens > 0 || outputTokens > 0) {
          const totalPrompt = inputTokens + cacheReadTokens + cacheWriteTokens
          onUsage?.(totalPrompt, outputTokens, cacheReadTokens || undefined, cacheWriteTokens || undefined)
        }

        // Собираем tool_calls в OpenAI-совместимый формат (для Agent.ts)
        const tool_calls = toolCallIndices.length > 0
          ? toolCallIndices.map(idx => {
              const tc = toolCallMap[idx]
              return {
                id: tc.id,
                type: 'function' as const,
                function: {
                  name: tc.name,
                  arguments: tc.jsonBuffer || '{}',
                },
              }
            })
          : undefined

        return {
          content,
          tool_calls,
          reasoning: reasoning || undefined,
          hadStreamedTokens: tokenBuffer.length > 0 && !tool_calls,
        }

      } catch (err: unknown) {
        const error = err as { status?: number; code?: string; name?: string; message?: string }
        // AbortError — не ретраим, бросаем сразу
        if (error?.name === 'AbortError' || signal?.aborted) throw err
        // 429 Rate limit — ретраим с backoff + уведомляем
        if (error?.status === 429) {
          const delay = backoffDelay(attempt)
          const waitSec = Math.round(delay / 1000)
          log('[AIClient/Anthropic] 429 rate-limit, retry %d/%d через %ds (model=%s)', attempt + 1, maxAttempts, waitSec, model)
          onRateLimit?.(waitSec)
          onRetry?.(attempt + 1, 'rate_limit', waitSec)
          if (Date.now() >= deadlineMs) {
            throw new Error(`Превышено общее время ожидания ответа от AI (${Math.round(OVERALL_TIMEOUT_MS / 1000)}с). Попробуйте позже или смените провайдера.`)
          }
          await sleep(delay)
          attempt++
          continue
        }
        // Сетевые ошибки — ретраим
        const msg = error?.message?.toLowerCase() ?? ''
        const isNetwork = !error?.status || error.status >= 500 ||
          msg.includes('econnreset') || msg.includes('etimedout') ||
          msg.includes('enotfound') || msg.includes('fetch failed') ||
          msg.includes('network') || msg.includes('socket')
        if (isNetwork && attempt < maxAttempts - 1) {
          const delay = backoffDelay(attempt)
          log('[AIClient/Anthropic] сетевая ошибка, retry %d/%d (model=%s status=%s): %s',
            attempt + 1, maxAttempts, model, error?.status ?? '—', error?.message ?? String(err))
          onRetry?.(attempt + 1, 'network')
          if (Date.now() >= deadlineMs) {
            throw new Error(`Превышено общее время ожидания ответа от AI (${Math.round(OVERALL_TIMEOUT_MS / 1000)}с). Попробуйте позже или смените провайдера.`)
          }
          await sleep(delay)
          attempt++
          continue
        }
        // Фатальная ошибка (4xx, неизвестная) — бросаем сразу
        log('[AIClient/Anthropic] фатальная ошибка API (model=%s status=%s): %s',
          model, error?.status ?? '—', error?.message ?? String(err))
        throw err
      }
    }
    throw new Error('Agent: превышено число попыток запросов к API')
  }

  async analyzeImage(imageBase64: string, prompt: string, callbacks: StreamCallbacks): Promise<void> {
    const model = this.getModel('vision')
    const client = this.getClientForRole('vision')
    let attempt = 0
    const deadlineMs = Date.now() + OVERALL_TIMEOUT_MS
    while (attempt <= this.maxRetries) {
      try {
        const stream = await client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
            { type: 'text', text: prompt },
          ]}],
          stream: true, max_tokens: 2048,
        })
        let fullText = ''
        for await (const chunk of stream) {
          const token = chunk.choices[0]?.delta?.content || ''
          if (token) { fullText += token; callbacks.onToken(token) }
        }
        callbacks.onDone(fullText)
        return
      } catch (err: unknown) {
        const error = err as { status?: number }
        if (error?.status === 429) {
          const delay = backoffDelay(attempt)
          callbacks.onRateLimit?.(Math.round(delay / 1000))
          if (Date.now() >= deadlineMs) {
            callbacks.onError(new Error(`Превышено общее время ожидания ответа от AI (${Math.round(OVERALL_TIMEOUT_MS / 1000)}с). Попробуйте позже или смените провайдера.`))
            return
          }
          await sleep(delay); attempt++; continue
        }
        callbacks.onError(err as Error)
        return
      }
    }
  }

  async embed(text: string): Promise<number[]> {
    const model = (this.store.get('embeddingModel') as string) || 'gemini-embedding-2'
    let attempt = 0
    const deadlineMs = Date.now() + OVERALL_TIMEOUT_MS
    while (attempt <= this.maxRetries) {
      try {
        const res = await this.client.embeddings.create({ model, input: text })
        return res.data[0].embedding
      } catch (err: unknown) {
        const error = err as { status?: number }
        if (error?.status === 429) {
          if (Date.now() >= deadlineMs) {
            throw new Error(`Превышено общее время ожидания ответа от AI (${Math.round(OVERALL_TIMEOUT_MS / 1000)}с). Попробуйте позже или смените провайдера.`)
          }
          await sleep(backoffDelay(attempt)); attempt++; continue
        }
        throw err
      }
    }
    throw new Error('Embed: rate limit')
  }
}
