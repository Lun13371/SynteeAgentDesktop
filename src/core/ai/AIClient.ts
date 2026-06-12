import OpenAI from 'openai'
import type Store from 'electron-store'

// Экспоненциальный backoff с jitter для rate limit
async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function backoffDelay(attempt: number): number {
  const base = 1000 * Math.pow(2, attempt) // 1s, 2s, 4s, 8s...
  const max = 60000 // макс 60 сек
  const jitter = base * 0.3 * Math.random() // ±30% рандом
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
    const apiKey = (this.store.get('apiKey') as string) || 'sk-placeholder'
    const endpoint = (this.store.get('apiEndpoint') as string) || 'https://api.onlysq.ru/ai/openai'
    return new OpenAI({ apiKey, baseURL: endpoint })
  }

  // Обновить клиент при смене настроек
  reload(): void {
    this.client = this.createClient()
  }

  private getModel(type: 'main' | 'fast' | 'vision' | 'summary' | 'router' | 'emotion'): string {
    const map: Record<string, string> = {
      main: 'claude-sonnet-4-6',
      fast: 'claude-haiku-4-5',
      vision: 'gemini-3.5-flash',
      summary: 'gpt-5.2',
      router: 'nano-banana',
      emotion: 'gpt-5-mini',
    }
    const storeKey = `${type}Model`
    return (this.store.get(storeKey) as string) || map[type]
  }

  // Стриминг чата с retry при rate limit
  async streamChat(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    modelType: 'main' | 'fast' = 'main',
    systemPrompt?: string
  ): Promise<void> {
    const model = this.getModel(modelType)
    const allMessages: OpenAI.Chat.ChatCompletionMessageParam[] = []

    if (systemPrompt) {
      allMessages.push({ role: 'system', content: systemPrompt })
    }
    allMessages.push(...messages)

    let attempt = 0

    while (attempt <= this.maxRetries) {
      try {
        const stream = await this.client.chat.completions.create({
          model,
          messages: allMessages,
          stream: true,
          temperature: (this.store.get('temperature') as number) || 0.7,
          max_tokens: (this.store.get('maxTokens') as number) || 4096,
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
        const error = err as { status?: number; message?: string }

        // Rate limit — ждём и повторяем
        if (error?.status === 429) {
          const delay = backoffDelay(attempt)
          const waitSec = Math.round(delay / 1000)
          callbacks.onRateLimit?.(waitSec)
          console.warn(`[AIClient] Rate limit, ждём ${waitSec}с (попытка ${attempt + 1}/${this.maxRetries})`)
          await sleep(delay)
          attempt++
          continue
        }

        // Другая ошибка — не повторяем
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
    const allMessages: OpenAI.Chat.ChatCompletionMessageParam[] = []

    if (systemPrompt) {
      allMessages.push({ role: 'system', content: systemPrompt })
    }
    allMessages.push(...messages)

    let attempt = 0

    while (attempt <= this.maxRetries) {
      try {
        const res = await this.client.chat.completions.create({
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

  // Vision — анализ картинки
  async analyzeImage(
    imageBase64: string,
    prompt: string,
    callbacks: StreamCallbacks
  ): Promise<void> {
    const model = this.getModel('vision')
    let attempt = 0

    while (attempt <= this.maxRetries) {
      try {
        const stream = await this.client.chat.completions.create({
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

  // Эмбеддинги для LanceDB
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
