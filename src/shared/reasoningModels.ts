/**
 * Реальные параметры reasoning по официальной документации провайдеров.
 *
 * Источники:
 *   OpenAI:     https://platform.openai.com/docs/guides/reasoning
 *   Groq:       https://console.groq.com/docs/reasoning
 *   Anthropic:  https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
 *   xAI:        https://docs.x.ai/docs/guides/reasoning
 *   DeepSeek:   https://api-docs.deepseek.com/guides/reasoning_model
 *   Gemini:     https://ai.google.dev/gemini-api/docs/thinking
 */

export type ReasoningParamType =
  | 'reasoning_effort'   // OpenAI o3/o4-mini, Grok-3-mini, QwQ-32B
  | 'reasoning_format'   // Groq: QwQ-32B + DeepSeek-R1-Distill
  | 'thinking_budget'    // Anthropic: budget_tokens (число)
  | 'gemini_budget'      // Gemini: thinking_budget (-1 / 0 / число)
  | 'always_on'          // DeepSeek-R1 прямой — reasoning_content всегда есть, без параметра

export interface ReasoningOption {
  /** Отображается в UI */
  label: string
  /** Реальное значение для API */
  value: string
}

export interface ModelReasoningConfig {
  paramType: ReasoningParamType
  /** Название параметра в API запросе */
  apiParam: string
  options: ReasoningOption[]
  default: string
  /** Подсказка в UI */
  hint: string
}

// ── Таблица конфигов ────────────────────────────────────────────────────────

const REASONING_TABLE: Array<{ pattern: RegExp; config: ModelReasoningConfig }> = [

  // ── OpenAI o3, o4-mini ──
  // reasoning_effort: "low" | "medium" | "high"  (default: "medium")
  // o1 НЕ поддерживает этот параметр
  {
    pattern: /^(o3|o3-mini|o4-mini|o4-mini-high)$/i,
    config: {
      paramType: 'reasoning_effort',
      apiParam: 'reasoning_effort',
      options: [
        { label: 'low',    value: 'low'    },
        { label: 'medium', value: 'medium' },
        { label: 'high',   value: 'high'   },
      ],
      default: 'medium',
      hint: 'Кол-во reasoning токенов (OpenAI o-series)',
    },
  },

  // ── Groq: QwQ-32B ──
  // reasoning_effort: "none" | "default" | "auto"
  // reasoning_format: "parsed" | "raw" | "hidden"
  // Оба параметра можно комбинировать. Показываем reasoning_format как главный.
  {
    pattern: /^qwen-qwq-32b$|^qwq-32b/i,
    config: {
      paramType: 'reasoning_format',
      apiParam: 'reasoning_format',
      options: [
        { label: 'parsed', value: 'parsed' },  // reasoning в отдельном поле
        { label: 'raw',    value: 'raw'    },  // <think> теги в content
        { label: 'hidden', value: 'hidden' },  // без рассуждений
      ],
      default: 'parsed',
      hint: 'Формат цепочки мыслей (Groq QwQ-32B)',
    },
  },

  // ── Groq: DeepSeek-R1-Distill-Llama-70B ──
  // reasoning_format: "parsed" | "raw" | "hidden"  (только этот параметр)
  {
    pattern: /^deepseek-r1-distill-llama/i,
    config: {
      paramType: 'reasoning_format',
      apiParam: 'reasoning_format',
      options: [
        { label: 'parsed', value: 'parsed' },
        { label: 'raw',    value: 'raw'    },
        { label: 'hidden', value: 'hidden' },
      ],
      default: 'parsed',
      hint: 'Формат цепочки мыслей (Groq DeepSeek-R1)',
    },
  },

  // ── DeepSeek прямой API ──
  // reasoning_content всегда есть — нет параметра управления
  {
    pattern: /^deepseek-reasoner$|^deepseek-r1$/i,
    config: {
      paramType: 'always_on',
      apiParam: '',
      options: [
        { label: 'Всегда включено', value: 'on' },
      ],
      default: 'on',
      hint: 'reasoning_content всегда возвращается (DeepSeek R1)',
    },
  },

  // ── xAI Grok-3-mini ──
  // reasoning_effort: "low" | "high"  (НЕ medium!), default: "high"
  {
    pattern: /^grok-3-mini$|^grok-3-mini-fast$/i,
    config: {
      paramType: 'reasoning_effort',
      apiParam: 'reasoning_effort',
      options: [
        { label: 'low',  value: 'low'  },
        { label: 'high', value: 'high' },
      ],
      default: 'high',
      hint: 'Глубина рассуждений (xAI Grok-3-mini)',
    },
  },

  // ── Anthropic Claude (extended thinking) ──
  // thinking: { type: "enabled", budget_tokens: N }
  // Минимум 1024. Рекомендуется 5000-10000. claude-*-thinking — всегда включено.
  {
    pattern: /claude-(opus-4|sonnet-4|3-7-sonnet|sonnet-4-5|opus-4-5|3-7)/i,
    config: {
      paramType: 'thinking_budget',
      apiParam: 'thinking',
      options: [
        { label: '1k',  value: '1024'  },
        { label: '5k',  value: '5000'  },
        { label: '10k', value: '10000' },
        { label: '16k', value: '16000' },
        { label: '32k', value: '32000' },
      ],
      default: '10000',
      hint: 'budget_tokens для extended thinking (Anthropic)',
    },
  },

  // ── Gemini 2.5 Pro / Flash ──
  // thinking_config: { thinking_budget: N }
  // -1 = динамический, 0 = выключить, N = конкретный бюджет
  // Gemini 2.5 Pro: min=128, max=32768
  // Gemini 2.5 Flash / Flash-Lite: min=0, max=24576
  {
    pattern: /gemini-2\.5-(pro|flash)/i,
    config: {
      paramType: 'gemini_budget',
      apiParam: 'thinking_config',
      options: [
        { label: 'dynamic',  value: '-1'    },  // модель сама решает
        { label: 'off',      value: '0'     },  // выключить
        { label: '1024',     value: '1024'  },
        { label: '8192',     value: '8192'  },
        { label: '24576',    value: '24576' },
      ],
      default: '-1',
      hint: 'thinking_budget (Gemini 2.5)',
    },
  },
]

// ── Фоллбек-конфиги для моделей без записи в таблице ────────────────────────

/** Generic reasoning_effort — когда каталог (models.dev) помечает модель как
 *  reasoning, но точных уровней мы не знаем (не gateway, нет в таблице). */
export const GENERIC_EFFORT_FALLBACK: ModelReasoningConfig = {
  paramType: 'reasoning_effort',
  apiParam: 'reasoning_effort',
  options: [
    { label: 'off',    value: ''       },
    { label: 'low',    value: 'low'    },
    { label: 'medium', value: 'medium' },
    { label: 'high',   value: 'high'   },
  ],
  default: '',
  hint: 'Режим мышления (models.dev)',
}

/** Anthropic extended thinking — для claude-моделей, которых нет в таблице
 *  (например claude-opus-5 у стороннего провайдера). */
export const CLAUDE_THINKING_FALLBACK: ModelReasoningConfig = {
  paramType: 'thinking_budget',
  apiParam: 'thinking',
  options: [
    { label: 'off', value: ''      },
    { label: '1k',  value: '1024'  },
    { label: '5k',  value: '5000'  },
    { label: '10k', value: '10000' },
    { label: '16k', value: '16000' },
    { label: '32k', value: '32000' },
  ],
  default: '',
  hint: 'budget_tokens для extended thinking (Anthropic)',
}

// ── Публичные функции ────────────────────────────────────────────────────────

/** Возвращает конфиг reasoning для модели или null. */
export function getReasoningConfig(modelId: string): ModelReasoningConfig | null {
  for (const { pattern, config } of REASONING_TABLE) {
    if (pattern.test(modelId)) return config
  }
  return null
}

/**
 * Строит extra-параметры для API запроса.
 *
 * meta — ModelMeta модели: если Syntee-Gateway отдал reasoning-уровни в
 * /v1/models (meta.reasoning.supported), они приоритетнее статической таблицы —
 * шлём reasoning_effort как есть (gateway сам транслирует в native-формат).
 */
export function buildReasoningParams(
  modelId: string,
  selectedValue: string,
  meta?: { reasoning?: { supported: boolean; levels: string[] } } | null
): Record<string, unknown> {
  // Пустое значение / 'off' — мышление выключено, параметр не шлём вовсе
  // (gateway без reasoning_effort → thinking отключён, проверено тестами).
  if (!selectedValue || selectedValue === 'off') return {}

  // 1) Gateway-модель: уровни из /v1/models — authoritative.
  if (meta?.reasoning?.supported) {
    return { reasoning_effort: selectedValue }
  }

  const config = getReasoningConfig(modelId)
  if (!config || config.paramType === 'always_on') return {}

  switch (config.paramType) {
    case 'reasoning_effort':
      return { reasoning_effort: selectedValue }

    case 'reasoning_format':
      return { reasoning_format: selectedValue }

    case 'thinking_budget':
      return {
        thinking: { type: 'enabled', budget_tokens: parseInt(selectedValue) },
      }

    case 'gemini_budget':
      return {
        thinking_config: { thinking_budget: parseInt(selectedValue) },
      }

    default:
      return {}
  }
}
