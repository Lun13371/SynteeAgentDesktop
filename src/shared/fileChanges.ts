// ── Изменённые файлы сообщения ───────────────────────────────────────────
//
// Собирает из tool-шагов сообщения список файлов, которые агент создал или
// отредактировал, чтобы UI мог показать их чипами в конце ответа (как чипы
// вложений [[attach:...]]).
//
// Источник данных — только шаги самого сообщения (iterations[].steps или
// toolSteps). Никакого main-side состояния и никакой миграции БД: diff уже
// лежит в персистентных шагах, поэтому карточка работает и на старых чатах.
//
// Логика вынесена из React-компонента, чтобы её можно было тестировать
// через `node --experimental-strip-types --test`.

import type { ToolStep } from './types/chat'

/** Тулы, которые реально пишут файлы на диск. Правки внутри execute_code
 *  тоже учитываются — они лежат в step.codeMode.trace (инструмент скрипта
 *  сам не эмитит tool_result-шаги, поэтому раньше терялись).
 *  run_command/PTY/MCP не отслеживаются: их правки не видны в diff. */
export const FILE_WRITE_TOOLS = ['edit_file', 'write_file'] as const
const WRITE_TOOLS = new Set<string>(FILE_WRITE_TOOLS)

type Args = Record<string, unknown>

/**
 * Аргументы вызова как объект.
 *
 * В трейсе execute_code они приходят СТРОКОЙ: Agent сериализует их через
 * sanitizeTrace (JSON.stringify + маскирование секретов), поэтому проверка
 * `typeof args === 'object'` отбрасывала их целиком — из-за этого правки
 * внутри скрипта не попадали ни в карточку, ни в сводку.
 */
export function asArgsObject(args: unknown): Args {
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Args : {}
    } catch { return {} }
  }
  if (args && typeof args === 'object' && !Array.isArray(args)) return args as Args
  return {}
}

function pickString(args: Args, keys: string[]): unknown {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Псевдо-diff правки из аргументов тула.
 *
 * Нужен там, где настоящего unified diff нет: записи трейса execute_code,
 * сохранённые до появления поля `diff` (карточка и сводка правок тогда
 * оставались пустыми). Для подсчёта +/− и показа «было/стало» этого хватает.
 */
export function synthesizeDiffFromArgs(toolName: string, args: Args | null | undefined): string | undefined {
  if (!args) return undefined
  const path = String(args.path ?? args.file_path ?? '')
  if (!path) return undefined

  const lines: string[] = []
  const push = (prefix: string, text: unknown, limit = 400): void => {
    if (typeof text !== 'string') return
    const all = text.split('\n')
    for (const line of all.slice(0, limit)) lines.push(prefix + line)
    if (all.length > limit) lines.push(`${prefix}… ещё ${all.length - limit} строк`)
  }

  let hunk = '@@'
  if (toolName === 'edit_file') {
    // Префиксы строго ASCII: diff размечается по startsWith('-')/'+'.
    const edits = Array.isArray(args.edits) ? args.edits as Args[] : null
    if (edits && edits.length > 0) {
      for (const edit of edits) {
        push('-', pickString(edit, ['old_str', 'old_string', 'old_text']))
        push('+', pickString(edit, ['new_str', 'new_string', 'new_text']))
      }
    } else {
      push('-', pickString(args, ['old_str', 'old_string', 'old_text']))
      push('+', pickString(args, ['new_str', 'new_string', 'new_text']))
    }
  } else if (toolName === 'write_file') {
    push('+', args.content, 500)
    // write_file пишет файл целиком — для сводки это «создан/перезаписан».
    hunk = '@@ -0,0 +1,1 @@'
  }

  if (lines.length === 0) return undefined
  return `--- a/${path}\n+++ b/${path}\n${hunk}\n${lines.join('\n')}`
}

export interface FileChangeEntry {
  /** Путь как его передал агент (обычно относительный от workdir). */
  path: string
  /** Кол-во добавленных строк по всем патчам этого файла за сообщение. */
  adds: number
  /** Кол-во удалённых строк по всем патчам этого файла за сообщение. */
  dels: number
  /** true — файла до этого не было (diff начинается с @@ -0,0). */
  created: boolean
  /** Unified-diff каждого успешного изменения (несколько правок = несколько
   *  патчей; строки вида «--- subsequent patch ---» добавляет склейка). */
  patches: string[]
}

export interface DiffStat {
  adds: number
  dels: number
  created: boolean
}

/**
 * Считает +/− по unified diff. Заголовки `---`/`+++`/`Index:` не считаются.
 * `created` = файл создан с нуля (hunk `@@ -0,0 +1,N @@`).
 */
export function countDiffLines(diff: string): DiffStat {
  let adds = 0
  let dels = 0
  let created = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('Index:')) continue
    if (line.startsWith('@@')) {
      if (/^@@ -0,0 /.test(line)) created = true
      continue
    }
    if (line.startsWith('+')) adds++
    else if (line.startsWith('-')) dels++
  }
  return { adds, dels, created }
}

/** Ключ для склейки путей: `C:\a\b.ts` и `c:/a/b.ts` — один файл. */
function pathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase()
}

/**
 * Собирает список изменённых/созданных файлов сообщения.
 *
 * Пара `tool_call` → `tool_result` матчится по `callId`: у `tool_result`
 * аргументов обычно нет (путь живёт в парном вызове), а при параллельных
 * тулах (Promise.all в Agent.ts) без callId файлы перепутались бы.
 * Упавшие вызовы (`success: false`, например «old_str not found») не
 * попадают в список — файл не изменён.
 */
export function collectFileChanges(steps: readonly ToolStep[] | undefined | null): FileChangeEntry[] {
  if (!steps || steps.length === 0) return []

  const calls = new Map<string, ToolStep>()
  for (const s of steps) {
    if (s.type === 'tool_call' && s.callId) calls.set(s.callId, s)
  }

  const byPath = new Map<string, FileChangeEntry>()

  const add = (path: string, diff: string | undefined): void => {
    const { adds, dels, created } = countDiffLines(diff ?? '')
    const key = pathKey(path)
    const prev = byPath.get(key)
    if (prev) {
      prev.adds += adds
      prev.dels += dels
      // Файл считается созданным, только если КАЖДОЕ изменение было созданием.
      prev.created = prev.created && created
      if (diff) prev.patches.push(diff)
    } else {
      byPath.set(key, { path, adds, dels, created, patches: diff ? [diff] : [] })
    }
  }

  // ── 1. Прямые вызовы тулов ──
  for (const s of steps) {
    if (s.type !== 'tool_result' || s.success !== true) continue
    const call = s.callId ? calls.get(s.callId) : undefined
    const name = s.toolName ?? call?.toolName ?? ''
    if (!WRITE_TOOLS.has(name)) continue

    const args = (call?.toolArgs ?? s.toolArgs ?? {}) as Record<string, unknown>
    const path = String(args.path ?? args.file_path ?? '').trim()
    if (!path) continue

    add(path, s.diff)
  }

  // ── 2. Вложенные вызовы внутри execute_code ──
  // Скрипт не эмитит собственных tool_result-шагов (лента «хода работы»
  // собирается из trace), поэтому правки из него раньше вообще не попадали
  // ни в карточку «Изменено N», ни в бейдж. Берём из трейса: diff, а если
  // запись старая и поля нет — собираем из аргументов вызова.
  for (const s of steps) {
    const trace = s.codeMode?.trace
    if (!trace || trace.length === 0) continue
    for (const entry of trace) {
      if (entry.status !== 'success') continue
      if (!WRITE_TOOLS.has(entry.name)) continue
      const args = asArgsObject(entry.args)
      const path = String(args.path ?? args.file_path ?? '').trim()
      if (!path) continue
      add(path, entry.diff ?? synthesizeDiffFromArgs(entry.name, args))
    }
  }

  return [...byPath.values()]
}

/** Суммарная статистика по списку файлов (для заголовка чипа-сводки). */
export function sumFileChanges(files: readonly FileChangeEntry[]): { adds: number; dels: number; created: number } {
  let adds = 0
  let dels = 0
  let created = 0
  for (const f of files) {
    adds += f.adds
    dels += f.dels
    if (f.created) created++
  }
  return { adds, dels, created }
}

/**
 * Путь для отображения: относительно workdir, если файл внутри него,
 * иначе — как передал агент. Разделители приводятся к `/`.
 */
export function displayFilePath(path: string, workdir?: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (!workdir) return normalized
  const base = workdir.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!base) return normalized
  if (normalized.toLowerCase().startsWith(base.toLowerCase() + '/')) {
    return normalized.slice(base.length + 1)
  }
  return normalized
}

/** Имя файла без директорий — для компактного чипа. */
export function fileBaseName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}
