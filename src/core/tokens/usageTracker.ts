/**
 * Usage Tracker — единый источник истины для подсчёта токенов и стоимости сессии.
 *
 * Заменяет TokenCounter.ts (удалён) и дублирующий encoder из contextManager.ts.
 * Использует js-tiktoken (cl100k_base) с кэшированным энкодером.
 *
 * Реальные usage-данные от провайдера имеют приоритет над tiktoken-оценкой.
 * Сессионная стоимость накапливается в памяти (живёт пока жив процесс).
 */

import { getEncoding } from 'js-tiktoken'
import { getCatalogModel } from './modelCatalog'
import { getGatewayModelsCache, GATEWAY_PROVIDER_ID } from './gatewayModelsCache'
import { BUILTIN_MODELS } from '../../shared/data/builtinModels'
import { IMAGE_TOKEN_COST } from '../../shared/imageFormat'
import { getModelPrice as getModelPriceStatic, type ModelPrice } from './ModelPricing'

// ─── Кэшированный энкодер ──────────────────────────────────────────────────────

let _enc: ReturnType<typeof getEncoding> | null = null
function getEncoder(): ReturnType<typeof getEncoding> {
  if (!_enc) _enc = getEncoding('cl100k_base')
  return _enc
}

// ─── Точные оценки через tiktoken ──────────────────────────────────────────────

// LRU-кэш результатов estimateTokens. Текст часто повторяется (system prompt,
// tool schemas, старые сообщения) — tiktoken-encode дорогой, нет смысла
// считать дважды для того же текста.
const _tokenCache = new Map<string, { tokens: number; bytes: number }>()
const TOKEN_CACHE_MAX_ENTRIES = 500
const TOKEN_CACHE_MAX_BYTES = 4 * 1024 * 1024
let _tokenCacheBytes = 0
const _messageTokenCache = new Map<string, { tokens: number; bytes: number }>()
const MESSAGE_TOKEN_CACHE_MAX_ENTRIES = 1_000
const MESSAGE_TOKEN_CACHE_MAX_BYTES = 8 * 1024 * 1024
let _messageTokenCacheBytes = 0
const _utf8Encoder = new TextEncoder()

/** Exact-text LRU. UTF-8 byte accounting bounds retained text independently of entry count. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cached = _tokenCache.get(text)
  if (cached !== undefined) {
    _tokenCache.delete(text)
    _tokenCache.set(text, cached)
    return cached.tokens
  }
  let result: number
  try {
    // Treat special-token spellings as ordinary text. Token counting must not
    // throw (or use an approximate fallback) when user content contains them.
    result = getEncoder().encode(text, [], ['all']).length
  } catch {
    result = Math.ceil(text.length / 3.5)
  }
  const bytes = _utf8Encoder.encode(text).byteLength
  if (bytes <= TOKEN_CACHE_MAX_BYTES) {
    while (_tokenCache.size >= TOKEN_CACHE_MAX_ENTRIES || _tokenCacheBytes + bytes > TOKEN_CACHE_MAX_BYTES) {
      const oldest = _tokenCache.keys().next().value
      if (oldest === undefined) break
      const entry = _tokenCache.get(oldest)!
      _tokenCache.delete(oldest)
      _tokenCacheBytes -= entry.bytes
    }
    _tokenCache.set(text, { tokens: result, bytes })
    _tokenCacheBytes += bytes
  }
  return result
}

/** Exposed for deterministic tests/maintenance; does not affect token results. */
export function clearTokenCountCache(): void {
  _tokenCache.clear()
  _tokenCacheBytes = 0
  _messageTokenCache.clear()
  _messageTokenCacheBytes = 0
}

type MessageLike = {
  role: string
  content: string | Array<{ type: string; text?: string; image_url?: unknown }>
  tool_calls?: unknown
  tool_call_id?: string
  name?: string
}

/**
 * Сколько изображений в multipart-контенте сообщения.
 *
 * Раньше визуальные парты игнорировались полностью: из контента брались только
 * `text`, поэтому 30 МБ пикселей давали «0 токенов». Оценка контекста показывала
 * 25-30%, аварийный клапан не срабатывал, а провайдер отвечал 413 — и чат падал
 * без видимой причины. Теперь каждая картинка имеет цену (IMAGE_TOKEN_COST),
 * так что и контекст-бар, и клапан видят визуальную нагрузку.
 */
function countImageParts(content: MessageLike['content']): number {
  if (!Array.isArray(content)) return 0
  let images = 0
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'image_url' || part.type === 'input_image') images++
  }
  return images
}

/**
 * Полная оценка токенов массива сообщений с учётом структуры tool_calls.
 *
 * Раньше считался только `m.content + 4` — токены tool_calls (function.name,
 * JSON arguments), tool_call_id и name терялись. На длинных tool-раундах
 * это занижало оценку на сотни токенов и вызывало рассинхрон между
 * эмиттерами (live-оценка занижала, реальный usage от провайдера — нет).
 *
 * Теперь единая функция используется всеми эмиттерами context_usage.
 */
function estimateMessageTokens(m: MessageLike): number {
  const contentStr = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(p => 'text' in p ? (p as { text: string }).text : '').join('') : '')
  let n = estimateTokens(contentStr || '') + 4 // +4 служебных (role/разделители)
  n += countImageParts(m.content) * IMAGE_TOKEN_COST
  if (m.tool_calls && Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls as Array<Record<string, unknown>>) {
      try { n += estimateTokens(JSON.stringify(tc)) } catch { /* ok */ }
    }
  }
  if (m.tool_call_id) n += estimateTokens(m.tool_call_id)
  if (m.name) n += estimateTokens(m.name)
  return n
}

/**
 * FNV-1a 32-bit: идентичность огромного base64 без материализации копии строки.
 * Раньше fingerprint содержал `JSON.stringify(image_url)` целиком — для 5 МБ
 * картинки это 5 МБ ключа в LRU-кэше на каждое сообщение.
 */
function hashString(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${value.length.toString(36)}:${hash.toString(36)}`
}

/** Stable message-level fingerprint; bounded cache avoids retaining message objects. */
function messageTokenFingerprint(m: MessageLike): string {
  let content = ''
  if (typeof m.content === 'string') content = m.content
  else if (Array.isArray(m.content)) {
    content = m.content.map(p => {
      let image = ''
      if (p.image_url) {
        const url = typeof p.image_url === 'object' && p.image_url !== null && 'url' in p.image_url
          ? String((p.image_url as { url?: unknown }).url ?? '')
          : String(p.image_url)
        image = hashString(url)
      }
      return `${p.type}:${p.text ?? ''}:${image}`
    }).join('|')
  }
  let toolCalls = ''
  try { toolCalls = m.tool_calls ? JSON.stringify(m.tool_calls) : '' } catch { toolCalls = String(m.tool_calls) }
  return JSON.stringify([1, m.role, content, toolCalls, m.tool_call_id ?? '', m.name ?? ''])
}

function getCachedMessageTokens(m: MessageLike): number {
  const fingerprint = messageTokenFingerprint(m)
  const cached = _messageTokenCache.get(fingerprint)
  if (cached) {
    _messageTokenCache.delete(fingerprint)
    _messageTokenCache.set(fingerprint, cached)
    return cached.tokens
  }
  const tokens = estimateMessageTokens(m)
  const bytes = _utf8Encoder.encode(fingerprint).byteLength
  if (bytes <= MESSAGE_TOKEN_CACHE_MAX_BYTES) {
    while (_messageTokenCache.size >= MESSAGE_TOKEN_CACHE_MAX_ENTRIES || _messageTokenCacheBytes + bytes > MESSAGE_TOKEN_CACHE_MAX_BYTES) {
      const oldest = _messageTokenCache.keys().next().value
      if (oldest === undefined) break
      const entry = _messageTokenCache.get(oldest)!
      _messageTokenCache.delete(oldest)
      _messageTokenCacheBytes -= entry.bytes
    }
    _messageTokenCache.set(fingerprint, { tokens, bytes })
    _messageTokenCacheBytes += bytes
  }
  return tokens
}

export function estimateMessagesTokensFull(messages: Array<MessageLike>): number {
  return messages.reduce((sum, m) => sum + getCachedMessageTokens(m), 0)
}

/** Тонкая обёртка над estimateMessagesTokensFull (обратная совместимость). */
export function estimateMessagesTokens(messages: Array<{ role: string; content: string }>): number {
  return estimateMessagesTokensFull(messages as MessageLike[])
}

// ─── Remote (Rust) token counting ─────────────────────────────────────────────
//
// `js-tiktoken` is a pure-JS BPE: encoding a 200-300k-token history costs
// 0.5-2s of CPU on whatever thread calls it. When that thread is the main
// process it blocks IPC and rendering.
//
// The Rust sidecar ships the same cl100k_base tables natively, so the heavy
// callers ask it instead. The counter is *injected* rather than imported so this
// module stays free of node built-ins — the renderer pulls DEFAULT_CONTEXT_SETTINGS
// out of contextManager, which imports this file.
//
// Behaviour when no counter is installed (renderer, tests, sidecar missing):
// every async helper transparently falls back to the synchronous JS estimate.
// Counts are identical either way, only the thread that does the work changes.

export interface RemoteTokenCounter {
  /** Exact counts for many strings in one round-trip; null when unavailable. */
  countBatch(texts: string[]): Promise<number[] | null>
  truncate(text: string, maxTokens: number): Promise<{ text: string; tokens: number; truncated: boolean }>
}

let _remoteCounter: RemoteTokenCounter | null = null

/** Installed by the main process / ai-worker once the sidecar client is ready. */
export function setRemoteTokenCounter(counter: RemoteTokenCounter | null): void {
  _remoteCounter = counter
}

export function hasRemoteTokenCounter(): boolean {
  return _remoteCounter !== null
}

/** All strings that contribute tokens to one message, in a stable order. */
function messageTokenParts(m: MessageLike): string[] {
  const contentStr = typeof m.content === 'string'
    ? m.content
    : (Array.isArray(m.content) ? m.content.map(p => 'text' in p ? (p as { text: string }).text : '').join('') : '')
  const parts: string[] = [contentStr || '']
  if (m.tool_calls && Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls as Array<Record<string, unknown>>) {
      try { parts.push(JSON.stringify(tc)) } catch { /* unserializable tool call — same as sync path */ }
    }
  }
  if (m.tool_call_id) parts.push(m.tool_call_id)
  if (m.name) parts.push(m.name)
  return parts
}

/**
 * Same result as estimateMessagesTokensFull, but the BPE work happens in Rust
 * off the calling thread. Falls back to the synchronous estimate when the
 * sidecar is unavailable or returns a malformed batch.
 */
export async function estimateMessagesTokensAsync(messages: Array<MessageLike>): Promise<number> {
  if (messages.length === 0) return 0
  const counter = _remoteCounter
  if (!counter) return estimateMessagesTokensFull(messages)

  const parts: string[] = []
  const starts: number[] = []
  for (const message of messages) {
    starts.push(parts.length)
    parts.push(...messageTokenParts(message))
  }
  starts.push(parts.length)

  let counts: number[] | null
  try {
    counts = await counter.countBatch(parts)
  } catch {
    counts = null
  }
  if (!counts || counts.length !== parts.length) return estimateMessagesTokensFull(messages)

  let total = 0
  for (let i = 0; i < messages.length; i++) {
    let sum = 0
    for (let j = starts[i]; j < starts[i + 1]; j++) sum += counts[j]
    // Пиксели не проходят через BPE — у них фиксированная цена, как в синхронном пути.
    total += sum + countImageParts(messages[i].content) * IMAGE_TOKEN_COST + 4 // +4 служебных (role/разделители)
  }
  return total
}

/**
 * Cut text to a token budget without splitting a word. Prefers the Rust
 * implementation; the JS path is only used when the sidecar is unavailable.
 */
export async function truncateToTokensAsync(
  text: string,
  maxTokens: number,
): Promise<{ text: string; tokens: number; truncated: boolean }> {
  const counter = _remoteCounter
  if (counter) {
    try {
      const result = await counter.truncate(text, maxTokens)
      // Trim a partially cut trailing word so the summary does not end mid-word.
      const trimmed = result.truncated ? result.text.replace(/\s+\S*$/, '') : result.text
      return { text: trimmed, tokens: result.tokens, truncated: result.truncated }
    } catch { /* fall through to the JS path */ }
  }
  if (estimateTokens(text) <= maxTokens) return { text, tokens: estimateTokens(text), truncated: false }
  const words = text.split(/\s+/)
  let out = ''
  let used = 0
  for (const word of words) {
    const cost = estimateTokens(word)
    if (used + cost > maxTokens) break
    out += (out ? ' ' : '') + word
    used += cost
  }
  return { text: out, tokens: used, truncated: true }
}

// ─── Единые пороги компакции контекста ────────────────────────────────────────
// Раньше Agent.ts (аварийный клапан dropOldestRoundsIfOverflow) и
// chat.ipc.ts (applyRollingWindowAsync) считали пороги по-разному и от разных
// оценок contextWindow (Agent.ts занижал пол до 32k) — это давало пилообразные
// скачки реального prompt_tokens. Теперь оба места берут проценты отсюда.

// Аварийный клапан — последняя линия защиты от hard-fail API. Держим близко
// к 100%, он не должен быть рабочим механизмом компакции (эту роль играет
// rolling window).
export const HARD_LIMIT_PCT = 99
// После срабатывания клапана — целимся сюда (% от contextWindow, не от
// hard-лимита), с явным запасом (гистерезис), чтобы клапан не триггерился
// повторно на следующем же раунде из-за пары новых сообщений.
export const HARD_LIMIT_TARGET_PCT = 80

// Rolling window (между сообщениями пользователя, chat.ipc.ts) — срабатывает
// раньше аварийного клапана, с summary вместо жёсткого дропа.
export const ROLLING_TRIGGER_PCT = 92

export function getHardLimitTokens(contextWindow: number): number {
  return Math.floor(contextWindow * HARD_LIMIT_PCT / 100)
}

export function getHardLimitTargetTokens(contextWindow: number): number {
  return Math.floor(contextWindow * HARD_LIMIT_TARGET_PCT / 100)
}

// ─── Снапшоты использования ───────────────────────────────────────────────────

export interface RealUsage {
  promptTokens: number
  completionTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface UsageSnapshot {
  estimated: number
  limit: number
  pct: number
  status: 'ok' | 'warn' | 'critical'
  source: 'real' | 'estimate'
  breakdown: {
    history: number
    system: number
    tools: number
    current: number
    toolResults?: number
    completionTokens?: number
    // Prompt caching: токены, прочитанные из кэша (со скидкой) и записанные в кэш
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  compressed?: boolean
  sessionCostCents?: number | null
  sessionRequests?: number
}

// Overhead константы — единственный источник истины. contextManager.ts и
// Agent.ts импортируют TOOL_SCHEMAS_OVERHEAD отсюда (раньше значение было
// продублировано в нескольких местах с риском рассинхрона).
export const TOOL_SCHEMAS_OVERHEAD = 3800
const API_OVERHEAD = 100

export function buildSnapshotFromReal(
  real: RealUsage,
  limit: number,
  prevBreakdown?: UsageSnapshot['breakdown'],
): UsageSnapshot {
  const pct = Math.min(100, Math.round(real.promptTokens / limit * 100))
  const status = pct >= 85 ? 'critical' : pct >= 60 ? 'warn' : 'ok'

  // Раньше breakdown наследовался verbatim из последнего estimate-эмиттера —
  // это показывало ЧУЖОЙ breakdown под видом 'real' (т.к. источники считали
  // по разным формулам). Теперь масштабируем последний estimate-breakdown
  // пропорционально реальному promptTokens, чтобы sum(breakdown)=promptTokens
  // и пропорции System/History/Tools сохранялись. current=0 — реальный usage
  // относится к уже отправленному запросу; live-typing для следующего сообщения
  // добавится в renderer поверх (см. useContextCounter).
  let breakdown: UsageSnapshot['breakdown']
  if (prevBreakdown) {
    const baseSum = (prevBreakdown.history || 0) + (prevBreakdown.system || 0) + (prevBreakdown.tools || 0) + (prevBreakdown.current || 0)
    const scale = baseSum > 0 ? real.promptTokens / baseSum : 0
    const history = Math.max(0, Math.round((prevBreakdown.history || 0) * scale))
    const system = Math.max(0, Math.round((prevBreakdown.system || 0) * scale))
    const tools = Math.max(0, Math.round((prevBreakdown.tools || 0) * scale))
    // добиваем разницу округления в history
    const fixed = history + system + tools
    const drift = real.promptTokens - fixed
    breakdown = {
      history: drift !== 0 ? Math.max(0, history + drift) : history,
      system,
      tools,
      current: 0,
      toolResults: prevBreakdown.toolResults != null ? Math.max(0, Math.round(prevBreakdown.toolResults * scale)) : undefined,
      completionTokens: real.completionTokens,
      cacheReadTokens: real.cacheReadTokens,
      cacheWriteTokens: real.cacheWriteTokens,
    }
  } else {
    breakdown = {
      history: real.promptTokens,
      system: 0,
      tools: 0,
      current: 0,
      completionTokens: real.completionTokens,
      cacheReadTokens: real.cacheReadTokens,
      cacheWriteTokens: real.cacheWriteTokens,
    }
  }

  return {
    estimated: real.promptTokens,
    limit,
    pct,
    status,
    source: 'real',
    breakdown,
  }
}

/**
 * Единая функция оценки контекста для всех эмиттеров context_usage (chat:send,
 * context:calculate, Agent.onContextUpdate, AIClient.onContextCounted).
 * Заменяет разрозненные inline-формулы и гарантирует консистентный breakdown.
 *
 * `messages` — массив сообщений как есть (может включать system[0], историю
 * с tool_calls/tool results, текущее user-сообщение или нет — зависит от
 * вызывающего кода). Функция НЕ добавляет и НЕ убирает system/current сама;
 * опции `systemPrompt` / `currentMsgTokens` задаются отдельно, чтобы
 * вызывающий код контролировал семантику.
 *
 *   history = estimateMessagesTokensFull(messages)   // всё что передано
 *   system = opts.systemPrompt ? estimateTokens+4 : 0
 *   tools  = opts.includeToolSchemas ? TOOL_SCHEMAS_OVERHEAD : 0
 *   current= opts.currentMsgTokens ?? 0
 *   estimated = history + system + tools + current + API_OVERHEAD
 */
export function computeContextSnapshot(
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: unknown }>; tool_calls?: unknown; tool_call_id?: string; name?: string }>,
  limit: number,
  opts: {
    systemPrompt?: string
    currentMsgTokens?: number
    includeToolSchemas?: boolean
    /** Exact schemas sent to the model (including enabled external tools). */
    toolSchemas?: unknown[]
    toolResultTokens?: number
  } = {},
): UsageSnapshot {
  const historyTokens = estimateMessagesTokensFull(messages)
  const systemPromptTokens = opts.systemPrompt ? estimateTokens(opts.systemPrompt) + 4 : 0
  const toolSchemasTokens = opts.includeToolSchemas === true
    ? opts.toolSchemas !== undefined
      ? (opts.toolSchemas.length ? estimateTokens(JSON.stringify(opts.toolSchemas)) : 0)
      : TOOL_SCHEMAS_OVERHEAD
    : 0
  const currentMsgTokens = opts.currentMsgTokens ?? 0
  const toolResultTokens = opts.toolResultTokens ?? 0

  const estimated = historyTokens + systemPromptTokens + toolSchemasTokens + currentMsgTokens + toolResultTokens + API_OVERHEAD
  const pct = Math.min(100, Math.round(estimated / limit * 100))
  const status = pct >= 85 ? 'critical' : pct >= 60 ? 'warn' : 'ok'

  return {
    estimated,
    limit,
    pct,
    status,
    source: 'estimate',
    breakdown: {
      history: historyTokens,
      system: systemPromptTokens,
      tools: toolSchemasTokens,
      current: currentMsgTokens,
      toolResults: toolResultTokens > 0 ? toolResultTokens : undefined,
    },
  }
}

export function buildSnapshotFromEstimate(
  messages: Array<{ role: string; content: string }>,
  limit: number,
  opts: {
    systemPrompt?: string
    currentMsgTokens?: number
    toolResultTokens?: number
    includeToolSchemas?: boolean
  } = {},
): UsageSnapshot {
  // Тонкая обёртка: history=messages (без system), system/tools/current — опциями.
  return computeContextSnapshot(messages, limit, {
    systemPrompt: opts.systemPrompt,
    currentMsgTokens: opts.currentMsgTokens,
    includeToolSchemas: opts.includeToolSchemas,
    toolResultTokens: opts.toolResultTokens,
  })
}

// ─── Сессионная стоимость ─────────────────────────────────────────────────────
// Map<chatId, { totalCents, requests }> — живёт пока жив процесс
const sessionCosts = new Map<string, { totalCents: number; requests: number }>()

export function recordSessionCost(
  chatId: string,
  providerId: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens?: number,
  cacheWriteTokens?: number,
): { totalCents: number; requests: number } | null {
  const pricing = getModelPriceInfo(providerId, modelId)
  if (!pricing) return null

  // Anthropic prompt caching тарификация:
  //   - input_tokens (non-cached) — полная цена (inputPerM)
  //   - cache_read_input_tokens   — цена со скидкой ~90% (cacheReadPerM)
  //   - cache_creation_input_tokens — премия ~25% (cacheWritePerM)
  //
  // Семантика promptTokens в колбэке onUsage:
  //   - OpenAI:   prompt_tokens = TOTAL (включая cached_tokens)
  //   - Anthropic: promptTokens = total (input + cacheRead + cacheWrite), т.к.
  //     AIClient нормализует: totalPrompt = input + cache_read + cache_creation
  //
  // Поэтому nonCachedInput = promptTokens - cacheRead - cacheWrite
  const nonCachedInput = Math.max(0, inputTokens - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0))
  let cents = (nonCachedInput / 1_000_000) * pricing.inputPerM
  cents += (outputTokens / 1_000_000) * pricing.outputPerM
  if (cacheReadTokens && pricing.cacheReadPerM) {
    cents += (cacheReadTokens / 1_000_000) * pricing.cacheReadPerM
  }
  if (cacheWriteTokens && pricing.cacheWritePerM) {
    cents += (cacheWriteTokens / 1_000_000) * pricing.cacheWritePerM
  }

  const entry = sessionCosts.get(chatId) ?? { totalCents: 0, requests: 0 }
  entry.totalCents += cents
  entry.requests += 1
  sessionCosts.set(chatId, entry)
  return { totalCents: entry.totalCents, requests: entry.requests }
}

export function getSessionCost(chatId: string): { totalCents: number; requests: number } | null {
  return sessionCosts.get(chatId) ?? null
}

export function resetSessionCost(chatId: string): void {
  sessionCosts.delete(chatId)
}

// ─── Цены моделей (catalog → builtin → static pricing table) ──────────────────

export function getModelPriceInfo(providerId: string, modelId: string): ModelPrice | null {
  if (!modelId) return null

  // 1. Модели Syntee-Gateway — цены отдаёт сам gateway (pricing per_1k →
  // ModelMeta $/1M → центы ×100). Каталог models.dev провайдера не знает и
  // substring-матчингом подменяет модель похожей (glm-5.3 → zai:glm-5).
  if (providerId === GATEWAY_PROVIDER_ID) {
    const gw = getGatewayModelsCache().find(m => m.id === modelId)
    if (gw && (gw.inputPrice != null || gw.outputPrice != null)) {
      return {
        inputPerM: Math.round((gw.inputPrice ?? 0) * 100),
        outputPerM: Math.round((gw.outputPrice ?? 0) * 100),
      }
    }
  }

  // 2. Каталог models.dev
  const fromCatalog = getCatalogModel(providerId, modelId)
  if (fromCatalog && (fromCatalog.inputPricePerM > 0 || fromCatalog.outputPricePerM > 0)) {
    return {
      inputPerM: fromCatalog.inputPricePerM,
      outputPerM: fromCatalog.outputPricePerM,
      cacheReadPerM: fromCatalog.cacheReadPerM,
      cacheWritePerM: fromCatalog.cacheWritePerM,
    }
  }

  // 3. Builtin модели (цены в $ за 1M → переводим в центы ×100)
  const builtin = BUILTIN_MODELS.find(m => m.id === modelId && (providerId ? m.providerId === providerId : true))
  if (builtin?.inputPrice != null && builtin?.outputPrice != null) {
    return { inputPerM: Math.round(builtin.inputPrice * 100), outputPerM: Math.round(builtin.outputPrice * 100) }
  }

  // 4. Статичная таблица ModelPricing (substring fallback)
  return getModelPriceStatic(modelId)
}

export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  providerId: string,
  modelId: string,
): number | null {
  const price = getModelPriceInfo(providerId, modelId)
  if (!price) return null
  return (inputTokens / 1_000_000) * price.inputPerM + (outputTokens / 1_000_000) * price.outputPerM
}
