import type { ChatMessage } from './contextManager'
import { estimateTokens } from '../tokens/usageTracker'
import { JANITOR_MARKER, type JanitorAction, type JanitorActionKind, type JanitorReport, type AssistantsSettings } from '../../shared/assistants'

// ── Классификация тулов ──────────────────────────────────────────────────────
/** Тулы, чьи результаты — структурное состояние для агента: не трогаем. */
export const PINNED_TOOLS = new Set(['update_todo', 'update_working_memory', 'ask_user', 'request_access'])
/** Явные мутаторы файла: правка после чтения делает чтение устаревшим. */
export const FILE_MUTATORS = new Set(['edit_file', 'write_file'])
/** Недетерминированное влияние на диск: между дедуплицируемыми вызовами
 *  такого тула не должно быть — иначе «идентичные» результаты могли отличаться. */
export const UNKNOWN_MUTATORS = new Set(['run_command', 'execute_code'])
export const READ_TOOLS = new Set(['read_file', 'read_files'])

export const STALE_MIN_CHARS = 1200   // короче — резюме не дешевле
export const STALE_MIN_SAVED = 150    // замена должна окупиться
export const MIN_STUB_CHARS = 800     // дедуп/перечитывание коротких результатов — шум

// ── Разбор результатов чтения ────────────────────────────────────────────────
export interface ReadRange {
  from: number
  to: number
  total?: number
}

export interface ParsedReadSection {
  /** Нормализованный путь (lowercase, \). */
  path: string
  /** Путь как в заголовке результата. */
  displayPath: string
  range: ReadRange | null
}

export function normalizePath(p: string): string {
  return String(p).toLowerCase().replace(/\//g, '\\')
}

/**
 * Разбирает результат read_file/read_files на секции с путями и диапазонами
 * строк. Форматы (см. fileRead.ts):
 *  - `[File: path | Lines A-B of Z | full mode]`
 *  - `[File: path | Lines A-B of Z]`
 *  - `[File: path | Z lines]` (+ опц. `...[shown N of Z lines ...]`)
 *  - read_files: `=== path | Z lines ===` на секцию.
 */
export function parseReadSections(toolName: string, content: string): ParsedReadSection[] {
  if (toolName === 'read_file') {
    let m = content.match(/\[File: ([^\]|]+?)\s*\|\s*Lines (\d+)-(\d+) of (\d+)/)
    if (m) {
      return [{ path: normalizePath(m[1]), displayPath: m[1], range: { from: Number(m[2]), to: Number(m[3]), total: Number(m[4]) } }]
    }
    m = content.match(/\[File: ([^\]|]+?)\s*\|\s*(\d+) lines?\]/)
    if (m) {
      const total = Number(m[2])
      const shown = content.match(/\.\.\.\[shown (\d+) of (\d+) lines/)
      const to = shown ? Number(shown[1]) : total
      return [{ path: normalizePath(m[1]), displayPath: m[1], range: { from: 1, to, total } }]
    }
    return []
  }
  if (toolName === 'read_files') {
    const sections: ParsedReadSection[] = []
    const headerRe = /=== (.+?) \| (\d+) lines? ===/g
    const matches = [...content.matchAll(headerRe)]
    for (const m of matches) {
      const headerEnd = (m.index ?? 0) + m[0].length
      const body = content.slice(headerEnd)
      const total = Number(m[2])
      const shown = body.match(/\.\.\.\[shown (\d+) of (\d+) lines/)
      const numbered = body.match(/^\d+\|/gm)?.length ?? 0
      const to = shown ? Number(shown[1]) : (numbered || Math.min(total, 250))
      sections.push({ path: normalizePath(m[1]), displayPath: m[1], range: { from: 1, to, total } })
    }
    return sections
  }
  return []
}

/** Целевой диапазон полностью покрыт объединением более поздних диапазонов. */
export function rangesCover(target: ReadRange, later: ReadRange[]): boolean {
  const sorted = [...later].sort((a, b) => a.from - b.from)
  let cursor = target.from
  for (const r of sorted) {
    if (r.to < cursor) continue
    if (r.from > cursor) return false // дыра: старые строки нигде не перечитаны
    cursor = Math.max(cursor, r.to + 1)
    if (cursor > target.to) return true
  }
  return cursor > target.to
}

/** Стабильно канонизирует аргументы тула для фингерпринта (сортировка ключей). */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(x => stableStringify(x)).join(',') + ']'
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return '{' + entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(',') + '}'
  }
  return JSON.stringify(v)
}

function headTail(body: string, headLen = 160, tailLen = 80): string {
  const head = body.slice(0, headLen).replace(/\n/g, ' ')
  const tail = body.length > headLen + tailLen ? ` … ${body.slice(-tailLen).replace(/\n/g, ' ')}` : ''
  return `${head}${tail}`
}

/** Аргумент вызова для атрибуции в резюме: команда / паттерн / путь. */
export function toolCallDetail(args: Record<string, unknown> | null | undefined): string {
  if (!args) return ''
  for (const key of ['command', 'code', 'pattern', 'query', 'path']) {
    const v = args[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/**
 * Структурное резюме tool-результата с точной атрибуцией: сохраняет путь и
 * ДИАПАЗОН прочитанных строк, запрос поиска и топ-файлы, команду и ошибки.
 * `note` — вердикт о свежести («файл после чтения не менялся» и т.п.).
 * Используется и в ране (summarize_stale), и в персистентной компрессии БД.
 */
export function summarizeToolResult(toolName: string, content: string, detail?: string, note?: string): string {
  const lines = content.split('\n').length
  const notePart = note ? ` — ${note}` : ''

  if (toolName === 'read_file' || toolName === 'read_files') {
    const body = content.replace(/\[(?:Файл|File):[^\]]*\]/g, '').trim()
    const sections = parseReadSections(toolName, content)
    if (sections.length) {
      const list = sections.slice(0, 4).map(s => {
        const r = s.range
        return `${s.displayPath}${r ? `, строки ${r.from}-${r.to}${r.total ? ` из ${r.total}` : ''}` : ''}`
      }).join('; ')
      const more = sections.length > 4 ? ` +${sections.length - 4}` : ''
      return `[read] ${list}${more}${notePart}: ${headTail(body)}`
    }
    return `[read] ${detail ?? '?'} (${lines} строк)${notePart}: ${headTail(body)}`
  }
  if (toolName === 'search_code' || toolName === 'find_files') {
    const header = content.match(/\[(?:search_code|find_files): ([^\]]+)\]/)?.[1]
    const files = [...content.matchAll(/^● (.+?)$/gm)].map(m => m[1].trim()).slice(0, 5)
    const detailPart = detail ? `«${detail.slice(0, 80)}»` : ''
    if (header || files.length) {
      const filesPart = files.length ? `: ${files.join(', ')}` : ''
      return `[search] ${detailPart}${header ? ` — ${header}` : ''}${filesPart}${notePart}. Повтори поиск при необходимости.`.replace('  ', ' ')
    }
    return `[search] ${detailPart} ${content.length} симв, ${lines} строк${notePart}: ${headTail(content)}`
  }
  if (toolName === 'run_command' || toolName === 'execute_code') {
    const errLines = content.split('\n').filter(l => /error|failed|exception|не найден|not found/i.test(l)).slice(0, 3)
    const tail = content.slice(-200).replace(/\n/g, ' ').trim()
    const cmdPart = detail ? `${detail.slice(0, 120)} — ` : ''
    const errPart = errLines.length ? ` ошибки: ${errLines.join(' | ').slice(0, 200)};` : ''
    return `[cmd] ${cmdPart}${lines} строк вывода;${errPart} хвост: ${tail}`
  }
  if (toolName === 'edit_file' || toolName === 'write_file') {
    const fileMatch = content.match(/([^\s]+\.[a-z]+)/i)
    return `[${toolName}] ${fileMatch?.[1] ?? detail ?? '?'} (${content.length} симв)${notePart}`
  }
  const namePart = detail ? `${detail.slice(0, 80)} — ` : ''
  return `[${toolName}] ${namePart}${content.length} симв, ${lines} строк: ${headTail(content, 150, 0)}…`
}

/** Граница «активного хвоста»: индекс последнего из N ходов (assistant-сообщений
 *  с тулами). Всё с этим индексом и позже джанитор не трогает. Если ходов
 *  меньше N — возвращает 0 (заморожена вся история). */
export function computeTailBoundary(messages: ChatMessage[], tailSteps: number): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && m.tool_calls?.length) {
      count++
      if (count >= tailSteps) return i
    }
  }
  return 0
}

export interface JanitorArchiveEntry {
  id: string
  originalMessages: ChatMessage[]
  summary: string
  ts: number
}

/**
 * Джанитор рана: сжимает контекст в памяти. Принципы точности:
 *  - Активный хвост = последние janitorTailSteps ходов — не трогаем вовсе.
 *  - Заменяется ТОЛЬКО content у tool-результатов (парные tool_call остаются):
 *    структура сообщений валидна для провайдера, кэш инвалидируется минимально.
 *  - Свёрнутые сообщения помечаются janitorCollapsed: rereadGuard не считает
 *    их «контентом в контексте» — перечитывание после свёртки не блокируется.
 *  - Свежие чтения (файл не правился, не перекрыт) не трогаем: контент
 *    актуален, агент опирается на него в следующих правках (old_str).
 *  - Чтения с активной правкой (последняя правка файла — в активном хвосте)
 *    не трогаем: это живой срез файла для продолжающейся работы.
 *  - Перечитывания сворачиваются диапазонно: covered-правило; устаревшие
 *    чтения с завершённой работой сворачиваются с подсказкой перечитать.
 *  - Дедуп идентичных вызовов валиден, только если между ними не было мутаций.
 *  - Результаты правок (diff) и визуала никогда не сжимаются.
 */
export class Janitor {
  private archive = new Map<string, JanitorArchiveEntry>()
  private archiveCounter = 0
  private lastScanRound = 0
  private settings: AssistantsSettings

  constructor(settings: AssistantsSettings) {
    this.settings = settings
  }

  updateSettings(settings: AssistantsSettings): void {
    this.settings = settings
  }

  shouldScan(currentRound: number): boolean {
    if (!this.settings.enabled || !this.settings.janitorEnabled) return false
    return currentRound - this.lastScanRound >= this.settings.janitorScanInterval
  }

  scan(messages: ChatMessage[], currentRound: number, mode: 'light' | 'deep' = 'deep', tailStepsOverride?: number): JanitorReport {
    const start = Date.now()
    this.lastScanRound = currentRound
    const total = messages.length
    // tailStepsOverride — emergency-режим economist'а (stage 2): активный хвост
    // режется вдвое, при реальном давлении на окно свежесть хвоста дешевле
    // переполнения контекста. Emergency также разрешает сжимать свежие чтения.
    const emergency = tailStepsOverride !== undefined
    const boundary = computeTailBoundary(messages, Math.max(1, tailStepsOverride ?? this.settings.janitorTailSteps ?? 10))

    // callId → аргументы; callId → индекс tool-сообщения. Анализ — по всей
    // истории (чтения в хвосте тоже перекрывают старые), замены — только
    // за границей хвоста.
    interface CallInfo { name: string; args: Record<string, unknown> | null }
    const callInfo = new Map<string, CallInfo>()
    const resultIndex = new Map<string, number>()
    const mutationIdxs: number[] = []
    const editsByPath = new Map<string, number[]>()
    const unknownMutIdxs: number[] = []
    for (let i = 0; i < total; i++) {
      const msg = messages[i]
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          let args: Record<string, unknown> | null = null
          try { args = JSON.parse(tc.function?.arguments ?? '{}') } catch { args = null }
          callInfo.set(tc.id, { name: tc.function?.name ?? '', args })
        }
      } else if (msg.role === 'tool' && msg.tool_call_id) {
        resultIndex.set(msg.tool_call_id, i)
        const info = callInfo.get(msg.tool_call_id)
        if (info) {
          if (FILE_MUTATORS.has(info.name)) {
            const p = normalizePath(String(info.args?.path ?? ''))
            if (p) {
              const arr = editsByPath.get(p)
              if (arr) arr.push(i)
              else editsByPath.set(p, [i])
            }
            mutationIdxs.push(i)
          } else if (UNKNOWN_MUTATORS.has(info.name)) {
            unknownMutIdxs.push(i)
            mutationIdxs.push(i)
          }
        }
      }
    }

    const editedAfter = (path: string, idx: number): boolean => (editsByPath.get(path) ?? []).some(mi => mi > idx)
    const unknownAfter = (idx: number): boolean => unknownMutIdxs.some(mi => mi > idx)
    const hasMutationBetween = (a: number, b: number): boolean => mutationIdxs.some(mi => mi > a && mi < b)

    const contentOf = (i: number): string => {
      const c = messages[i]?.content
      return typeof c === 'string' ? c : ''
    }
    const frozen = (idx: number): boolean => idx >= boundary
    const skippable = (idx: number): boolean => frozen(idx) || contentOf(idx).includes(JANITOR_MARKER) || (messages[idx]?.imagePaths?.length ?? 0) > 0

    // Замены: индекс tool-сообщения → финальный контент (с маркером).
    const replacements = new Map<number, string>()
    const reasons = new Map<number, { kind: JanitorActionKind; what: string; saved: number }>()
    const archiveIdByIndex = new Map<number, string>()

    const put = (idx: number, text: string, kind: JanitorActionKind, what: string): void => {
      if (replacements.has(idx)) return
      const content = contentOf(idx)
      let finalText = `${JANITOR_MARKER} ${text}`
      if (kind === 'summarize_stale') {
        const archiveId = `jan-${++this.archiveCounter}-${Date.now()}`
        this.archive.set(archiveId, { id: archiveId, originalMessages: [{ ...messages[idx] }], summary: text, ts: Date.now() })
        archiveIdByIndex.set(idx, archiveId)
        finalText += ` [recall:${archiveId}]`
      }
      const saved = estimateTokens(content) - estimateTokens(finalText)
      if (saved < STALE_MIN_SAVED) return
      replacements.set(idx, finalText)
      reasons.set(idx, { kind, what, saved })
    }

    // 1) Дедуп: тот же тул с теми же аргументами. Не для чтений (их ведёт
    //    диапазонная логика ниже), не для мутаторов/pinned-тулов. Свёртка
    //    валидна, только если между повторами не было мутаций — иначе
    //    результаты могли различаться и «идентичен» было бы ложью.
    const byFingerprint = new Map<string, Array<{ name: string; idx: number }>>()
    for (const [callId, info] of callInfo) {
      if (!info.name || READ_TOOLS.has(info.name)) continue
      if (FILE_MUTATORS.has(info.name) || UNKNOWN_MUTATORS.has(info.name) || PINNED_TOOLS.has(info.name)) continue
      const ri = resultIndex.get(callId)
      if (ri === undefined || skippable(ri)) continue
      const key = `${info.name}|${stableStringify(info.args ?? {})}`
      const arr = byFingerprint.get(key)
      if (arr) arr.push({ name: info.name, idx: ri })
      else byFingerprint.set(key, [{ name: info.name, idx: ri }])
    }
    for (const arr of byFingerprint.values()) {
      arr.sort((x, y) => x.idx - y.idx)
      for (let k = 0; k < arr.length - 1; k++) {
        const a = arr[k]
        const content = contentOf(a.idx)
        if (content.length < MIN_STUB_CHARS) continue
        if (hasMutationBetween(a.idx, arr[k + 1].idx)) continue
        put(a.idx, `Результат вызова ${a.name} с теми же аргументами уже есть ниже по истории (между вызовами мутаций не было) — свёрнуто локальным помощником.`, 'dedup_tool_call', `${a.name}: дубликат аргументов`)
      }
    }

    // 2) Перечитывания: диапазонная логика. Чтение сворачивается, только если
    //    (а) файл после него правился — чтение устарело, или (б) его диапазон
    //    строк полностью перекрыт более поздними чтениями того же файла.
    //    Иначе — информативное резюме: точно что прочитано и как.
    //    Анализ — по всей истории (чтение в хвосте тоже перекрывает старое),
    //    замена — только за границей хвоста.
    interface ReadOcc { idx: number; frozen: boolean; sections: ParsedReadSection[] }
    const readOccs: ReadOcc[] = []
    for (const [callId, info] of callInfo) {
      if (!READ_TOOLS.has(info.name)) continue
      const ri = resultIndex.get(callId)
      if (ri === undefined || contentOf(ri).includes(JANITOR_MARKER) || (messages[ri]?.imagePaths?.length ?? 0) > 0) continue
      readOccs.push({ idx: ri, frozen: frozen(ri), sections: parseReadSections(info.name, contentOf(ri)) })
    }
    readOccs.sort((x, y) => x.idx - y.idx)
    for (let k = 0; k < readOccs.length; k++) {
      const occ = readOccs[k]
      if (occ.frozen || replacements.has(occ.idx)) continue
      const content = contentOf(occ.idx)
      const later = readOccs.slice(k + 1)
      const decisions = occ.sections.map(sec => {
        const laterRanges = later.flatMap(o => o.sections.filter(s => s.path === sec.path && s.range).map(s => s.range!))
        if (sec.range && laterRanges.length && rangesCover(sec.range, laterRanges)) return { sec, kind: 'covered' as const }
        if (editedAfter(sec.path, occ.idx)) return { sec, kind: 'stale-edit' as const }
        return { sec, kind: 'keep' as const }
      })
      const allCovered = decisions.length > 0 && decisions.every(d => d.kind === 'covered')
      const hasStale = decisions.some(d => d.kind === 'stale-edit')

      if (allCovered) {
        const list = decisions.map(d => `${d.sec.displayPath} (${d.sec.range ? `строки ${d.sec.range.from}-${d.sec.range.to}` : 'часть файла'}) — перекрыто свежим чтением ниже`).join('; ')
        put(occ.idx, `Результат чтения свёрнут: ${list}. При необходимости перечитай — свёртка не блокирует перечитывание.`, 'collapse_reread', 'перечитывание свёрнуто')
        continue
      }

      if (hasStale) {
        // B: правки по файлу продолжаются СЕЙЧАС (последняя — в активном хвосте)
        // → чтение и есть живой срез файла, патчить/сжимать нельзя: на его
        // точные строки агент опирается в следующих old_str. Работа с файлом
        // ушла в историю → свёртка; точный контент агент доберёт перечитыванием
        // (rereadGuard свёрнутое «контентом» не считает — см. hasReadInContext).
        let lastEditIdx = -1
        for (const d of decisions) {
          for (const ei of editsByPath.get(d.sec.path) ?? []) {
            if (ei > occ.idx && ei > lastEditIdx) lastEditIdx = ei
          }
        }
        if (lastEditIdx >= boundary) continue // активная правка — не трогаем
        const list = decisions.map(d => `${d.sec.displayPath} (${d.sec.range ? `строки ${d.sec.range.from}-${d.sec.range.to}` : 'часть файла'}) — устарело: файл правился после чтения`).join('; ')
        put(occ.idx, `Результат чтения свёрнут: ${list}. При необходимости перечитай — свёртка не блокирует перечитывание.`, 'collapse_reread', 'чтение устарело, работа с файлом завершена')
        continue
      }

      // A: свежее чтение (файл не правился, не перекрыто) — контент актуален
      // на 100%, не трогаем вовсе. Сжимаем только в emergency-скане
      // (economist stage 2): под реальным давлением экономика важнее.
      if (emergency && mode === 'deep' && content.length >= STALE_MIN_CHARS) {
        const note = unknownAfter(occ.idx)
          ? 'после чтения выполнялись команды — файл мог измениться'
          : 'правок файла после чтения в истории нет, при необходимости перечитай с нужным offset'
        put(occ.idx, summarizeToolResult('read_file', content, undefined, note), 'summarize_stale', `чтение → резюме (emergency)`)
      }
    }

    // 3) Старьё: прочие большие результаты старых сообщений → структурное
    //    резюме с атрибуцией. Результаты правок (diff) не трогаем — они
    //    несут уникальное состояние файлов.
    if (mode === 'deep') {
      for (let i = 0; i < boundary; i++) {
        if (replacements.has(i)) continue
        const msg = messages[i]
        if (msg.role !== 'tool' || !msg.tool_call_id) continue
        if (skippable(i)) continue
        const info = callInfo.get(msg.tool_call_id)
        if (!info) continue
        if (PINNED_TOOLS.has(info.name) || FILE_MUTATORS.has(info.name) || READ_TOOLS.has(info.name)) continue
        const content = contentOf(i)
        if (content.length < STALE_MIN_CHARS) continue
        const detail = toolCallDetail(info.args)
        put(i, summarizeToolResult(info.name, content, detail || undefined), 'summarize_stale', `[${info.name}] ${content.length} симв → резюме`)
      }
    }

    if (replacements.size === 0) {
      return { actions: [], totalTokensSaved: 0, scannedMessages: total, durationMs: Date.now() - start }
    }

    // Отчёт: по одному действию на каждую замену — описание честно говорит,
    // что именно свёрнуто и почему (UI рендерит их списком в карточке).
    const actions: JanitorAction[] = []
    for (const [idx, finalText] of replacements) {
      const { kind, what, saved } = reasons.get(idx)!
      actions.push({
        kind,
        messageIndices: [idx],
        description: `${what} (−${saved} ток.)`,
        tokensSaved: saved,
        replacement: finalText,
        ...(kind === 'summarize_stale' ? { archiveId: archiveIdByIndex.get(idx) } : {}),
      })
    }
    const totalTokensSaved = actions.reduce((s, a) => s + a.tokensSaved, 0)
    return { actions, totalTokensSaved, scannedMessages: total, durationMs: Date.now() - start }
  }

  apply(messages: ChatMessage[], report: JanitorReport): ChatMessage[] {
    if (report.actions.length === 0) return messages
    const result = [...messages]
    for (const action of report.actions) {
      for (const idx of action.messageIndices) {
        const msg = result[idx]
        if (!msg || msg.role !== 'tool' || typeof msg.content !== 'string') continue
        const text = action.replacement ?? `${JANITOR_MARKER} ${action.description}`
        result[idx] = { ...msg, content: text, janitorCollapsed: true }
      }
    }
    return result
  }

  recall(archiveId: string): ChatMessage[] | null {
    return this.archive.get(archiveId)?.originalMessages ?? null
  }

  getArchiveSize(): number {
    return this.archive.size
  }

  /** Снимок архива для персиста (recorder пишет per chat — worker живёт
   *  один запрос, без этого [recall:id] в истории БД теряют источник). */
  getArchiveEntries(): JanitorArchiveEntry[] {
    return [...this.archive.values()]
  }

  /** Восстановление архива из персиста. Дедуп по id, счётчик jan-N
   *  отводится дальше восстановленных, чтобы новые id не пересекались. */
  hydrateArchive(entries: JanitorArchiveEntry[]): void {
    for (const e of entries ?? []) {
      if (!e?.id || this.archive.has(e.id)) continue
      this.archive.set(e.id, e)
      const m = /^jan-(\d+)-/.exec(e.id)
      if (m) this.archiveCounter = Math.max(this.archiveCounter, Number(m[1]))
    }
  }

  pruneArchive(maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs
    for (const [id, entry] of this.archive) {
      if (entry.ts < cutoff) this.archive.delete(id)
    }
  }
}
