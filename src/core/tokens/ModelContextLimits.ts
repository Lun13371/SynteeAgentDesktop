// Лимиты контекста моделей (в токенах)
// Если модели нет в таблице — возвращаем 0 (нужно брать у провайдера)

const CONTEXT_LIMITS: Record<string, number> = {
  // Claude
  'claude-opus-4': 200000,
  'claude-sonnet-4-6': 200000,
  'claude-sonnet-4-5': 200000,
  'claude-haiku-4-5': 200000,
  'claude-3-5-sonnet': 200000,
  'claude-3-5-haiku': 200000,
  'claude-3-opus': 200000,

  // GPT
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4.1': 1000000,
  'gpt-4.1-mini': 1000000,
  'gpt-4.5': 128000,
  'gpt-5': 200000,
  'gpt-5.1': 200000,
  'o3': 200000,
  'o4-mini': 200000,

  // Gemini
  'gemini-2.5-pro': 1000000,
  'gemini-2.5-flash': 1000000,
  'gemini-3.1-pro': 1000000,
  'gemini-3-flash': 1000000,

  // DeepSeek
  'deepseek-r1': 128000,
  'deepseek-v3': 128000,
  'deepseek-v4-pro': 128000,

  // Grok
  'grok-4.20': 131072,
  'grok-3': 131072,

  // Qwen
  'qwen-3-32b': 32768,
  'qwen-2.5-72b': 128000,

  // MiniMax
  'minimax-m2p7': 1000000,
  'minimax-m2p5': 1000000,

  // Kimi
  'kimi-k2p6': 128000,
}

export function getContextLimit(modelId: string): number {
  if (!modelId) return 128000

  // Точное совпадение
  if (CONTEXT_LIMITS[modelId]) return CONTEXT_LIMITS[modelId]

  // Частичное совпадение — ищем по prefix
  const key = Object.keys(CONTEXT_LIMITS).find(k => modelId.toLowerCase().includes(k.toLowerCase()))
  if (key) return CONTEXT_LIMITS[key]

  // Fallback по семейству
  const id = modelId.toLowerCase()
  if (id.includes('claude')) return 200000
  if (id.includes('gpt-4')) return 128000
  if (id.includes('gemini')) return 1000000
  if (id.includes('deepseek')) return 64000
  if (id.includes('grok')) return 131072
  if (id.includes('qwen')) return 32768
  if (id.includes('minimax')) return 1000000

  return 128000 // universal fallback
}
