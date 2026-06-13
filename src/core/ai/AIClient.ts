import OpenAI from 'openai'
import type Store from 'electron-store'

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

  private getEndpointAndKey(type: string): { endpoint: string; apiKey: string } {
    const assignments = this.store.get('modelAssignments') as Array<{ role: string; modelId: string; providerId: string }> | undefined
    const assignment = assignments?.find(a => a.role === type)
    const providers = this.store.get('providers') as Array<{ id: string; baseUrl: string; apiKey: string; enabled: boolean }> | undefined
    const provider = assignment?.providerId ? providers?.find(p => p.id === assignment.providerId && p.enabled) : undefined
    const endpoint = (provider?.baseUrl || (this.store.get('apiEndpoint') as string) || 'https://api.onlysq.ru/ai/openai').replace(/\/$/, '')
    const apiKey = provider?.apiKey || (this.store.get('apiKey') as string) || ''
    return { endpoint, apiKey }
  }

  // Стриминг через raw fetch — чтобы видеть все поля включая reasoning_content
  async streamChat(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    modelType: 'main' | 'fast' = 'main',
    systemPrompt?: string,
    signal?: AbortSignal
  ): Promise<void> {
    const model = this.getModel(modelType)
    const { endpoint, apiKey } = this.getEndpointAndKey(modelType)

    const allMessages: OpenAI.Chat.ChatCompletionMessageParam[] = []
    if (systemPrompt) allMessages.push({ role: 'system', content: systemPrompt })
    allMessages.push(...messages)

    const needsEnableThinking = /glm|qwq|qwen.*think|deepseek.*r1/i.test(model)

    const body: Record<string, unknown> = {
      model,
      messages: allMessages,
      stream: true,
      temperature: (this.store.get('temperature') as number) || 0.7,
      max_tokens: (this.store.get('maxTokens') as number) || 4096,
    }
    if (needsEnableThinking) body.enable_thinking = true

    let attempt = 0
    let fullText = ''

    while (attempt <= this.maxRetries) {
      try {
        const resp = await fetch(`${endpoint}/chat/completions`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        })

        if (resp.status === 429) {
          const delay = backoffDelay(attempt)
          callbacks.onRateLimit?.(Math.round(delay / 1000))
          await sleep(delay)
          attempt++
          continue
        }

        if (!resp.ok) {
          const txt = await resp.text()
          callbacks.onError(new Error(`HTTP ${resp.status}: ${txt.slice(0, 200)}`))
          return
        }

        const reader = resp.body!.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let thinkingStartMs = 0
        let thinkingDoneSent = false
        let inThinkTag = false
        let thinkBuffer = ''

        const processLine = (line: string) => {
          if (!line.startsWith('data: ')) return
          const raw = line.slice(6).trim()
          if (raw === '[DONE]') return

          let chunk: Record<string, unknown>
          try { chunk = JSON.parse(raw) } catch { return }

          const choices = chunk.choices as Array<Record<string, unknown>> | undefined
          if (!choices?.length) return
          const delta = (choices[0].delta ?? {}) as Record<string, unknown>

          // Путь 1: отдельное поле reasoning_content / thinking
          const rawReasoning = delta.reasoning_content ?? delta.thinking
          if (rawReasoning !== undefined && rawReasoning !== null) {
            const tok = typeof rawReasoning === 'string'
              ? rawReasoning
              : typeof (rawReasoning as Record<string, unknown>).text === 'string'
                ? (rawReasoning as Record<string, unknown>).text as string
                : rawReasoning !== '' ? String(rawReasoning) : ''
            if (tok) {
              if (!thinkingStartMs) thinkingStartMs = Date.now()
              callbacks.onThinkingToken?.(tok)
            } else if (thinkingStartMs && !thinkingDoneSent) {
              thinkingDoneSent = true
              callbacks.onThinkingDone?.(Date.now() - thinkingStartMs)
            }
            return
          }

          // Путь 1 завершился — done
          if (thinkingStartMs && !thinkingDoneSent) {
            thinkingDoneSent = true
            callbacks.onThinkingDone?.(Date.now() - thinkingStartMs)
          }

          // Путь 2: <think>...</think> в content
          const rawContent = (delta.content as string) ?? ''
          if (!rawContent) return

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
            fullText += rawContent
            callbacks.onToken(rawContent)
          }
        }

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (signal?.aborted) { reader.cancel(); break }
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (line.trim()) processLine(line.trim())
          }
        }
        if (buf.trim()) processLine(buf.trim())

        if (thinkingStartMs && !thinkingDoneSent) {
          callbacks.onThinkingDone?.(Date.now() - thinkingStartMs)
        }

        // Фоллбэк: стрим дал 0 токенов
        if (!fullText) {
          const res = await fetch(`${endpoint}/chat/completions`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, stream: false }),
          })
          const data = await res.json() as { choices: Array<{ message: { content: string } }> }
          fullText = data.choices[0]?.message?.content || ''
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
    const { endpoint, apiKey } = this.getEndpointAndKey('main')

    let attempt = 0
    while (attempt < 6) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      try {
        const res = await fetch(`${endpoint}/chat/completions`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, tools, tool_choice: 'auto' }),
          signal,
        })
        if (res.status === 429) { await sleep(backoffDelay(attempt)); attempt++; continue }
        const data = await res.json() as {
          choices: Array<{ message: { content: string; tool_calls?: unknown[]; reasoning_content?: string; thinking?: string } }>
        }
        const msg = data.choices[0]?.message
        const rawReasoning = msg?.reasoning_content ?? msg?.thinking
        const reasoning = typeof rawReasoning === 'string' && rawReasoning ? rawReasoning : undefined
        return { content: msg?.content || '', tool_calls: msg?.tool_calls, reasoning }
      } catch {
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
