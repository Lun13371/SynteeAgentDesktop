// ── Общие утилиты для провайдеров диагностики ──

import { resolve } from 'path'
import { existsSync, readdirSync } from 'fs'
import type { DiagnosticEntry } from '../types'

/**
 * Фильтрует entries по списку файлов (нормализованное сравнение путей).
 * Используется project-level провайдерами (tsc, cargo, go vet, ...) когда
 * caller передал конкретные files.
 */
export function filterEntriesByFiles(
  entries: DiagnosticEntry[],
  dir: string,
  files: string[],
): DiagnosticEntry[] {
  const resolvedFiles = new Set(files.map((f) => resolve(dir, f)))
  return entries.filter((e) => {
    const entryPath = resolve(dir, e.file)
    return resolvedFiles.has(entryPath)
  })
}

/**
 * Проверяет, есть ли в директории файл с заданным расширением (нерекурсивно,
 * только корень). Используется detect() для провайдеров где маркер — не один
 * конкретный файл, а любой файл с расширением (например *.csproj, *.sln).
 */
export function hasFileWithExt(dir: string, ext: string): boolean {
  try {
    return readdirSync(dir).some((f) => f.endsWith(ext))
  } catch {
    return false
  }
}

/**
 * Проверяет, есть ли в директории файл, matching хотя бы одному glob-паттерну
 * (простая проверка по расширению, нерекурсивно).
 */
export function hasFileMatching(dir: string, patterns: string[]): boolean {
  try {
    const files = readdirSync(dir)
    return files.some((f) => patterns.some((p) => f.endsWith(p) || f === p))
  } catch {
    return false
  }
}

/**
 * Проверяет существование любого из файлов-маркеров в директории.
 */
export function hasAnyMarker(dir: string, markers: string[]): boolean {
  return markers.some((m) => existsSync(resolve(dir, m)))
}

/**
 * Парсит вывод в формате "file:line:col: severity: message" или
 * "file:line: severity: message" — общий для многих линтеров (gcc, go vet,
 * rubocop text, и т.д.).
 */
export function parseColonFormat(
  output: string,
  source: string,
  severityMap?: (s: string) => 'error' | 'warning',
): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  // file:line:col: ... или file(line,col): ...
  const RE_3 = /^(.+?):(\d+):(\d+):\s*(.+)$/
  const RE_2 = /^(.+?):(\d+):\s*(.+)$/
  for (const line of output.split('\n')) {
    let m = line.match(RE_3)
    if (m) {
      const [, file, lineNum, col, rest] = m
      const { severity, message } = parseSeverityAndMessage(rest, severityMap)
      entries.push({
        file: file.trim(),
        line: Number(lineNum),
        col: Number(col),
        severity,
        message: message.trim(),
        source,
      })
      continue
    }
    m = line.match(RE_2)
    if (m) {
      const [, file, lineNum, rest] = m
      const { severity, message } = parseSeverityAndMessage(rest, severityMap)
      entries.push({
        file: file.trim(),
        line: Number(lineNum),
        severity,
        message: message.trim(),
        source,
      })
    }
  }
  return entries
}

function parseSeverityAndMessage(
  rest: string,
  severityMap?: (s: string) => 'error' | 'warning',
): { severity: 'error' | 'warning'; message: string } {
  const lower = rest.toLowerCase()
  if (lower.startsWith('error:') || lower.startsWith('error ')) {
    return { severity: 'error', message: rest.replace(/^error[:\s]+/i, '') }
  }
  if (lower.startsWith('warning:') || lower.startsWith('warning ')) {
    return { severity: 'warning', message: rest.replace(/^warning[:\s]+/i, '') }
  }
  if (lower.startsWith('note:') || lower.startsWith('note ')) {
    return { severity: 'warning', message: rest.replace(/^note[:\s]+/i, '') }
  }
  if (severityMap) {
    return { severity: severityMap(rest), message: rest }
  }
  // По умолчанию считаем ошибкой
  return { severity: 'error', message: rest }
}
