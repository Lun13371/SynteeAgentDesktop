import { log } from '../logger'

// Извлекает строку из любого формата reasoning токена
// Провайдеры могут слать: string, {text: "..."}, {thinking: "..."}, {content: "..."}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractReasoningText(val: any): string {
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

export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function backoffDelay(attempt: number): number {
  const base = 1000 * Math.pow(2, attempt)
  const jitter = base * 0.3 * Math.random()
  return Math.min(base + jitter, 60000)  // max 60с
}

// Общий wall-clock deadline на все retry-попытки одного запроса.
// Если суммарное время ожидания (с учётом backoff) превысит этот лимит,
// цикл прерывается с понятным сообщением вместо тихого ожидания 8-10 минут.
export const OVERALL_TIMEOUT_MS = 4 * 60 * 1000  // 4 минуты

// Дефолтные параметры генерации. Ранее читались из store ('temperature' /
// 'maxTokens'), но UI-контролы сохраняли в другой ключ (modelParams) —
// настройки пользователя фактически ни на что не влияли. Поля убраны из UI;
// используем фиксированные значения (Anthropic API требует max_tokens).
export const DEFAULT_TEMPERATURE = 0.7
export const DEFAULT_MAX_TOKENS = 16384

export { log }
