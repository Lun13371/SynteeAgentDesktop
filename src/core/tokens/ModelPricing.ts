// Цены за 1M токенов в USD центах (inputPerM, outputPerM)
// null = нет данных

export interface ModelPrice {
  inputPerM: number   // центы за 1M input токенов
  outputPerM: number  // центы за 1M output токенов
}

const PRICES: Record<string, ModelPrice> = {
  // Claude
  'claude-opus-4':      { inputPerM: 1500, outputPerM: 7500 },
  'claude-sonnet-4-6':  { inputPerM: 300,  outputPerM: 1500 },
  'claude-sonnet-4-5':  { inputPerM: 300,  outputPerM: 1500 },
  'claude-haiku-4-5':   { inputPerM: 80,   outputPerM: 400  },

  // GPT
  'gpt-4o':             { inputPerM: 250,  outputPerM: 1000 },
  'gpt-4o-mini':        { inputPerM: 15,   outputPerM: 60   },
  'gpt-4.1':            { inputPerM: 200,  outputPerM: 800  },
  'gpt-4.1-mini':       { inputPerM: 40,   outputPerM: 160  },
  'gpt-5':              { inputPerM: 1500, outputPerM: 6000 },
  'o3':                 { inputPerM: 1000, outputPerM: 4000 },
  'o4-mini':            { inputPerM: 110,  outputPerM: 440  },

  // Gemini
  'gemini-2.5-pro':     { inputPerM: 125,  outputPerM: 1000 },
  'gemini-2.5-flash':   { inputPerM: 15,   outputPerM: 60   },

  // DeepSeek
  'deepseek-r1':        { inputPerM: 55,   outputPerM: 219  },
  'deepseek-v3':        { inputPerM: 27,   outputPerM: 109  },

  // Grok
  'grok-4.20':          { inputPerM: 300,  outputPerM: 900  },

  // Qwen
  'qwen-3-32b':         { inputPerM: 40,   outputPerM: 120  },

  // MiniMax
  'minimax-m2p7':       { inputPerM: 30,   outputPerM: 30   },

  // Kimi
  'kimi-k2p6':          { inputPerM: 95,   outputPerM: 285  },
}

export function getModelPrice(modelId: string): ModelPrice | null {
  if (!modelId) return null

  // Точное совпадение
  if (PRICES[modelId]) return PRICES[modelId]

  // Частичное
  const key = Object.keys(PRICES).find(k => modelId.toLowerCase().includes(k.toLowerCase()))
  return key ? PRICES[key] : null
}

// Считаем стоимость в центах
export function estimateCost(inputTokens: number, outputTokens: number, modelId: string): number | null {
  const price = getModelPrice(modelId)
  if (!price) return null
  return (inputTokens / 1_000_000) * price.inputPerM + (outputTokens / 1_000_000) * price.outputPerM
}
