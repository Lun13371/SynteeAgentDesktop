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

/** Тулы, которые реально пишут файлы на диск. run_command/execute_code и
 *  MCP-тулы не отслеживаются: их правки не видны в diff-шагах. */
export const FILE_WRITE_TOOLS = ['edit_file', 'write_file'] as const
const WRITE_TOOLS = new Set<string>(FILE_WRITE_TOOLS)

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
  for (const s of steps) {
    if (s.type !== 'tool_result' || s.success !== true) continue
    const call = s.callId ? calls.get(s.callId) : undefined
    const name = s.toolName ?? call?.toolName ?? ''
    if (!WRITE_TOOLS.has(name)) continue

    const args = (call?.toolArgs ?? s.toolArgs ?? {}) as Record<string, unknown>
    const path = String(args.path ?? args.file_path ?? '').trim()
    if (!path) continue

    const { adds, dels, created } = countDiffLines(s.diff ?? '')
    const key = pathKey(path)
    const prev = byPath.get(key)
    if (prev) {
      prev.adds += adds
      prev.dels += dels
      // Файл считается созданным, только если КАЖДОЕ изменение было созданием.
      prev.created = prev.created && created
      if (s.diff) prev.patches.push(s.diff)
    } else {
      byPath.set(key, { path, adds, dels, created, patches: s.diff ? [s.diff] : [] })
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
