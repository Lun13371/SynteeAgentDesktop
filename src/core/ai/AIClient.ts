import OpenAI from 'openai'
import type Store from 'electron-store'
import { buildReasoningParams } from '../../shared/reasoningModels'

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function backoffDelay(attempt: number): number {
  const base = 1000 * Math.pow(2, attempt)
  const jitter = base * 0.3 * Math.random()
  return Math.min(base + jitter, 60000)
}

export interface StreamCallbacks {
  onToken: (token: string) => void
  onDone: (fullText: string) => void
  onError: (error: Error) => void
  onRateLimit?: (waitSec: number) => void
  onThinkingToken?: (token: string) => void
  onThinkingDone?: (ms: number) => void
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

  private getModel(type: 'main' | 'fast' | 'vision' | 'summary' | 'router' | 'emotion'): string {
    const defaults: Record<string, string> = {
      main: 'claude-sonnet-4-6', fast: 'claude-haiku-4-5',
      vision: 'gpt-4o', summary: 'claude-haiku-4-5',
      router: 'claude-haiku-4-5', emotion: 'claude-haiku-4-5',
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
    const providers = this.store.get('providers') as Array<{ id: string; baseUrl: string; apiKey: string; enabled: boolean }> | undefined
    const provider = providers?.find(p => p.id === assignment.providerId && p.enabled)
    if (!provider?.baseUrl || !provider?.apiKey) return this.client
    return new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseUrl })
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
        let debugCount = 0

        for await (const chunk of stream) {
          if (signal?.aborted) break

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const delta = (chunk.choices?.[0]?.delta ?? {}) as Record<string, any>

          // DEBUG — логируем первые 5 чанков с непустыми полями
          if (debugCount < 5) {
            const keys = Object.keys(delta).filter(k => (delta[k] as unknown) != null && delta[k] !== '')
            if (keys.length > 0) {
              console.log('[AIClient delta]', JSON.stringify(delta).slice(0, 300))
              debugCount++
            }
          }

          // --- Формат 1: delta.reasoning_content (DeepSeek R1, o3-mini, OnlySQ) ---
          if (delta.reasoning_content != null) {
            const tok = String(delta.reasoning_content)
            if (tok) {
              if (!thinkingStartMs) thinkingStartMs = Date.now()
              callbacks.onThinkingToken?.(tok)
            }
            // reasoning_content присутствует — пропускаем content этого чанка
            continue
          }

          // --- Формат 2: delta.thinking (Anthropic extended thinking) ---
          if (delta.thinking != null) {
            const tok = String(delta.thinking)
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
    signal?: AbortSignal
  ): Promise<{ content: string; tool_calls?: unknown[]; reasoning?: string }> {
    const model = this.getModel('main')
    const client = this.getClientForRole('main')

    let attempt = 0
    while (attempt < 6) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await (client.chat.completions.create as any)({
          model, messages, tools, tool_choice: 'auto', signal,
        })
        const msg = res.choices[0]?.message
        const rawReasoning = msg?.reasoning_content ?? msg?.thinking ?? msg?.reasoning_summary
        const reasoning = rawReasoning ? String(rawReasoning) : undefined
        return { content: msg?.content || '', tool_calls: msg?.tool_calls, reasoning }
      } catch (err: unknown) {
        const error = err as { status?: number }
        if (error?.status === 429) { await sleep(backoffDelay(attempt)); attempt++; continue }
        attempt++
        await sleep(backoffDelay(attempt))
      }
    }
    throw new Error('Agent: превышено число попыток')
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
