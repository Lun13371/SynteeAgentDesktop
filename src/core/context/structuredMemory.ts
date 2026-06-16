/**
 * structuredMemory.ts — управление структурированной рабочей памятью агента.
 *
 * Формат хранения — markdown с чёткими секциями:
 *
 * ## Текущая задача
 * ## Изменённые файлы
 * ## Diff журнал
 * ## File Map
 * ## Архитектурные решения
 */

export interface DiffEntry {
  file: string
  summary: string  // краткое описание что изменилось
}

export interface FileMapEntry {
  reads: number
  writes: number
  note: string  // краткое описание файла
}

export interface StructuredMemoryUpdate {
  lastTask?: string
  modifiedFiles?: string[]
  diffEntries?: DiffEntry[]
  fileMap?: Map<string, FileMapEntry>
  architecturalNote?: string  // явно добавить архитектурное решение
}

const SECTION = {
  TASK: '## Текущая задача',
  FILES: '## Изменённые файлы',
  DIFF: '## Diff журнал',
  MAP: '## File Map',
  ARCH: '## Архитектурные решения',
}

const MAX_DIFF_ENTRIES = 20   // максимум записей в diff журнале
const MAX_FILE_MAP = 30       // максимум файлов в file map
const MAX_ARCH_ENTRIES = 10   // максимум архитектурных решений

// ─── Парсинг существующей памяти ──────────────────────────────────────────────

function parseSection(content: string, header: string): string {
  const lines = content.split('\n')
  const start = lines.findIndex(l => l.trim() === header)
  if (start === -1) return ''
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  const slice = end === -1 ? lines.slice(start + 1) : lines.slice(start + 1, end)
  return slice.join('\n').trim()
}

function parseDiffEntries(section: string): DiffEntry[] {
  const entries: DiffEntry[] = []
  for (const line of section.split('\n')) {
    const m = line.match(/^- `([^`]+)`: (.+)$/)
    if (m) entries.push({ file: m[1], summary: m[2] })
  }
  return entries
}

function parseFileMap(section: string): Map<string, FileMapEntry> {
  const map = new Map<string, FileMapEntry>()
  for (const line of section.split('\n')) {
    const m = line.match(/^- `([^`]+)` \[r:(\d+) w:(\d+)\](?: — (.+))?$/)
    if (m) {
      map.set(m[1], { reads: Number(m[2]), writes: Number(m[3]), note: m[4] ?? '' })
    }
  }
  return map
}

// ─── Сборка секций ────────────────────────────────────────────────────────────

function renderDiffEntries(entries: DiffEntry[]): string {
  return entries.map(e => `- \`${e.file}\`: ${e.summary}`).join('\n')
}

function renderFileMap(map: Map<string, FileMapEntry>): string {
  return Array.from(map.entries())
    .map(([f, e]) => `- \`${f}\` [r:${e.reads} w:${e.writes}]${e.note ? ` — ${e.note}` : ''}`)
    .join('\n')
}

// ─── Главная функция обновления ────────────────────────────────────────────────

export function updateStructuredMemory(existing: string, update: StructuredMemoryUpdate): string {
  console.log('[structuredMemory] updating — files:', update.modifiedFiles?.length ?? 0, 'diffs:', update.diffEntries?.length ?? 0)

  // Парсим существующие секции
  const existingDiff = parseDiffEntries(parseSection(existing, SECTION.DIFF))
  const existingMap = parseFileMap(parseSection(existing, SECTION.MAP))
  const existingArch = parseSection(existing, SECTION.ARCH)

  // ── Обновляем текущую задачу
  const task = update.lastTask
    ? update.lastTask.slice(0, 200)
    : parseSection(existing, SECTION.TASK)

  // ── Обновляем список изменённых файлов
  const existingFiles = parseSection(existing, SECTION.FILES)
    .split('\n').filter(l => l.startsWith('- `')).map(l => l.replace(/^- `|`.*$/g, ''))
  const allFiles = Array.from(new Set([...existingFiles, ...(update.modifiedFiles ?? [])]))
  const filesSection = allFiles.map(f => `- \`${f}\``).join('\n')

  // ── Обновляем diff журнал
  const newDiffs = update.diffEntries ?? []
  const mergedDiff = [...existingDiff, ...newDiffs].slice(-MAX_DIFF_ENTRIES)

  // ── Обновляем file map
  const mergedMap = new Map(existingMap)
  if (update.fileMap) {
    for (const [f, entry] of Array.from(update.fileMap.entries())) {
      const existing = mergedMap.get(f)
      if (existing) {
        mergedMap.set(f, {
          reads: existing.reads + entry.reads,
          writes: existing.writes + entry.writes,
          note: entry.note || existing.note,
        })
      } else {
        mergedMap.set(f, entry)
      }
    }
  }
  // Ограничиваем размер — оставляем самые активные файлы
  const sortedEntries = Array.from(mergedMap.entries())
    .sort((a, b) => (b[1].reads + b[1].writes * 2) - (a[1].reads + a[1].writes * 2))
    .slice(0, MAX_FILE_MAP)
  const sortedMap = new Map(sortedEntries)

  // ── Архитектурные решения — только append, не перезаписываем
  const archLines = existingArch.split('\n').filter(l => l.trim())
  if (update.architecturalNote) {
    const note = `- ${update.architecturalNote.slice(0, 150)}`
    if (!archLines.includes(note)) {
      archLines.push(note)
    }
  }
  const archSection = archLines.slice(-MAX_ARCH_ENTRIES).join('\n')

  // ── Собираем итоговую память
  const parts: string[] = []

  if (task) {
    parts.push(`${SECTION.TASK}\n${task}`)
  }
  if (allFiles.length > 0) {
    parts.push(`${SECTION.FILES}\n${filesSection}`)
  }
  if (mergedDiff.length > 0) {
    parts.push(`${SECTION.DIFF}\n${renderDiffEntries(mergedDiff)}`)
  }
  if (sortedMap.size > 0) {
    parts.push(`${SECTION.MAP}\n${renderFileMap(sortedMap)}`)
  }
  if (archSection) {
    parts.push(`${SECTION.ARCH}\n${archSection}`)
  }

  const result = parts.join('\n\n')
  console.log('[structuredMemory] built:', result.length, 'chars,', result.split('\n').length, 'lines')
  return result
}

/**
 * Добавить архитектурное решение напрямую (без полного обновления)
 */
export function appendArchitecturalNote(existing: string, note: string): string {
  return updateStructuredMemory(existing, { architecturalNote: note })
}
