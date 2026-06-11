import OpenAI from 'openai'
import type Store from 'electron-store/ts'

// ─── Rate Limit Retry ────────────────────────────────────
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 6,
  onWait?: (seconds: number) => void
): Promise<T> {
  let attempt = 0
  let delay = 1000

  while (true) {
    try {
      return await fn()
    } catch (err: unknown) {
      attempt++
      const isRateLimit =
        (err as { status?: number })?.status === 429 ||
        (err as { message?: string })?.message?.includes('rate limit') ||
        (err as { message?: string })?.message?.includes('Rate limit')

      if (!isRateLimit || attempt >= maxAttempts) throw err

      // Jitter ±30%
      const jitter = delay * (0.7 + Math.random() * 0.6)
      const waitSec = Math.round(jitter / 1000)
      onWait?.(waitSec)

      await new Promise(r => setTimeout(r, jitter))
      delay = Math.min(delay * 2, 60_000)
    }
  }
}

// ─── AI Client ───────────────────────────────────────────
export class AIClient {
  private client: OpenAI

  constructor(private store: Store) {
    this.client = this.buildClient()
  }

  private buildClient(): OpenAI {
    const key = (this.store.get('apiKey') as string) || ''
    const endpoint = (this.store.get('apiEndpoint') as string) || 'https://api.onlysq.ru/ai/openai'
    return new OpenAI({ apiKey: key, baseURL: endpoint })
  }

  reload(): void {
    this.client = this.buildClient()
  }

  // Стриминг чата
  async *streamChat(params: {
    model: string
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
    temperature?: number
    maxTokens?: number
    onRateLimit?: (seconds: number) => void
  }): AsyncGenerator<string> {
    const stream = await withRetry(
      () => this.client.chat.completions.create({
        model: params.model,
        messages: params.messages,
        temperature: params.temperature ?? 0.7,
        max_tokens: params.maxTokens ?? 4096,
        stream: true,
      }),
      6,
      params.onRateLimit
    )

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content
      if (token) yield token
    }
  }

  // Обычный запрос (не стриминг)
  async chat(params: {
    model: string
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
    temperature?: number
    maxTokens?: number
    onRateLimit?: (seconds: number) => void
  }): Promise<string> {
    const res = await withRetry(
      () => this.client.chat.completions.create({
        model: params.model,
        messages: params.messages,
        temperature: params.temperature ?? 0.7,
        max_tokens: params.maxTokens ?? 2048,
        stream: false,
      }),
      6,
      params.onRateLimit
    )
    return res.choices[0]?.message?.content ?? ''
  }

  // Vision — анализ изображения
  async vision(params: {
    model: string
    prompt: string
    imageBase64: string
    onRateLimit?: (seconds: number) => void
  }): Promise<string> {
    const res = await withRetry(
      () => this.client.chat.completions.create({
        model: params.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: params.prompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${params.imageBase64}` } }
          ]
        }],
        stream: false,
      }),
      6,
      params.onRateLimit
    )
    return res.choices[0]?.message?.content ?? ''
  }

  // Эмбеддинги
  async embed(params: {
    model: string
    input: string | string[]
    onRateLimit?: (seconds: number) => void
  }): Promise<number[][]> {
    const res = await withRetry(
      () => this.client.embeddings.create({
        model: params.model,
        input: params.input,
      }),
      6,
      params.onRateLimit
    )
    return res.data.map(d => d.embedding)
  }

  // Быстрое извлечение факта (для памяти)
  async extractFact(text: string, model: string): Promise<{ key: string; value: string; category: string } | null> {
    try {
      const res = await this.chat({
        model,
        temperature: 0.1,
        maxTokens: 150,
        messages: [{
          role: 'system',
          content: 'Ты извлекаешь факты о пользователе из его сообщений. Отвечай ТОЛЬКО JSON: {"key":"...","value":"...","category":"personal|work|preferences|projects"} или null если нет факта.'
        }, {
          role: 'user',
          content: text
        }]
      })
      const clean = res.trim().replace(/```json|```/g, '').trim()
      if (clean === 'null') return null
      return JSON.parse(clean)
    } catch {
      return null
    }
  }

  // Генерация заголовка чата
  async generateChatTitle(firstMessage: string, model: string): Promise<string> {
    try {
      const res = await this.chat({
        model,
        temperature: 0.3,
        maxTokens: 20,
        messages: [{
          role: 'system',
          content: 'Придумай короткий заголовок (3-5 слов) для чата по первому сообщению пользователя. Только заголовок, без кавычек.'
        }, {
          role: 'user',
          content: firstMessage
        }]
      })
      return res.trim().slice(0, 60)
    } catch {
      return 'Новый чат'
    }
  }
}
