import { statSync } from 'fs'
import type { Message, ToolStep } from '../../shared/types'
import { JANITOR_MARKER } from '../../shared/assistants'
import { estimateTokens } from '../tokens/usageTracker'
import {
  summarizeToolResult, parseReadSections, rangesCover, normalizePath, stableStringify, toolCallDetail,
  PINNED_TOOLS, FILE_MUTATORS, UNKNOWN_MUTATORS, READ_TOOLS,
  STALE_MIN_CHARS, STALE_MIN_SAVED, MIN_STUB_CHARS,
  type ParsedReadSection,
} from './janitor'

/**
 * Персистентная компрессия истории (вариант B): детерминированное сжатие
 * tool-результатов ПРЯМО В БД на конце рана. Джанитор рана сжимает контекст
 * только в памяти — каждый новый запрос разворачивает сырые toolSteps из БД
 * заново (кольцо контекста осциллирует 130k → 280k). Здесь те же правила
 * применяются к сохранённым записям, и сжатие становится постоянным.
 *
 * Принципы точности:
 *  - Заменяется ТОЛЬКО content у tool_result (call+result пары сохраняются) —
 *    структура итераций остаётся валидной для провайдера, кэш UI не ломается.
 *  - Активный хвост = последние tailKeep ходов (assistant-сообщений с тулами)
 *    не трогаем; всё старее — сжимаем.
 *  - Перечитывания сворачиваются диапазонно: старое чтение гибнет, только
 *    если файл после него правился, изменился на диске (mtime) или его
 *    диапазон строк полностью перекрыт более поздними чтениями. Иначе —
 *    информативное резюме с точной атрибуцией: что именно прочитано и как.
 *  - Дедуп идентичных вызовов валиден, только если между ними не было мутаций.
 *  - Степы с визуалом (imagePaths/imageUrl), diff'ами, ошибками и pinned-тулы
 *    никогда не сжимаются. Анализ (покрытие/сталость) учитывает и хвостовые
 *    ходы — заменяется только история за хвостом.
 *  - Оригинал не сохраняется (по дизайну B: «лишнее зачем хранить») — резюме
 *    сохраняет пути, диапазоны строк и ошибки.
 */

export interface CompressOptions {
  /** Порог экономии для UPDATE строки сообщения (janitorMinSavingsTokens). */
  minSavingsTokens: number
  /** Сколько последних ходов (assistant-сообщений с тулами) не трогать. */
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

interface StepPair {
  msg: Message
  call: ToolStep
  result: ToolStep
  /** Глобальный хронологический номер пары (по всем ходам, включая хвост). */
  seq: number
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
      pairs.push({ msg: m, call: s, result, seq: 0 })
    }
  }
  return pairs
}

/** mtime файла по нормализованному пути; null — путь не прочитать (нет данных). */
function statMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
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
  const candidateMsgs = new Set(candidates)

  // Анализ — по всем ходам (чтения/правки в хвосте тоже перекрывают и
  // устаревают старую историю), замены — только для кандидатов.
  const allPairs = stepMessages.flatMap(collectPairs)
  allPairs.forEach((p, seq) => { p.seq = seq })
  if (allPairs.length === 0) return plans

  // Мутации: явные правки по путям + недетерминированные тулы.
  const editsByPath = new Map<string, number[]>()
  const unknownMutSeqs: number[] = []
  for (const p of allPairs) {
    const name = p.call.toolName ?? ''
    if (FILE_MUTATORS.has(name)) {
      const path = normalizePath(String((p.call.toolArgs as { path?: unknown } | undefined)?.path ?? ''))
      if (path) {
        const arr = editsByPath.get(path)
        if (arr) arr.push(p.seq)
        else editsByPath.set(path, [p.seq])
      }
    } else if (UNKNOWN_MUTATORS.has(name)) {
      unknownMutSeqs.push(p.seq)
    }
  }
  const editedAfter = (path: string, seq: number): boolean => (editsByPath.get(path) ?? []).some(s => s > seq)
  const unknownBetween = (a: number, b: number): boolean => unknownMutSeqs.some(s => s > a && s < b)
  const anyEditBetween = (a: number, b: number): boolean => {
    for (const arr of editsByPath.values()) {
      if (arr.some(s => s > a && s < b)) return true
    }
    return false
  }

  // mtime-кэш: файл реально менялся после чтения (внешне)? null — нет данных.
  const mtimeCache = new Map<string, number | null>()
  const fileChangedAfter = (path: string, tsMs: number): boolean | null => {
    let mtime = mtimeCache.get(path)
    if (mtime === undefined) {
      mtime = statMtime(path)
      mtimeCache.set(path, mtime)
    }
    if (mtime === null) return null
    // slop 3с — гранулярность mtime на FAT/сетевых дисках.
    return mtime > tsMs + 3000
  }

  // Замены: result-степ → финальный контент (с маркером).
  const replace = new Map<ToolStep, string>()
  const kindOf = new Map<ToolStep, 'dedup' | 'reread' | 'stale'>()
  const put = (p: StepPair, text: string, kind: 'dedup' | 'reread' | 'stale'): void => {
    if (replace.has(p.result)) return
    const finalText = `${JANITOR_MARKER} ${text}`
    const saved = estimateTokens(p.result.content ?? '') - estimateTokens(finalText)
    if (saved < STALE_MIN_SAVED) return
    replace.set(p.result, finalText)
    kindOf.set(p.result, kind)
  }

  // 1) Дедуп: тот же тул с теми же аргументами (не чтения/мутаторы/pinned).
  //    Свёртка валидна, только если между повторами не было мутаций — иначе
  //    результаты могли различаться и «идентичен» было бы ложью. Группа — по
  //    всем ходам (эталон может быть в хвосте), замена — только у кандидатов.
  const byFingerprint = new Map<string, StepPair[]>()
  for (const p of allPairs) {
    const name = p.call.toolName ?? ''
    if (!name || READ_TOOLS.has(name) || FILE_MUTATORS.has(name) || UNKNOWN_MUTATORS.has(name) || PINNED_TOOLS.has(name)) continue
    const key = `${name}|${stableStringify(p.call.toolArgs ?? {})}`
    const arr = byFingerprint.get(key)
    if (arr) arr.push(p)
    else byFingerprint.set(key, [p])
  }
  for (const arr of byFingerprint.values()) {
    arr.sort((a, b) => a.seq - b.seq)
    for (let k = 0; k < arr.length - 1; k++) {
      const a = arr[k]
      if (!candidateMsgs.has(a.msg)) continue
      const content = a.result.content ?? ''
      if (content.length < MIN_STUB_CHARS) continue
      if (anyEditBetween(a.seq, arr[k + 1].seq) || unknownBetween(a.seq, arr[k + 1].seq)) continue
      put(a, `Результат вызова ${a.call.toolName ?? 'tool'} с теми же аргументами уже есть ниже по истории (между вызовами мутаций не было) — свёрнуто локальным помощником.`, 'dedup')
    }
  }

  // 2) Перечитывания: диапазонная логика по parsed-секциям.
  interface ReadOcc { pair: StepPair; sections: ParsedReadSection[] }
  const readOccs: ReadOcc[] = []
  for (const p of allPairs) {
    const name = p.call.toolName ?? ''
    if (!READ_TOOLS.has(name)) continue
    readOccs.push({ pair: p, sections: parseReadSections(name, p.result.content ?? '') })
  }
  readOccs.sort((a, b) => a.pair.seq - b.pair.seq)
  for (let k = 0; k < readOccs.length; k++) {
    const occ = readOccs[k]
    if (!candidateMsgs.has(occ.pair.msg)) continue
    const ts = occ.pair.result.timestamp ?? 0
    const later = readOccs.slice(k + 1)
    const decisions = occ.sections.map(sec => {
      const laterRanges = later.flatMap(o => o.sections.filter(s => s.path === sec.path && s.range).map(s => s.range!))
      if (sec.range && laterRanges.length && rangesCover(sec.range, laterRanges)) return { sec, kind: 'covered' as const }
      if (editedAfter(sec.path, occ.pair.seq)) return { sec, kind: 'stale-edit' as const }
      if (fileChangedAfter(sec.path, ts) === true) return { sec, kind: 'stale-mtime' as const }
      return { sec, kind: 'keep' as const }
    })
    const allCovered = decisions.length > 0 && decisions.every(d => d.kind === 'covered')
    const hasStale = decisions.some(d => d.kind === 'stale-edit' || d.kind === 'stale-mtime')

    if (allCovered) {
      const list = decisions.map(d => `${d.sec.displayPath} (${d.sec.range ? `строки ${d.sec.range.from}-${d.sec.range.to}` : 'часть файла'}) — перекрыто свежим чтением ниже`).join('; ')
      put(occ.pair, `Результат чтения свёрнут: ${list}. При необходимости перечитай — свёртка не блокирует перечитывание.`, 'reread')
      continue
    }
    if (hasStale) {
      // B: активная правка (последняя правка файла — в хвосте, который не
      // сжимается) → чтение и есть живой срез файла: на его точные строки
      // агент опирается в следующих old_str. Не трогаем. Работа с файлом
      // остыла → свёртка (перечитывание после свёртки не блокируется).
      let lastEditSeq = -1
      for (const d of decisions) {
        for (const s of editsByPath.get(d.sec.path) ?? []) {
          if (s > occ.pair.seq && s > lastEditSeq) lastEditSeq = s
        }
      }
      if (lastEditSeq >= 0 && !candidateMsgs.has(allPairs[lastEditSeq].msg)) continue
      const list = decisions.map(d => `${d.sec.displayPath} (${d.sec.range ? `строки ${d.sec.range.from}-${d.sec.range.to}` : 'часть файла'}) — ${d.kind === 'stale-edit' ? 'устарело: файл правился после чтения' : 'устарело: файл изменялся после чтения'}`).join('; ')
      put(occ.pair, `Результат чтения свёрнут: ${list}. При необходимости перечитай — свёртка не блокирует перечитывание.`, 'reread')
      continue
    }
    // A: свежее чтение (файл не правился, mtime не менялся, не перекрыто) —
    // контент актуален на 100%, не сжимаем: агент опирается на него в правках.
  }

  // 3) Старьё: прочие большие результаты старых ходов → структурное резюме
  //    с атрибуцией. Результаты правок (diff) не трогаем — они несут
  //    уникальное состояние файлов.
  for (const p of allPairs) {
    if (replace.has(p.result) || !candidateMsgs.has(p.msg)) continue
    const name = p.call.toolName ?? ''
    if (PINNED_TOOLS.has(name) || FILE_MUTATORS.has(name) || READ_TOOLS.has(name)) continue
    const content = p.result.content ?? ''
    if (content.length < STALE_MIN_CHARS) continue
    const detail = toolCallDetail((p.call.toolArgs ?? {}) as Record<string, unknown>)
    put(p, summarizeToolResult(name, content, detail || undefined), 'stale')
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

    const counts: Record<string, number> = {}
    for (const s of msgReplacements) {
      const label = kindOf.get(s) === 'dedup' ? 'дедуп' : kindOf.get(s) === 'reread' ? 'перечитывания' : kindOf.get(s) === 'stale' ? 'резюме старья' : 'прочее'
      counts[label] = (counts[label] ?? 0) + 1
    }
    const actions = Object.entries(counts).map(([label, n]) => `${label} ×${n}`)

    plans.set(m.id, { messageId: m.id, savedTokens, actions, toolSteps: newSteps, iterations })
  }

  return plans
}
