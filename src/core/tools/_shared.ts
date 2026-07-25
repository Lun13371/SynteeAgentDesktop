import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { mkdir as fsMkdir, open as fsOpen } from 'fs/promises'
import { dirname, resolve as pathResolve } from 'path'
import * as Diff from 'diff'

export const execAsync = promisify(exec)
export const execFileAsync = promisify(execFile)

// Единый список игнорируемых директорий для list_directory/find_files/search_code/analyze_project
export const DEFAULT_IGNORE_DIRS = ['node_modules', 'dist', 'out', '.git', '__pycache__', '.venv', 'build', '.next', 'coverage']

// Нормализация CRLF→LF (используется в edit_file/applySearchReplacePatch)
export function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, '\n')
}

// Создаёт родительскую директорию для файла, если её нет
export async function ensureDirFor(filePath: string): Promise<void> {
  const dir = dirname(filePath)
  if (!existsSync(dir)) await fsMkdir(dir, { recursive: true })
}

// Подсчёт изменённых строк в unified diff
export function countChangedLines(diff: string): number {
  return diff.split('\n').filter((l: string) => l.startsWith('+') || l.startsWith('-')).length
}

// Детекция бинарного файла: проверяем первые 8KB на наличие null-байтов.
// Если есть — файл бинарный, текстовое чтение бессмысленно.
// Используем FileHandle API правильно: fsOpen возвращает FileHandle,
// у которого есть методы .read() и .close() — а не fsPromises.close(fd),
// которого в некоторых версиях Node нет (отсюда "promises.close is not a function").
export async function isBinaryFile(filePath: string): Promise<boolean> {
  let handle: { read: (buf: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>; close: () => Promise<void> } | undefined
  try {
    handle = await fsOpen(filePath, 'r') as unknown as { read: (buf: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>; close: () => Promise<void> }
    const buf = Buffer.alloc(8192)
    const { bytesRead } = await handle.read(buf, 0, 8192, 0)
    return buf.slice(0, bytesRead).includes(0)
  } catch {
    return false  // если не можем открыть — пусть чтение выдаст свою ошибку
  } finally {
    if (handle) await handle.close()
  }
}

// Единая резолюция путей: относительные пути резолвятся через workdir
// (если задан) или process.cwd() (для обратной совместимости — старые чаты
// без workdir, Work-режим, вызовы вне контекста чата), абсолютные остаются как есть.
// Применяется во всех файловых тулах для единообразия.
export function resolveToolPath(p: string, workdir?: string): string {
  return pathResolve(workdir ?? process.cwd(), p)
}

// Умная обрезка вывода команды — показываем начало (контекст) и конец (результат/ошибки)
export function smartTrimOutput(text: string, maxChars = 4000): string {
  if (!text || text.length <= maxChars) return text
  const head = 800   // начало — контекст команды
  const tail = 2000  // конец — результат и ошибки (самое важное)
  const removed = text.length - head - tail
  return `${text.slice(0, head)}\n\n...[обрезано ${removed} символов, показано начало и конец]...\n\n${text.slice(-tail)}`
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + 'B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB'
  return (bytes / 1024 / 1024).toFixed(1) + 'MB'
}

// Генерирует unified diff через npm diff (LCS-based, как git)
export function makeDiff(oldContent: string, newContent: string, filePath: string): string {
  const patch = Diff.createPatch(filePath, oldContent, newContent, '', '', { context: 3 })
  // Убираем заголовок "Index: ...\n======\n" — оставляем только с --- строки
  const lines = patch.split('\n')
  const start = lines.findIndex(l => l.startsWith('---'))
  return start >= 0 ? lines.slice(start).join('\n') : patch
}

export interface ToolResult {
  success: boolean
  output: string
  error?: string
  diff?: string
  hidden?: boolean  // скрытые тулы (think, update_working_memory) — не показываются в UI
  originalContent?: string | null  // §1.8 — для undo/rollback: содержимое до записи; null = файл был создан
}
