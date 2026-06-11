# SYNTEE HELPER — МОДЕЛИ И AI КЛИЕНТ

> Все модели идут через https://api.onlysq.ru/ai/openai (OpenAI-compatible)
> Особенность провайдера: rate limit — нужен постепенно нарастающий retry

---

## СПИСОК МОДЕЛЕЙ ПО ЗАДАЧАМ

### Основной чат (умный, многошаговый)
```
claude-sonnet-4-6         основная по умолчанию
claude-sonnet-4-5         резерв / экономия
gpt-5                     альтернатива топ GPT
gpt-5.1                   чуть быстрее gpt-5
deepseek-v3               бесплатная альтернатива
grok-4.20                 альтернатива xAI
grok-4.3                  резерв grok
```

### Быстрый чат / агентские шаги (много вызовов)
```
claude-haiku-4-5          быстрый Claude
gpt-5-mini                быстрый GPT
gpt-5.2                   быстрый GPT вариант
deepseek-v4-flash         быстрый deepseek
grok-4-1-fast             быстрый grok
llama-3.3-70b             открытый быстрый
llama3.1-8b               самый быстрый простые задачи
mistral-small-3.1         лёгкие задачи
nano-banana               микро (классификация роутинг)
```

### Зрение / OCR / анализ экрана
```
gemini-3.5-flash          основная (Circle to Search экран)
gpt-5.4                   резерв зрение
claude-sonnet-4-6         умный анализ картинки
zai-glm-4.6               дополнительная мультимодальная
```

### STT (речь в текст)
```
gemini-3-flash            основная STT
gpt-5-mini                резерв STT
```

### TTS (текст в речь)
```
gemini-3-flash            основная TTS
```

### Эмбеддинги / векторный поиск (LanceDB)
```
gemini-embedding-2        основная для векторизации
```

### Память / извлечение фактов
```
nano-banana               классификация роутинг
claude-haiku-4-5          извлечение фактов из чата
gpt-5-mini                резервное извлечение
llama3.1-8b               простые задачи памяти
```

### Генерация изображений
```
imagen-3-flash            основная (фотореализм качество)
flux                      художественный стиль
flux-1-schnell            быстрая генерация
stable-diffusion-xl-base-1.0    SD стиль
stable-diffusion-xl-lightning   быстрый SD
recraftv3                 иллюстрации UI стиль
subnp-flux-kontext-fast   быстрый flux
subnp-flux-schnell        ещё быстрее flux
zimage                    дополнительная
perchance                 без цензуры (отдельный режим в настройках)
```

### Агент-наблюдатель (мониторинг экрана каждые 5 сек)
```
gemini-3-flash            быстро и дёшево
```

### Резюме / суммаризация
```
gpt-5.2                   резюме чата сводка дня
deepseek-v4-flash         быстрое резюме
mistral-small-3.1         короткие тексты
```

### Роутинг задач (какой агент запустить)
```
nano-banana               классификатор запросов
llama3.1-8b               резерв роутера
```

### Распознавание эмоций в голосе
```
gpt-5-mini                быстро определить эмоцию
claude-haiku-4-5          резерв
```

---

## AI CLIENT — RATE LIMIT СТРАТЕГИЯ

Особенность провайдера api.onlysq.ru: жёсткий rate limit.
При превышении нужно ждать — НЕ падать с ошибкой.

### Стратегия: Exponential Backoff с Jitter

```typescript
// src/core/ai/AIClient.ts

import OpenAI from 'openai'
import type Store from 'electron-store'

// Конфигурация retry
const RETRY_CONFIG = {
  maxRetries: 8,          // максимум попыток
  baseDelay: 1000,        // начальная задержка 1 сек
  maxDelay: 60000,        // максимальная задержка 60 сек
  jitterFactor: 0.3,      // случайный разброс ±30%
}

// Коды ошибок которые нужно retry
const RETRYABLE_CODES = new Set([429, 500, 502, 503, 504])
const RETRYABLE_MESSAGES = ['rate limit', 'too many requests', 'overloaded', 'timeout']

export class AIClient {
  private client: OpenAI
  private requestQueue: RequestQueue

  constructor(private store: Store) {
    this.client = new OpenAI({
      apiKey: store.get('apiKey') as string,
      baseURL: store.get('apiEndpoint') as string,
      maxRetries: 0, // отключаем встроенный retry — делаем свой
      timeout: 120000,
    })
    this.requestQueue = new RequestQueue()
  }

  // Вычислить задержку для N-й попытки
  private getDelay(attempt: number): number {
    const base = Math.min(
      RETRY_CONFIG.baseDelay * Math.pow(2, attempt),
      RETRY_CONFIG.maxDelay
    )
    // Добавить jitter чтобы избежать thundering herd
    const jitter = base * RETRY_CONFIG.jitterFactor * (Math.random() * 2 - 1)
    return Math.round(base + jitter)
  }

  // Проверить нужен ли retry
  private shouldRetry(error: any): boolean {
    if (error?.status && RETRYABLE_CODES.has(error.status)) return true
    const msg = error?.message?.toLowerCase() ?? ''
    return RETRYABLE_MESSAGES.some(m => msg.includes(m))
  }

  // Универсальный wrapper с retry
  private async withRetry<T>(
    fn: () => Promise<T>,
    context = 'request'
  ): Promise<T> {
    let lastError: any

    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
      try {
        return await fn()
      } catch (error: any) {
        lastError = error

        if (!this.shouldRetry(error)) {
          throw error // не rate limit — сразу бросаем
        }

        if (attempt === RETRY_CONFIG.maxRetries) {
          throw error // исчерпали попытки
        }

        const delay = this.getDelay(attempt)
        const retryAfter = this.parseRetryAfter(error)
        const waitMs = retryAfter ?? delay

        // Уведомить UI о ожидании
        this.notifyRateLimit(context, waitMs, attempt + 1)

        console.log(`[AIClient] Rate limit hit (${context}), attempt ${attempt + 1}/${RETRY_CONFIG.maxRetries}, waiting ${waitMs}ms`)
        await this.sleep(waitMs)
      }
    }

    throw lastError
  }

  // Парсить Retry-After заголовок если есть
  private parseRetryAfter(error: any): number | null {
    const retryAfter = error?.headers?.['retry-after']
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10)
      if (!isNaN(seconds)) return seconds * 1000
    }
    return null
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  private notifyRateLimit(context: string, waitMs: number, attempt: number) {
    const { BrowserWindow } = require('electron')
    BrowserWindow.getAllWindows()[0]?.webContents.send('ai:rate_limit', {
      context,
      waitMs,
      attempt,
      message: `Ожидание rate limit: ${Math.round(waitMs / 1000)}с (попытка ${attempt})`
    })
  }

  // Стриминг чата с retry
  async *streamChat(params: {
    model: string
    messages: OpenAI.ChatCompletionMessageParam[]
    temperature?: number
    maxTokens?: number
    tools?: OpenAI.ChatCompletionTool[]
  }): AsyncGenerator<string> {
    // Для стриминга retry делаем на уровне создания stream
    // Если stream упал на середине — начинаем заново (idempotent)
    let attempt = 0

    while (attempt <= RETRY_CONFIG.maxRetries) {
      try {
        const stream = await this.client.chat.completions.create({
          model: params.model,
          messages: params.messages,
          temperature: params.temperature ?? 0.7,
          max_tokens: params.maxTokens,
          tools: params.tools,
          stream: true,
        })

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content
          if (delta) yield delta
        }
        return // успех

      } catch (error: any) {
        if (!this.shouldRetry(error) || attempt === RETRY_CONFIG.maxRetries) {
          throw error
        }
        const delay = this.getDelay(attempt)
        const waitMs = this.parseRetryAfter(error) ?? delay
        this.notifyRateLimit(`stream:${params.model}`, waitMs, attempt + 1)
        await this.sleep(waitMs)
        attempt++
      }
    }
  }

  // Обычный запрос с retry
  async complete(params: {
    model: string
    messages: OpenAI.ChatCompletionMessageParam[]
    temperature?: number
    responseFormat?: 'text' | 'json'
    tools?: OpenAI.ChatCompletionTool[]
  }): Promise<OpenAI.ChatCompletion> {
    return await this.withRetry(
      () => this.client.chat.completions.create({
        model: params.model,
        messages: params.messages,
        temperature: params.temperature ?? 0.3,
        response_format: params.responseFormat === 'json'
          ? { type: 'json_object' } : undefined,
        tools: params.tools,
        stream: false,
      }),
      `complete:${params.model}`
    )
  }

  // Эмбеддинги с retry
  async embed(text: string): Promise<number[]> {
    const response = await this.withRetry(
      () => this.client.embeddings.create({
        model: this.store.get('embeddingModel') as string ?? 'gemini-embedding-2',
        input: text,
      }),
      'embed'
    )
    return response.data[0].embedding
  }

  // Генерация изображений с retry
  async generateImage(params: {
    model: string
    prompt: string
    size?: '256x256' | '512x512' | '1024x1024'
    n?: number
  }): Promise<string> {
    const response = await this.withRetry(
      () => this.client.images.generate({
        model: params.model,
        prompt: params.prompt,
        size: params.size ?? '1024x1024',
        n: params.n ?? 1,
      }),
      `image:${params.model}`
    )
    return response.data[0].url ?? response.data[0].b64_json ?? ''
  }

  // TTS с retry
  async synthesizeSpeech(params: {
    model: string
    input: string
    voice: string
  }): Promise<ArrayBuffer> {
    const response = await this.withRetry(
      () => this.client.audio.speech.create({
        model: params.model,
        input: params.input,
        voice: params.voice as any,
      }),
      `tts:${params.model}`
    )
    return response.arrayBuffer()
  }

  reload() {
    this.client = new OpenAI({
      apiKey: this.store.get('apiKey') as string,
      baseURL: this.store.get('apiEndpoint') as string,
      maxRetries: 0,
      timeout: 120000,
    })
  }
}
```

### RequestQueue — очередь запросов

```typescript
// src/core/ai/RequestQueue.ts
// Предотвращает одновременные запросы которые точно вызовут rate limit

export class RequestQueue {
  private queue: Array<() => Promise<any>> = []
  private running = 0
  private maxConcurrent: number

  constructor(maxConcurrent = 3) {
    this.maxConcurrent = maxConcurrent
  }

  async add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          resolve(await fn())
        } catch (err) {
          reject(err)
        }
      })
      this.process()
    })
  }

  private async process() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) return

    this.running++
    const fn = this.queue.shift()!
    try {
      await fn()
    } finally {
      this.running--
      this.process() // запустить следующий
    }
  }
}
```

### ModelRegistry — реестр всех моделей

```typescript
// src/core/ai/ModelRegistry.ts

export type ModelRole =
  | 'chat'           // основной чат
  | 'chat_fast'      // быстрый чат агент
  | 'vision'         // зрение OCR
  | 'stt'            // речь в текст
  | 'tts'            // текст в речь
  | 'embedding'      // эмбеддинги
  | 'memory'         // извлечение фактов
  | 'image_gen'      // генерация картинок
  | 'watcher'        // мониторинг экрана
  | 'summary'        // суммаризация
  | 'router'         // роутинг задач
  | 'emotion'        // эмоции

export interface ModelInfo {
  id: string
  name: string
  roles: ModelRole[]
  priority: number  // 1 = основная, 2 = резерв, 3 = альтернатива
  supportsVision: boolean
  supportsTools: boolean
  isImageGen: boolean
  description: string
}

export const MODEL_REGISTRY: ModelInfo[] = [
  // === ОСНОВНОЙ ЧАТ ===
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    roles: ['chat', 'vision', 'memory'],
    priority: 1,
    supportsVision: true,
    supportsTools: true,
    isImageGen: false,
    description: 'Основная модель — лучшее качество ответов',
  },
  {
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    roles: ['chat'],
    priority: 2,
    supportsVision: true,
    supportsTools: true,
    isImageGen: false,
    description: 'Резерв основного чата',
  },
  {
    id: 'gpt-5',
    name: 'GPT-5',
    roles: ['chat', 'vision'],
    priority: 2,
    supportsVision: true,
    supportsTools: true,
    isImageGen: false,
    description: 'Топовый GPT',
  },
  {
    id: 'gpt-5.1',
    name: 'GPT-5.1',
    roles: ['chat'],
    priority: 3,
    supportsVision: true,
    supportsTools: true,
    isImageGen: false,
    description: 'Быстрая версия GPT-5',
  },
  {
    id: 'deepseek-v3',
    name: 'DeepSeek V3',
    roles: ['chat', 'summary'],
    priority: 3,
    supportsVision: false,
    supportsTools: true,
    isImageGen: false,
    description: 'Бесплатная альтернатива высокого качества',
  },
  {
    id: 'grok-4.20',
    name: 'Grok 4.20',
    roles: ['chat'],
    priority: 3,
    supportsVision: false,
    supportsTools: true,
    isImageGen: false,
    description: 'xAI Grok топовый',
  },
  {
    id: 'grok-4.3',
    name: 'Grok 4.3',
    roles: ['chat'],
    priority: 4,
    supportsVision: false,
    supportsTools: true,
    isImageGen: false,
    description: 'xAI Grok резерв',
  },

  // === БЫСТРЫЙ ЧАТ / АГЕНТ ===
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    roles: ['chat_fast', 'memory', 'emotion'],
    priority: 1,
    supportsVision: false,
    supportsTools: true,
    isImageGen: false,
    description: 'Быстрый Claude — агентские шаги и память',
  },
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 Mini',
    roles: ['chat_fast', 'stt', 'memory', 'emotion'],
    priority: 1,
    supportsVision: false,
    supportsTools: true,
    isImageGen: false,
    description: 'Быстрый GPT — STT резерв и память',
  },
  {
    id: 'gpt-5.2',
    name: 'GPT-5.2',
    roles: ['chat_fast', 'summary', 'vision'],
    priority: 2,
    supportsVision: true,
    supportsTools: true,
    isImageGen: false,
    description: 'Быстрый GPT с зрением',
  },
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    roles: ['chat_fast', 'summary'],
    priority: 2,
    supportsVision: false,
    supportsTools: true,
    isImageGen: false,
    description: 'Быстрый DeepSeek',
  },
  {
    id: 'grok-4-1-fast',
    name: 'Grok 4.1 Fast',
    roles: ['chat_fast'],
    priority: 3,
    supportsVision: false,
    supportsTools: true,
    isImageGen: false,
    description: 'Быстрый Grok',
  },
  {
    id: 'llama-3.3-70b',
    name: 'LLaMA 3.3 70B',
    roles: ['chat_fast', 'router'],
    priority: 3,
    supportsVision: false,
    supportsTools: true,
    isImageGen: false,
    description: 'Открытый быстрый',
  },
  {
    id: 'llama3.1-8b',
    name: 'LLaMA 3.1 8B',
    roles: ['chat_fast', 'router', 'memory'],
    priority: 4,
    supportsVision: false,
    supportsTools: false,
    isImageGen: false,
    description: 'Самый быстрый простые задачи',
  },
  {
    id: 'mistral-small-3.1',
    name: 'Mistral Small 3.1',
    roles: ['chat_fast', 'summary'],
    priority: 4,
    supportsVision: false,
    supportsTools: false,
    isImageGen: false,
    description: 'Лёгкие задачи суммаризация',
  },
  {
    id: 'nano-banana',
    name: 'Nano Banana',
    roles: ['router', 'memory'],
    priority: 1,
    supportsVision: false,
    supportsTools: false,
    isImageGen: false,
    description: 'Микро модель — классификация и роутинг',
  },

  // === ЗРЕНИЕ ===
  {
    id: 'gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
    roles: ['vision', 'watcher'],
    priority: 1,
    supportsVision: true,
    supportsTools: false,
    isImageGen: false,
    description: 'Основная для Circle to Search и анализа экрана',
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    roles: ['vision'],
    priority: 2,
    supportsVision: true,
    supportsTools: false,
    isImageGen: false,
    description: 'Резерв для зрения',
  },
  {
    id: 'zai-glm-4.6',
    name: 'ZAI GLM-4.6',
    roles: ['vision', 'chat'],
    priority: 3,
    supportsVision: true,
    supportsTools: false,
    isImageGen: false,
    description: 'Дополнительная мультимодальная',
  },

  // === STT / TTS ===
  {
    id: 'gemini-3-flash',
    name: 'Gemini 3 Flash',
    roles: ['stt', 'tts', 'watcher'],
    priority: 1,
    supportsVision: false,
    supportsTools: false,
    isImageGen: false,
    description: 'Основная STT и TTS',
  },

  // === ЭМБЕДДИНГИ ===
  {
    id: 'gemini-embedding-2',
    name: 'Gemini Embedding 2',
    roles: ['embedding'],
    priority: 1,
    supportsVision: false,
    supportsTools: false,
    isImageGen: false,
    description: 'Основная для LanceDB векторизации',
  },

  // === ГЕНЕРАЦИЯ ИЗОБРАЖЕНИЙ ===
  {
    id: 'imagen-3-flash',
    name: 'Imagen 3 Flash',
    roles: ['image_gen'],
    priority: 1,
    supportsVision: false,
    supportsTools: false,
    isImageGen: true,
    description: 'Основная генерация — фотореализм качество',
  },
  {
    id: 'flux',
    name: 'FLUX',
    roles: ['image_gen'],
    priority: 2,
    supportsVision: false,
    supportsTools: false,
    isImageGen: true,
    description: 'Художественный стиль',
  },
  {
    id: 'flux-1-schnell',
    name: 'FLUX Schnell',
    roles: ['image_gen'],
    priority: 2,
    supportsVision: false,
    supportsTools: false,
    isImageGen: true,
    description: 'Быстрая генерация',
  },
  {
    id: 'stable-diffusion-xl-base-1.0',
    name: 'SDXL Base',
    roles: ['image_gen'],
    priority: 3,
    supportsVision: false,
    supportsTools: false,
    isImageGen: true,
    description: 'Stable Diffusion XL стандарт',
  },
  {
    id: 'stable-diffusion-xl-lightning',
    name: 'SDXL Lightning',
    roles: ['image_gen'],
    priority: 3,
    supportsVision: false,
    supportsTools: false,
    isImageGen: true,
    description: 'Быстрый SD',
  },
  {
    id: 'recraftv3',
    name: 'Recraft V3',
    roles: ['image_gen'],
    priority: 3,
    supportsVision: false,
    supportsTools: false,
    isImageGen: true,
    description: 'Иллюстрации UI стиль',
  },
  {
    id: 'subnp-flux-kontext-fast',
    name: 'Flux Kontext Fast',
    roles: ['image_gen'],
    priority: 3,
    supportsVision: false,
    supportsTools: false,
    isImageGen: true,
    description: 'Быстрый Flux вариант',
  },
  {
    id: 'subnp-flux-schnell',
    name: 'Flux Schnell Sub',
    roles: ['image_gen'],
    priority: 4,
    supportsVision: false,
    supportsTools: false,
    isImageGen: true,
    description: 'Ещё быстрее Flux',
  },
  {
    id: 'zimage',
    name: 'ZImage',
    roles: ['image_gen'],
    priority: 4,
    supportsVision: false,
    supportsTools: false,
    isImageGen: true,
    description: 'Дополнительная генерация',
  },
  {
    id: 'perchance',
    name: 'Perchance',
    roles: ['image_gen'],
    priority: 5,
    supportsVision: false,
    supportsTools: false,
    isImageGen: true,
    description: 'Без цензуры — отдельный режим в настройках',
  },
]

// Получить модели по роли отсортированные по приоритету
export function getModelsByRole(role: ModelRole): ModelInfo[] {
  return MODEL_REGISTRY
    .filter(m => m.roles.includes(role))
    .sort((a, b) => a.priority - b.priority)
}

// Получить основную модель для задачи
export function getPrimaryModel(role: ModelRole): string {
  return getModelsByRole(role)[0]?.id ?? 'claude-sonnet-4-6'
}
```

---

## НАСТРОЙКИ МОДЕЛЕЙ ПО УМОЛЧАНИЮ

```typescript
// В electron-store defaults:
{
  mainModel: 'claude-sonnet-4-6',      // основной чат
  fastModel: 'claude-haiku-4-5',       // агентские шаги
  visionModel: 'gemini-3.5-flash',     // Circle to Search
  sttModel: 'gemini-3-flash',          // STT
  ttsModel: 'gemini-3-flash',          // TTS
  embeddingModel: 'gemini-embedding-2', // LanceDB
  memoryModel: 'claude-haiku-4-5',     // извлечение фактов
  imageModel: 'imagen-3-flash',        // генерация картинок
  watcherModel: 'gemini-3-flash',      // мониторинг экрана
  summaryModel: 'gpt-5.2',             // суммаризация
  routerModel: 'nano-banana',          // роутинг задач
  emotionModel: 'gpt-5-mini',          // эмоции
}
```

---

## UI В НАСТРОЙКАХ — РАЗДЕЛ "ИИ И МОДЕЛИ"

Каждая задача — отдельный dropdown:
- Показывает все совместимые модели (отфильтровано по роли)
- Рекомендованная отмечена звёздочкой
- Описание модели под dropdown
- Кнопка "Сбросить к рекомендованной"

Генерация изображений — отдельный список всех image_gen моделей
с превью примеров если возможно.
