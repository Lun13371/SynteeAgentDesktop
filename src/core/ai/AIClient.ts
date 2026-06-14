import OpenAI from 'openai'
import type Store from 'electron-store'
import { buildReasoningParams } from '../../shared/reasoningModels'
import { getNextApiKey } from '../../shared/roundRobin'
import type { Provider } from '../../shared/types'

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
  return Math.min(base + jitter, 120000)  // max 120с
}

export interface StreamCallbacks {
  onToken: (token: string) => void
  onDone: (fullText: string) => void
  onError: (error: Error) => void
  onRateLimit?: (waitSec: number) => void
  onThinkingToken?: (token: string) => void
  onThinkingDone?: (ms: number) => void
  onUsage?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void
  onContextCounted?: (promptTokens: number) => void  // tiktoken подсчёт реального запроса до отправки
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

  private getClientForRole(type: string): OpenAI {
    const assignments = this.store.get('modelAssignments') as Array<{ role: string; modelId: string; providerId: string }> | undefined
    const assignment = assignments?.find(a => a.role === type)
    if (!assignment?.providerId) return this.client
    const providers = this.store.get('providers') as Provider[] | undefined
    const provider = providers?.find(p => p.id === assignment.providerId && p.enabled)
    if (!provider?.baseUrl) return this.client

    // Round-robin: выбираем следующий ключ из списка
    const { key, updatedProviders } = getNextApiKey(providers || [], assignment.providerId)
    if (!key) return this.client

    // Сохраняем обновлённый индекс в store
    this.store.set('providers', updatedProviders)

    return new OpenAI({ apiKey: key, baseURL: provider.baseUrl })
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

    while (attempt <= this.maxRetries) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stream = await (client.chat.completions.create as any)({
          model,
          messages: allMessages,
          stream: true,
          stream_options: { include_usage: true },
          temperature: (this.store.get('temperature') as number) || 0.7,
          max_tokens: (this.store.get('maxTokens') as number) || 4096,
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
            temperature: (this.store.get('temperature') as number) || 0.7,
            max_tokens: (this.store.get('maxTokens') as number) || 4096,
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
          callbacks.onRateLimit?.(Math.round(delay / 1000))
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
    while (attempt <= this.maxRetries) {
      try {
        const res = await client.chat.completions.create({
          model, messages: allMessages, stream: false,
          temperature: 0.3, max_tokens: 1024,
        })
        return res.choices[0]?.message?.content || ''
      } catch (err: unknown) {
        const error = err as { status?: number }
        if (error?.status === 429) { await sleep(backoffDelay(attempt)); attempt++; continue }
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
    onToolCallChunk?: (idx: number, name: string, partialArgs: string, toolId: string) => void,
  ): Promise<{ content: string; tool_calls?: unknown[]; reasoning?: string; hadStreamedTokens?: boolean }> {
    const effectiveRole = role === 'subagent' ? 'subagent' as never : 'main'
    const subagentModel = role === 'subagent' ? this.getModel('subagent' as never) : ''
    const resolvedRole = (subagentModel && subagentModel !== '') ? effectiveRole : 'main'
    const model = this.getModel(resolvedRole) || this.getModel('main')
    const client = this.getClientForRole(resolvedRole)

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

    let attempt = 0
    const maxAttempts = 10
    while (attempt < maxAttempts) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stream = await (client.chat.completions.create as any)({
          model, messages, tools, tool_choice: 'auto', parallel_tool_calls: true, signal, stream: true,
        })

        let content = ''
        let reasoning = ''
        const toolCallMap: Record<number, { id: string; name: string; arguments: string }> = {}
        const tokenBuffer: string[] = []
        let hasToolCalls = false

        for await (const chunk of stream) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
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

          // Reasoning токены
          const rTok = delta.reasoning_content ?? delta.thinking ?? delta.reasoning_summary
          if (rTok && typeof rTok === 'string') reasoning += rTok

          // Tool call чанки — собираем по index
          if (delta.tool_calls) {
            hasToolCalls = true
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
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
              // Стримим частичные аргументы в реальном времени
              if (onToolCallChunk && toolCallMap[idx].name) {
                onToolCallChunk(idx, toolCallMap[idx].name, toolCallMap[idx].arguments, toolCallMap[idx].id)
              }
            }
          }
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
        // 429 Rate limit — ретраим с backoff
        if (error?.status === 429) { await sleep(backoffDelay(attempt)); attempt++; continue }
        // Сетевые ошибки (ECONNRESET, ETIMEDOUT, ENOTFOUND, fetch failed) — ретраим
        const msg = error?.message?.toLowerCase() ?? ''
        const isNetwork = !error?.status || error.status >= 500 ||
          msg.includes('econnreset') || msg.includes('etimedout') ||
          msg.includes('enotfound') || msg.includes('fetch failed') ||
          msg.includes('network') || msg.includes('socket')
        if (isNetwork && attempt < maxAttempts - 1) {
          await sleep(backoffDelay(attempt))
          attempt++
          continue
        }
        // Фатальная ошибка (4xx, неизвестная) — бросаем сразу
        throw err
      }
    }
    throw new Error('Agent: превышено число попыток запросов к API')
  }

  async analyzeImage(imageBase64: string, prompt: string, callbacks: StreamCallbacks): Promise<void> {
    const model = this.getModel('vision')
    const client = this.getClientForRole('vision')
    let attempt = 0
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
    while (attempt <= this.maxRetries) {
      try {
        const res = await this.client.embeddings.create({ model, input: text })
        return res.data[0].embedding
      } catch (err: unknown) {
        const error = err as { status?: number }
        if (error?.status === 429) { await sleep(backoffDelay(attempt)); attempt++; continue }
        throw err
      }
    }
    throw new Error('Embed: rate limit')
  }
}
