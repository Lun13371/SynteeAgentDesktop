import type { Message, ToolStep } from '../../shared/types'
import { JANITOR_MARKER } from '../../shared/assistants'
import { estimateTokens } from '../tokens/usageTracker'
import { summarizeToolResult } from './janitor'

/**
 * Персистентная компрессия истории (вариант B): детерминированное сжатие
 * tool-результатов ПРЯМО В БД на конце рана. Джанитор рана сжимает контекст
 * только в памяти — каждый новый запрос разворачивает сырые toolSteps из БД
 * заново (кольцо контекста осциллирует 130k → 280k). Здесь те же правила
 * применяются к сохранённым записям, и сжатие становится постоянным.
 *
 * Принципы:
 *  - Заменяется ТОЛЬКО content у tool_result (call+result пары сохраняются) —
 *    структура итераций остаётся валидной для провайдера, кэш UI не ломается.
 *  - Правила детерминированные: префикс истории стабилен между запросами.
 *  - Свежий хвост (tailKeep последних assistant-сообщений с тулами) не трогаем.
 *  - Степы с визуалом (imagePaths/imageUrl), diff'ами, вопросами пользователю
 *    и ошибками никогда не сжимаются.
 *  - Оригинал не сохраняется (по дизайну B: «лишнее зачем хранить») — резюме
 *    сохраняет пути, строки и ошибки.
 */

export interface CompressOptions {
  /** Порог экономии для UPDATE строки сообщения (janitorMinSavingsTokens). */
  minSavingsTokens: number
  /** Сколько последних assistant-сообщений с тулами не трогать. */
  tailKeep: number
}

export interface CompressionPlan {
  messageId: string
  savedTokens: number
  actions: string[]
  /** Обновлённый toolSteps (заменены content у свёрнутых результатов). */
  toolSteps: ToolStep[]
  /** Обновлённая копия iterations (UI рендерит именно её). */
  iterations?: Message['iterations']
}

const STALE_MIN_CHARS = 1200   // как в janitor.scan: короче — резюме не дешевле
const STALE_MIN_SAVED = 150    // как в janitor.scan: замена должна окупиться
const MIN_STUB_CHARS = 800     // дедуп/перечитывание коротких результатов — шум

/** Тулы, чьи результаты трогать нельзя (структурное состояние для агента). */
const PINNED_TOOLS = new Set(['update_todo', 'update_working_memory', 'ask_user', 'request_access'])

/** Замена: контент уже сжат локальным помощником — не обрабатываем повторно. */
function alreadyCompressed(content: string): boolean {
  return content.includes(JANITOR_MARKER)
}

/** Признаки результата, который сжимать нельзя (потеря данных для UI/агента). */
function isProtected(result: ToolStep): boolean {
  if (result.success === false) return true
  if (result.imagePaths?.length || result.imageUrl) return true
  if (result.diff) return true
  if (result.visualAnalysis) return true
  return false
}

/** Стабильно канонизирует аргументы тула для фингерпринта (сортировка ключей). */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(x => stableStringify(x)).join(',') + ']'
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return '{' + entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(',') + '}'
  }
  return JSON.stringify(v)
}

function readPathOf(call: ToolStep): string {
  const args = (call.toolArgs ?? {}) as { path?: unknown; paths?: unknown }
  const raw = args.path ?? (Array.isArray(args.paths) ? args.paths.join('|') : '')
  return String(raw).toLowerCase().replace(/\//g, '\\')
}

interface StepPair {
  msg: Message
  call: ToolStep
  result: ToolStep
}

/** Собирает валидные пары call→result из toolSteps сообщения (по callId). */
function collectPairs(m: Message): StepPair[] {
  const steps = m.toolSteps ?? []
  const resultByCall = new Map<string, ToolStep>()
  for (const s of steps) {
    if (s.type === 'tool_result' && s.callId) resultByCall.set(s.callId, s)
  }
  const pairs: StepPair[] = []
  for (const s of steps) {
    if (s.type !== 'tool_call' || !s.callId) continue
    if (s.toolName && PINNED_TOOLS.has(s.toolName)) continue
    const result = resultByCall.get(s.callId)
    if (result && !alreadyCompressed(result.content) && !isProtected(result)) {
      pairs.push({ msg: m, call: s, result })
    }
  }
  return pairs
}

/**
 * Сжимает сохранённую историю чата. Возвращает планы только для сообщений,
 * чья суммарная экономия ≥ minSavingsTokens (иначе UPDATE не окупается).
 */
export function compressStoredMessages(messages: Message[], opts: CompressOptions): Map<string, CompressionPlan> {
  const plans = new Map<string, CompressionPlan>()
  const stepMessages = messages.filter(m => m.role === 'assistant' && (m.toolSteps?.length ?? 0) > 0)
  if (stepMessages.length <= opts.tailKeep) return plans
  const candidates = stepMessages.slice(0, -opts.tailKeep)

  const pairs = candidates.flatMap(collectPairs)
  if (pairs.length === 0) return plans

  // callId результата → новый контент. Замены применяются к toolSteps и
  // к копиям в iterations (по callId, для старых записей без callId — по позиции).
  const replace = new Map<ToolStep, string>()

  // 1) Дедуп: тот же тул с теми же аргументами — остаётся только свежий результат.
  const byFingerprint = new Map<string, StepPair[]>()
  for (const p of pairs) {
    const key = `${p.call.toolName ?? 'tool'}|${stableStringify(p.call.toolArgs ?? {})}`
    const arr = byFingerprint.get(key)
    if (arr) arr.push(p)
    else byFingerprint.set(key, [p])
  }
  for (const arr of byFingerprint.values()) {
    if (arr.length < 2) continue
    for (const p of arr.slice(0, -1)) {
      const content = p.result.content ?? ''
      if (content.length < MIN_STUB_CHARS) continue
      const saved = estimateTokens(content) - 40
      if (saved < STALE_MIN_SAVED) continue
      replace.set(p.result, `${JANITOR_MARKER} Результат идентичен более свежему вызову ${p.call.toolName ?? 'tool'} с теми же аргументами (ниже по истории) — свёрнуто локальным помощником.`)
    }
  }

  // 2) Перечитывания одного файла (read_file/read_files по нормализованному пути).
  const byPath = new Map<string, StepPair[]>()
  for (const p of pairs) {
    const name = p.call.toolName ?? ''
    if (name !== 'read_file' && name !== 'read_files') continue
    const path = readPathOf(p.call)
    if (!path) continue
    const key = `${name}|${path}`
    const arr = byPath.get(key)
    if (arr) arr.push(p)
    else byPath.set(key, [p])
  }
  for (const [key, arr] of byPath) {
    if (arr.length < 2) continue
    for (const p of arr.slice(0, -1)) {
      if (replace.has(p.result)) continue
      const content = p.result.content ?? ''
      if (content.length < MIN_STUB_CHARS) continue
      const saved = estimateTokens(content) - 40
      if (saved < STALE_MIN_SAVED) continue
      replace.set(p.result, `${JANITOR_MARKER} ${key.split('|')[1]} перечитан позже — актуальное содержимое в более свежем вызове read_file, свёрнуто локальным помощником.`)
    }
  }

  // 3) Старьё: большие результаты старых сообщений → структурное резюме
  //    (голова/хвост сохраняют пути, строки, ошибки — как summarize_stale в ране).
  for (const p of pairs) {
    if (replace.has(p.result)) continue
    const content = p.result.content ?? ''
    if (content.length < STALE_MIN_CHARS) continue
    const summary = summarizeToolResult(p.call.toolName ?? p.result.toolName ?? 'tool', content)
    const saved = estimateTokens(content) - estimateTokens(`${JANITOR_MARKER} ${summary}`)
    if (saved < STALE_MIN_SAVED) continue
    replace.set(p.result, `${JANITOR_MARKER} ${summary}`)
  }

  if (replace.size === 0) return plans

  // 4) Группируем по сообщениям, применяем к toolSteps и iterations.
  for (const m of candidates) {
    const steps = m.toolSteps ?? []
    const msgReplacements = steps.filter(s => replace.has(s))
    if (msgReplacements.length === 0) continue
    const savedTokens = msgReplacements.reduce(
      (sum, s) => sum + Math.max(0, estimateTokens(s.content ?? '') - estimateTokens(replace.get(s)!)),
      0,
    )
    if (savedTokens < opts.minSavingsTokens) continue

    const newSteps: ToolStep[] = steps.map(s => replace.has(s) ? { ...s, content: replace.get(s)! } : s)

    // Копия iterations (UI рендерит именно её): match по callId.
    const repByCallId = new Map<string, string>()
    for (const s of msgReplacements) if (s.callId) repByCallId.set(s.callId, replace.get(s)!)
    let iterations = m.iterations
    if (iterations?.length) {
      iterations = iterations.map(it => ({
        ...it,
        steps: (it.steps ?? []).map(s => {
          const rep = s.callId ? repByCallId.get(s.callId) : undefined
          return rep ? { ...s, content: rep } : s
        }),
      }))
    }

    const actions: string[] = []
    const dedups = msgReplacements.filter(s => (replace.get(s) ?? '').includes('идентичен более свежему вызову')).length
    const rereads = msgReplacements.filter(s => (replace.get(s) ?? '').includes('перечитан позже')).length
    const stale = msgReplacements.length - dedups - rereads
    if (dedups) actions.push(`дедуп ×${dedups}`)
    if (rereads) actions.push(`перечитывания ×${rereads}`)
    if (stale) actions.push(`старьё ×${stale}`)

    plans.set(m.id, { messageId: m.id, savedTokens, actions, toolSteps: newSteps, iterations })
  }

  return plans
}
