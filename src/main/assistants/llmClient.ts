import { localModels, type QueuePriority } from '../localModels/LocalModelManager'
import { log } from '../../core/logger'

export type { QueuePriority }

export function enqueue(prompt: string, priority: QueuePriority, maxTokens = 100, timeoutMs?: number, signal?: AbortSignal): Promise<string> {
  return localModels.complete(prompt, { priority, maxTokens, timeoutMs, signal })
}

export async function judgeRelevance(stepContext: string, hintContent: string): Promise<{ relevant: boolean; reason: string }> {
  const prompt = `You are a relevance judge. Given the agent's current step and a candidate hint, decide if the hint is useful RIGHT NOW.

Current step: ${stepContext.slice(0, 400)}

Candidate hint: ${hintContent.slice(0, 400)}

Answer in exactly this format:
RELEVANT: YES or NO
REASON: one short sentence

Do not add anything else.`

  try {
    const text = await enqueue(prompt, 'watcher', 60)
    const relevant = /RELEVANT:\s*YES/i.test(text)
    const reasonMatch = text.match(/REASON:\s*(.+)/i)
    return { relevant, reason: reasonMatch?.[1]?.trim() ?? '' }
  } catch (err) {
    log('[LlmClient] judge failed: %s', (err as Error).message)
    return { relevant: true, reason: 'judge unavailable, defaulting to relevant' }
  }
}

export interface JanitorAnalysis {
  duplicates: Array<{ indices: number[]; description: string }>
  rereads: Array<{ path: string; indices: number[] }>
  stale: Array<{ index: number; summary: string }>
}

export async function analyzeContext(messagesSummary: string): Promise<JanitorAnalysis> {
  const prompt = `You are a context optimizer. Analyze this conversation summary for waste patterns.

${messagesSummary.slice(0, 2000)}

Identify:
1. DUPLICATES: identical tool calls repeated (give indices)
2. REREADS: same file read multiple times (give path and indices)
3. STALE: old tool results no longer needed (give index and 1-line summary)

Answer in JSON:
{"duplicates":[{"indices":[0,1],"description":"..."}],"rereads":[{"path":"...","indices":[2,3]}],"stale":[{"index":4,"summary":"..."}]}

Only output JSON, nothing else.`

  try {
    const text = await enqueue(prompt, 'janitor', 300)
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { duplicates: [], rereads: [], stale: [] }
    const parsed = JSON.parse(jsonMatch[0]) as JanitorAnalysis
    return {
      duplicates: Array.isArray(parsed.duplicates) ? parsed.duplicates : [],
      rereads: Array.isArray(parsed.rereads) ? parsed.rereads : [],
      stale: Array.isArray(parsed.stale) ? parsed.stale : [],
    }
  } catch (err) {
    log('[LlmClient] janitor analysis failed: %s', (err as Error).message)
    return { duplicates: [], rereads: [], stale: [] }
  }
}

export function getQueueLength(): number { return localModels.getStatus().queueLength }
export function isProcessing(): boolean { return localModels.isReady() }

// ─── Новые мини-агенты (все advisory, короткие промпты, низкий приоритет) ───

/** Мелкие модели заворачивают JSON в ```-фенсы, prose или {"facts":[...]} —
 *  вытаскиваем массив перебором кандидатов. null = ничего парсибельного. */
function parseJsonArray(text: string): Array<Record<string, unknown>> | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const m = cleaned.match(/\[[\s\S]*\]/)
  for (const candidate of [cleaned, m?.[0] ?? '']) {
    if (!candidate) continue
    try {
      const arr: unknown = JSON.parse(candidate)
      if (Array.isArray(arr)) return arr as Array<Record<string, unknown>>
      if (arr && typeof arr === 'object') {
        for (const v of Object.values(arr as Record<string, unknown>)) {
          if (Array.isArray(v)) return v as Array<Record<string, unknown>>
        }
      }
    } catch { /* пробуем следующий кандидат */ }
  }
  return null
}

/** Navigator: drift-судья + нарушения закреплённых ограничений (бинарные вердикты).
 *  `todo` — актуальный todo-лист: сверка «уход от плана», не только цели. */
export async function judgeDrift(objective: string, transcript: string, constraints: string[] = [], todo = '', signal?: AbortSignal): Promise<{ drift: boolean; violation: boolean; reason: string }> {
  const goalPart = objective ? `Goal: ${objective.slice(0, 300)}` : 'Goal: (none — check constraints only)'
  const rules = constraints.length ? `\nPinned user constraints:\n${constraints.slice(0, 8).map(c => `- ${c.slice(0, 150)}`).join('\n')}\n` : ''
  const todoPart = todo ? `\nTodo plan:\n${todo.slice(0, 400)}\n` : ''
  const prompt = `${goalPart}\n${rules}${todoPart}\nRecent agent actions:\n${transcript.slice(0, 900)}\n\nAnswer exactly:\nDRIFT: YES or NO (unrelated work / scope creep vs the goal and todo plan; NO when no goal)\nVIOLATION: YES or NO (agent breaks a pinned constraint; NO when none listed)\nREASON: one short sentence`
  try {
    // Mid-run advisory — приоритет выше janitor'а: судья полезен только пока
    // ран идёт, а janitor-задачи в очереди спокойно ждут.
    const text = await enqueue(prompt, 'default', 60, undefined, signal)
    return {
      drift: /DRIFT:\s*YES/i.test(text),
      violation: /VIOLATION:\s*YES/i.test(text),
      reason: text.match(/REASON:\s*(.+)/i)?.[1]?.trim() ?? '',
    }
  } catch { return { drift: false, violation: false, reason: '' } }
}

/** Archivist: дистиллировать сессию в 1-3 факта для долгосрочной памяти (JSON).
 *  `modifiedFiles` — файлы, правленные в ране: дешёвый сигнал дистилляции,
 *  какие области проекта «горячие» (раньше передавался, но не использовался). */
export async function distillSession(transcript: string, modifiedFiles: string[] = []): Promise<Array<{ content: string; kind: string }>> {
  const filesPart = modifiedFiles.length ? `Files modified this session: ${modifiedFiles.slice(0, 10).join(', ')}\n` : ''
  const prompt = `From this coding session transcript, extract 1-3 durable facts worth remembering (decisions, gotchas, user constraints, project conventions). The transcript contains tool-call noise — ignore it. If there is nothing durable, return [].\n\n${filesPart}${transcript.slice(0, 1500)}\n\nOutput JSON array: [{"content":"...","kind":"project"}] where kind is project|feedback|user. Only JSON.`
  try {
    // Дистилляция — самое длинное поколение мини-агентов (русский текст в JSON
    // ест токены): дефолтные 15с на CPU-декоде не хватало, вызов молча умирал
    // по таймауту → «Archivist: 0 срабатываний». Даём 40с и 400 токенов.
    const text = await enqueue(prompt, 'janitor', 400, 40_000)
    if (!text.trim()) {
      log('[LlmClient] distill: empty output (timeout or model refusal)')
      return []
    }
    const arr = parseJsonArray(text)
    if (!arr) {
      log('[LlmClient] distill: unparseable output (%d chars): %s', text.length, text.slice(0, 200))
      return []
    }
    return arr
      .filter(x => typeof x.content === 'string' && (x.content as string).length > 5)
      .slice(0, 3)
      .map(x => ({ content: String(x.content).slice(0, 400), kind: ['project', 'feedback', 'user'].includes(String(x.kind)) ? String(x.kind) : 'project' }))
  } catch (err) {
    log('[LlmClient] distill failed: %s', (err as Error).message)
    return []
  }
}

/** J1: LLM-экстракция ограничений из user-текста (JSON array строк). */
export async function extractConstraints(text: string, signal?: AbortSignal): Promise<string[]> {
  const prompt = `Extract standing user constraints/rules (things the agent must always/never do) from this message. Ignore transient task steps.\n\n${text.slice(0, 700)}\n\nOutput JSON array of short strings, e.g. ["never modify tests","always use pnpm"]. Only JSON.`
  try {
    const out = await enqueue(prompt, 'watcher', 150, undefined, signal)
    const m = out.match(/\[[\s\S]*\]/)
    if (!m) return []
    const arr = JSON.parse(m[0]) as unknown[]
    return arr.filter(x => typeof x === 'string' && x.length > 3).slice(0, 6).map(x => String(x))
  } catch { return [] }
}

/** J4: структурное резюме старого tool-результата. */
export async function summarizeTool(toolName: string, content: string, signal?: AbortSignal): Promise<string> {
  const prompt = `Summarize this "${toolName}" tool result in one line, KEEPING file paths, line numbers and key facts/errors:\n${content.slice(0, 900)}\n\nOne line only.`
  try { return (await enqueue(prompt, 'janitor', 100, undefined, signal)).trim() } catch { return '' }
}

export interface CapabilityVerdict {
  helpful: boolean
  id: string
  action: string
  confidence: number
}

/** Watcher v2: точный вердикт — какую конкретную возможность вызвать сейчас.
 *  Возвращает helpful=false, если ничего уверенно полезного нет (тогда skip). */
export async function judgeCapability(context: string, catalog: Array<{ id: string; name: string; desc: string }>, signal?: AbortSignal): Promise<CapabilityVerdict> {
  const none: CapabilityVerdict = { helpful: false, id: '', action: '', confidence: 0 }
  if (catalog.length === 0) return none
  const list = catalog.map(c => `- ${c.id}: ${c.name} — ${c.desc.slice(0, 80)}`).join('\n')
  const prompt = `You are a capability router for a coding agent. Current situation:\n${context.slice(0, 500)}\n\nAvailable capabilities:\n${list.slice(0, 1800)}\n\nPick the SINGLE capability that would concretely help RIGHT NOW, or none. Answer ONLY JSON:\n{"helpful":true,"id":"<id>","action":"<one concrete instruction>","confidence":0.0-1.0}\nIf nothing clearly helps, {"helpful":false,"id":"","action":"","confidence":0}. Be strict: only high-confidence, actionable matches.`
  try {
    const text = await enqueue(prompt, 'watcher', 150, undefined, signal)
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return none
    const p = JSON.parse(m[0]) as Partial<CapabilityVerdict>
    const id = String(p.id ?? '')
    const action = String(p.action ?? '')
    // Валидация качества: маленькие модели вместо «одной конкретной инструкции»
    // часто эхом повторяют имя тулa/скилла («edit_file») — это нулевая
    // информация, фильтруем на корню.
    const meaningful = action.length > 16 && action.toLowerCase() !== id.toLowerCase()
    return {
      helpful: p.helpful === true && id.length > 0 && meaningful,
      id, action, confidence: Number(p.confidence ?? 0),
    }
  } catch { return none }
}
