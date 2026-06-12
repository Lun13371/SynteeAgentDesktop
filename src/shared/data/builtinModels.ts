import type { ModelMeta, ModelSpeed, ModelCapability } from '../types'

function m(
  id: string, providerId: string, name: string,
  ctx: number, inp: number, out: number,
  speed: ModelSpeed, caps: ModelCapability[], desc: string
): ModelMeta {
  return { id, providerId, name, contextWindow: ctx, inputPrice: inp, outputPrice: out, speed, capabilities: caps, description: desc }
}

const V: ModelCapability = 'vision'
const T: ModelCapability = 'tools'
const R: ModelCapability = 'reasoning'
const C: ModelCapability = 'code'

export const BUILTIN_MODELS: ModelMeta[] = [
  // OpenAI
  m('gpt-4o',               'openai', 'GPT-4o',                128_000,  2.50,  10.00, 'fast',   [V,T,C],   'Мультимодальная флагманская модель OpenAI'),
  m('gpt-4o-mini',          'openai', 'GPT-4o mini',           128_000,  0.15,   0.60, 'fast',   [V,T,C],   'Быстрая и дешёвая версия GPT-4o'),
  m('gpt-4.1',              'openai', 'GPT-4.1',               1_000_000, 2.00,   8.00, 'medium', [V,T,C],   'Улучшенный GPT-4 с контекстом 1M'),
  m('o3',                   'openai', 'o3',                    200_000, 10.00,  40.00, 'slow',   [T,R,C],   'Мощная reasoning-модель OpenAI'),
  m('o4-mini',              'openai', 'o4-mini',               200_000,  1.10,   4.40, 'medium', [T,R,C],   'Быстрый reasoning от OpenAI'),

  // Anthropic
  m('claude-opus-4-5',      'anthropic', 'Claude Opus 4.5',    200_000, 15.00,  75.00, 'slow',   [V,T,R,C], 'Самая мощная модель Anthropic'),
  m('claude-sonnet-4-5',    'anthropic', 'Claude Sonnet 4.5',  200_000,  3.00,  15.00, 'medium', [V,T,C],   'Баланс мощности и скорости'),
  m('claude-sonnet-4-6',    'anthropic', 'Claude Sonnet 4.6',  200_000,  3.00,  15.00, 'medium', [V,T,C],   'Обновлённый Sonnet с улучшенными возможностями'),
  m('claude-haiku-4-5',     'anthropic', 'Claude Haiku 4.5',   200_000,  0.80,   4.00, 'fast',   [V,T,C],   'Самая быстрая и дешёвая модель Anthropic'),

  // Google
  m('gemini-2.5-pro',       'google', 'Gemini 2.5 Pro',        1_000_000, 1.25,  10.00, 'medium', [V,T,R,C], 'Флагман Google с огромным контекстом'),
  m('gemini-2.5-flash',     'google', 'Gemini 2.5 Flash',      1_000_000, 0.15,   0.60, 'fast',   [V,T,C],   'Быстрый и дешёвый Gemini'),
  m('gemini-2.0-flash',     'google', 'Gemini 2.0 Flash',        32_000,  0.10,   0.40, 'fast',   [V,T,C],   'Предыдущее поколение Flash'),

  // Groq
  m('llama-3.3-70b-versatile', 'groq', 'Llama 3.3 70B',        128_000,  0.59,   0.79, 'fast',   [T,C],     'Мета Llama 3.3 70B на Groq — очень быстро'),
  m('llama-3.1-8b-instant',    'groq', 'Llama 3.1 8B Instant', 128_000,  0.05,   0.08, 'fast',   [T,C],     'Молниеносная маленькая модель'),
  m('mixtral-8x7b-32768',      'groq', 'Mixtral 8x7B',          32_768,  0.24,   0.24, 'fast',   [T,C],     'Mixture-of-Experts от Mistral'),
  m('gemma2-9b-it',            'groq', 'Gemma 2 9B',             8_192,  0.20,   0.20, 'fast',   [C],       'Google Gemma 2 на инфраструктуре Groq'),

  // Mistral
  m('mistral-large-latest',    'mistral', 'Mistral Large',      128_000,  2.00,   6.00, 'medium', [T,C],     'Флагман Mistral AI'),
  m('mistral-small-latest',    'mistral', 'Mistral Small',      128_000,  0.20,   0.60, 'fast',   [T,C],     'Быстрый и дешёвый Mistral'),
  m('codestral-latest',        'mistral', 'Codestral',          256_000,  0.30,   0.90, 'fast',   [T,C],     'Специализированная модель для кода'),
  m('mistral-embed',           'mistral', 'Mistral Embed',        8_192,  0.10,   0.00, 'fast',   ['embedding'], 'Embeddings от Mistral'),

  // DeepSeek
  m('deepseek-v3',             'deepseek', 'DeepSeek V3',        64_000,  0.27,   1.10, 'medium', [T,C],     'Мощная открытая модель DeepSeek'),
  m('deepseek-r1',             'deepseek', 'DeepSeek R1',        64_000,  0.55,   2.19, 'slow',   [R,C],     'Reasoning-модель DeepSeek уровня o1'),
  m('deepseek-v4-pro',         'deepseek', 'DeepSeek V4 Pro',   128_000,  0.50,   2.00, 'medium', [T,C,R],   'Новейший флагман DeepSeek'),

  // xAI
  m('grok-3',                  'xai', 'Grok 3',                 131_072,  3.00,  15.00, 'medium', [V,T,C],   'Флагман xAI с веб-доступом'),
  m('grok-3-mini',             'xai', 'Grok 3 Mini',            131_072,  0.30,   0.50, 'fast',   [T,C],     'Быстрый Grok для повседневных задач'),

  // Cohere
  m('command-r-plus',          'cohere', 'Command R+',          128_000,  2.50,  10.00, 'medium', [T,C],     'Флагман Cohere для RAG и агентов'),
  m('command-r',               'cohere', 'Command R',           128_000,  0.15,   0.60, 'fast',   [T,C],     'Быстрый Command R'),
  m('embed-english-v3.0',      'cohere', 'Embed English v3',      512,   0.10,   0.00, 'fast',   ['embedding'], 'Embeddings Cohere для английского'),

  // Together AI
  m('meta-llama/Llama-3.3-70B-Instruct-Turbo', 'together', 'Llama 3.3 70B Turbo', 128_000, 0.88, 0.88, 'fast', [T,C], 'Llama 3.3 70B оптимизированный на Together'),
  m('Qwen/Qwen2.5-72B-Instruct-Turbo',         'together', 'Qwen 2.5 72B Turbo',  128_000, 1.20, 1.20, 'fast', [T,C], 'Qwen 2.5 72B на Together AI'),
  m('mistralai/Mixtral-8x22B-Instruct-v0.1',   'together', 'Mixtral 8x22B',       64_000,  1.20, 1.20, 'medium', [T,C], 'Большая MoE от Mistral'),

  // Fireworks
  m('accounts/fireworks/models/llama-v3p3-70b-instruct', 'fireworks', 'Llama 3.3 70B', 128_000, 0.90, 0.90, 'fast', [T,C], 'Llama 3.3 70B на Fireworks'),
  m('accounts/fireworks/models/qwen3-32b',               'fireworks', 'Qwen3 32B',      32_768, 0.30, 0.30, 'fast', [T,C,R], 'Qwen3 32B с reasoning'),
  m('accounts/fireworks/models/deepseek-v3',             'fireworks', 'DeepSeek V3',    64_000, 0.90, 0.90, 'medium', [T,C], 'DeepSeek V3 на Fireworks'),
]

export const BUILTIN_PROVIDERS_META: Record<string, { name: string; baseUrl: string; docsUrl: string; color: string }> = {
  openai:    { name: 'OpenAI',      baseUrl: 'https://api.openai.com/v1',                color: '#10a37f', docsUrl: 'https://platform.openai.com' },
  anthropic: { name: 'Anthropic',   baseUrl: 'https://api.anthropic.com',                color: '#d4763b', docsUrl: 'https://console.anthropic.com' },
  google:    { name: 'Google',      baseUrl: 'https://generativelanguage.googleapis.com/v1beta', color: '#4285f4', docsUrl: 'https://aistudio.google.com' },
  groq:      { name: 'Groq',        baseUrl: 'https://api.groq.com/openai/v1',            color: '#f55036', docsUrl: 'https://console.groq.com' },
  mistral:   { name: 'Mistral AI',  baseUrl: 'https://api.mistral.ai/v1',                 color: '#ff7000', docsUrl: 'https://console.mistral.ai' },
  ollama:    { name: 'Ollama',      baseUrl: 'http://localhost:11434/v1',                  color: '#aaaaaa', docsUrl: 'https://ollama.ai' },
  cohere:    { name: 'Cohere',      baseUrl: 'https://api.cohere.ai/v1',                  color: '#39594d', docsUrl: 'https://dashboard.cohere.com' },
  together:  { name: 'Together AI', baseUrl: 'https://api.together.xyz/v1',               color: '#7c3aed', docsUrl: 'https://api.together.ai' },
  fireworks: { name: 'Fireworks',   baseUrl: 'https://api.fireworks.ai/inference/v1',     color: '#ef4444', docsUrl: 'https://fireworks.ai' },
  deepseek:  { name: 'DeepSeek',    baseUrl: 'https://api.deepseek.com/v1',               color: '#2563eb', docsUrl: 'https://platform.deepseek.com' },
  xai:       { name: 'xAI Grok',    baseUrl: 'https://api.x.ai/v1',                       color: '#ffffff', docsUrl: 'https://console.x.ai' },
  onlysq:    { name: 'OnlySQ',      baseUrl: 'https://api.onlysq.ru/ai/openai',            color: '#a855f7', docsUrl: 'https://api.onlysq.ru' },
  voidai:    { name: 'VoidAI',      baseUrl: 'https://api.voidai.app/v1',                  color: '#06b6d4', docsUrl: 'https://docs.voidai.app' },
}
