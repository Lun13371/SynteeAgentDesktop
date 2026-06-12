import OpenAI from 'openai'
import type Store from 'electron-store'

// Экспоненциальный backoff с jitter для rate limit
async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function backoffDelay(attempt: number): number {
  const base = 1000 * Math.pow(2, attempt)
  const max = 60000
  const jitter = base * 0.3 * Math.random()
  return Math.min(base + jitter, max)
}

export interface StreamCallbacks {
  onToken: (token: string) => void
  onDone: (fullText: string) => void
  onError: (error: Error) => void
  onRateLimit?: (waitSec: number) => void
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

  // Читаем модель из modelAssignments (новый формат) с fallback на старый ключ
  private getModel(type: 'main' | 'fast' | 'vision' | 'summary' | 'router' | 'emotion'): string {
    const defaults: Record<string, string> = {
      main:    'claude-sonnet-4-6',
      fast:    'claude-haiku-4-5',
      vision:  'gpt-4o',
      summary: 'claude-haiku-4-5',
      router:  'claude-haiku-4-5',
      emotion: 'claude-haiku-4-5',
    }
    const assignments = this.store.get('modelAssignments') as Array<{ role: string; modelId: string; providerId: string }> | undefined
    const found = assignments?.find(a => a.role === type)
    if (found?.modelId) return found.modelId
    // fallback — старые ключи mainModel/fastModel
    const storeKey = `${type}Model`
    return (this.store.get(storeKey) as string) || defaults[type]
  }

  // Получить endpoint+key для конкретного провайдера роли
  private getClientForRole(type: string): OpenAI {
    const assignments = this.store.get('modelAssignments') as Array<{ role: string; modelId: string; providerId: string }> | undefined
    const assignment = assignments?.find(a => a.role === type)
    if (!assignment?.providerId) return this.client

    const providers = this.store.get('providers') as Array<{ id: string; baseUrl: string; apiKey: string; enabled: boolean }> | undefined
    const provider = providers?.find(p => p.id === assignment.providerId && p.enabled)
    if (!provider?.baseUrl || !provider?.apiKey) return this.client

    return new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseUrl })
  }

  // Стриминг чата с retry при rate limit
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
    if (systemPrompt) {
      allMessages.push({ role: 'system', content: systemPrompt })
    }
    allMessages.push(...messages)

    let attempt = 0

    let fullText = ''
    while (attempt <= this.maxRetries) {
      try {
        const stream = await client.chat.completions.create({
          model,
          messages: allMessages,
          stream: true,
          temperature: (this.store.get('temperature') as number) || 0.7,
          max_tokens: (this.store.get('maxTokens') as number) || 4096,
        }, { signal })

        let chunkCount = 0
        for await (const chunk of stream) {
          if (signal?.aborted) break
          const token = chunk.choices[0]?.delta?.content ?? ''
          chunkCount++
          if (token) {
            fullText += token
            callbacks.onToken(token)
          }
        }

        // Фоллбэк: если стриминг дал 0 токенов — пробуем non-stream
        if (!fullText) {
          console.warn(`[AIClient] stream вернул ${chunkCount} чанков но 0 токенов — фоллбэк на non-stream`)
          const res = await client.chat.completions.create({
            model,
            messages: allMessages,
            stream: false,
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

        // Abort — сохраняем что успели накопить
        if (error?.name === 'AbortError' || signal?.aborted) {
          callbacks.onDone(fullText ?? '')
          return
        }

        if (error?.status === 429) {
          const delay = backoffDelay(attempt)
          const waitSec = Math.round(delay / 1000)
          callbacks.onRateLimit?.(waitSec)
          console.warn(`[AIClient] Rate limit, ждём ${waitSec}с (попытка ${attempt + 1}/${this.maxRetries})`)
          await sleep(delay)
          attempt++
          continue
        }

        callbacks.onError(new Error(error?.message || 'Unknown AI error'))
        return
      }
    }

    callbacks.onError(new Error('Превышено число попыток из-за rate limit'))
  }

  // Одиночный запрос (без стриминга) с retry
  async complete(
    messages: ChatMessage[],
    modelType: 'main' | 'fast' | 'summary' | 'router' | 'emotion' = 'fast',
    systemPrompt?: string
  ): Promise<string> {
    const model = this.getModel(modelType)
    const client = this.getClientForRole(modelType)
    const allMessages: OpenAI.Chat.ChatCompletionMessageParam[] = []

    if (systemPrompt) {
      allMessages.push({ role: 'system', content: systemPrompt })
    }
    allMessages.push(...messages)

    let attempt = 0

    while (attempt <= this.maxRetries) {
      try {
        const res = await client.chat.completions.create({
          model,
          messages: allMessages,
          stream: false,
          temperature: 0.3,
          max_tokens: 1024,
        })
        return res.choices[0]?.message?.content || ''

      } catch (err: unknown) {
        const error = err as { status?: number }
        if (error?.status === 429) {
          const delay = backoffDelay(attempt)
          console.warn(`[AIClient] Rate limit на complete, ждём ${Math.round(delay / 1000)}с`)
          await sleep(delay)
          attempt++
          continue
        }
        throw err
      }
    }

    throw new Error('Rate limit: превышено число попыток')
  }

  // Текст → речь, возвращает base64 mp3
  async textToSpeech(text: string): Promise<string> {
    const apiKey = this.store.get('apiKey') as string
    const endpoint = (this.store.get('apiEndpoint') as string) || 'https://api.onlysq.ru/ai/openai'
    const voice = (this.store.get('voiceId') as string) || 'alloy'
    const response = await fetch(`${endpoint}/audio/speech`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'tts-1', input: text, voice }),
    })
    const buffer = await response.arrayBuffer()
    return Buffer.from(buffer).toString('base64')
  }

  // Function calling — для агента
  async chatWithTools(
    messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }>,
    tools: unknown[],
    signal?: AbortSignal
  ): Promise<{ content: string; tool_calls?: unknown[] }> {
    const model = this.getModel('main')
    const endpoint = (this.store.get('apiEndpoint') as string) || 'https://api.onlysq.ru/ai/openai'
    const apiKey = this.store.get('apiKey') as string

    const assignments = this.store.get('modelAssignments') as Array<{ role: string; modelId: string; providerId: string }> | undefined
    const mainAssignment = assignments?.find(a => a.role === 'main')
    const providers = this.store.get('providers') as Array<{ id: string; baseUrl: string; apiKey: string; enabled: boolean }> | undefined
    const mainProvider = providers?.find(p => p.id === mainAssignment?.providerId && p.enabled)
    const effectiveEndpoint = mainProvider?.baseUrl || endpoint
    const effectiveKey = mainProvider?.apiKey || apiKey

    let attempt = 0
    while (attempt < 6) {
      // Проверяем abort перед каждой попыткой
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      try {
        const res = await fetch(`${effectiveEndpoint}/chat/completions`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${effectiveKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, tools, tool_choice: 'auto' }),
          signal,
        })
        if (res.status === 429) {
          const wait = backoffDelay(attempt)
          await sleep(wait)
          attempt++
          continue
        }
        const data = await res.json() as { choices: Array<{ message: { content: string; tool_calls?: unknown[] } }> }
        const msg = data.choices[0]?.message
        return { content: msg?.content || '', tool_calls: msg?.tool_calls }
      } catch {
        attempt++
        await sleep(backoffDelay(attempt))
      }
    }
    throw new Error('Agent: превышено число попыток')
  }

  // Vision — анализ картинки
  async analyzeImage(
    imageBase64: string,
    prompt: string,
    callbacks: StreamCallbacks
  ): Promise<void> {
    const model = this.getModel('vision')
    const client = this.getClientForRole('vision')
    let attempt = 0

    while (attempt <= this.maxRetries) {
      try {
        const stream = await client.chat.completions.create({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
                { type: 'text', text: prompt },
              ],
            },
          ],
          stream: true,
          max_tokens: 2048,
        })

        let fullText = ''
        for await (const chunk of stream) {
          const token = chunk.choices[0]?.delta?.content || ''
          if (token) {
            fullText += token
            callbacks.onToken(token)
          }
        }
        callbacks.onDone(fullText)
        return

      } catch (err: unknown) {
        const error = err as { status?: number }
        if (error?.status === 429) {
          const delay = backoffDelay(attempt)
          callbacks.onRateLimit?.(Math.round(delay / 1000))
          await sleep(delay)
          attempt++
          continue
        }
        callbacks.onError(err as Error)
        return
      }
    }
  }

  // Эмбеддинги
  async embed(text: string): Promise<number[]> {
    const model = (this.store.get('embeddingModel') as string) || 'gemini-embedding-2'
    let attempt = 0

    while (attempt <= this.maxRetries) {
      try {
        const res = await this.client.embeddings.create({ model, input: text })
        return res.data[0].embedding

      } catch (err: unknown) {
        const error = err as { status?: number }
        if (error?.status === 429) {
          await sleep(backoffDelay(attempt))
          attempt++
          continue
        }
        throw err
      }
    }
    throw new Error('Embed: rate limit')
  }
}
