import { getEncoding } from 'js-tiktoken'

// cl100k_base — работает для GPT-4, Claude, Gemini с ~95% точностью
let enc: ReturnType<typeof getEncoding> | null = null

function getEncoder() {
  if (!enc) enc = getEncoding('cl100k_base')
  return enc
}

// Кэш чтобы не пересчитывать одно и то же
const cache = new Map<string, number>()
const CACHE_MAX = 200

export function countTokens(text: string): number {
  if (!text) return 0
  if (cache.has(text)) return cache.get(text)!
  try {
    const tokens = getEncoder().encode(text).length
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
    cache.set(text, tokens)
    return tokens
  } catch {
    // fallback: ~4 символа на токен
    return Math.ceil(text.length / 4)
  }
}

export function countMessages(messages: Array<{ role: string; content: string }>): number {
  // Каждое сообщение имеет overhead ~4 токена (role + разделители)
  return messages.reduce((sum, m) => sum + countTokens(m.content) + 4, 0)
}
