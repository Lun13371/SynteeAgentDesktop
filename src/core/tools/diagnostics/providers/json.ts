// ── JSON провайдер: jsonlint → node JSON.parse (fallback) ──

import { resolve } from 'path'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasAnyMarker } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// Файлы которые исключаем из авто-детекта (они детектятся другими провайдерами)
const EXCLUDE_FILES = new Set([
  'package.json', 'package-lock.json', 'tsconfig.json',
  'jsconfig.json', 'composer.json', 'bower.json',
])

// jsonlint stderr: "file.json: line N, col M: message" или "Error: message"
const JSONLINT_RE = /^(.+?):\s*line\s+(\d+),\s*col\s+(\d+):\s*(.+)$/i
const JSONLINT_ERR_RE = /^(?:Error|error):\s*(.+)$/

function parseJsonlintOutput(output: string, fallbackFile: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(JSONLINT_RE)
    if (m) {
      const [, file, lineNum, col, message] = m
      entries.push({
        file: file.trim(),
        line: Number(lineNum),
        col: Number(col),
        severity: 'error',
        message: message.trim(),
        source: 'jsonlint',
      })
      continue
    }
    const e = line.match(JSONLINT_ERR_RE)
    if (e) {
      entries.push({
        file: fallbackFile,
        line: 0,
        severity: 'error',
        message: e[1].trim(),
        source: 'jsonlint',
      })
    }
  }
  return entries
}

// node JSON.parse stderr: "file:line:col" в SyntaxError:
// "<path>:line:col\n  ... \n  SyntaxError: Unexpected token ..."
function parseNodeJsonError(stderr: string, file: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  // Первая строка обычно содержит "<path>:line:col"
  const lines = stderr.split('\n')
  const locMatch = lines[0]?.match(/^(.+?):(\d+)(?::(\d+))?$/)
  // Извлекаем сообщение об ошибке
  let message = 'Invalid JSON'
  for (const l of lines) {
    const sm = l.match(/SyntaxError:\s*(.+)/)
    if (sm) { message = sm[1].trim(); break }
  }
  if (locMatch) {
    entries.push({
      file: locMatch[1].trim() || file,
      line: Number(locMatch[2]),
      col: locMatch[3] ? Number(locMatch[3]) : undefined,
      severity: 'error',
      message,
      source: 'node-json',
    })
  } else {
    // Если не нашли location — относим к переданному файлу
    entries.push({
      file,
      line: 0,
      severity: 'error',
      message,
      source: 'node-json',
    })
  }
  return entries
}

// Проверяет, есть ли jsonlint в devDependencies package.json
function hasJsonlintInDeps(dir: string): boolean {
  const pkgPath = resolve(dir, 'package.json')
  if (!existsSync(pkgPath)) return false
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    return !!(pkg.devDependencies?.jsonlint || pkg.dependencies?.jsonlint)
  } catch {
    return false
  }
}

// Считает "другие" .json файлы в корне (исключая стандартные)
function countOtherJsonFiles(dir: string): number {
  try {
    const files = readdirSync(dir)
    return files.filter((f) =>
      f.endsWith('.json') && !EXCLUDE_FILES.has(f) && !f.endsWith('-lock.json'),
    ).length
  } catch {
    return 0
  }
}

export const jsonProvider: DiagnosticProvider = {
  name: 'json',

  detect(dir) {
    // Явные маркеры
    if (hasAnyMarker(dir, ['.jsonlintrc', '.jsonlintrc.json', '.jsonlintrc.yml'])) return true
    // jsonlint в devDeps
    if (hasJsonlintInDeps(dir)) return true
    // Много .json файлов в корне (минимум 3, исключая package.json/lock/tsconfig)
    if (countOtherJsonFiles(dir) >= 3) return true
    return false
  },

  async run(dir, files?) {
    // Собираем target-файлы
    let targets = files && files.length > 0
      ? files.map((f) => resolve(dir, f))
      : []

    if (targets.length === 0) {
      try {
        targets = readdirSync(dir)
          .filter((f) =>
            f.endsWith('.json') && !EXCLUDE_FILES.has(f) && !f.endsWith('-lock.json'))
          .map((f) => resolve(dir, f))
      } catch { /* ignore */ }
    }

    if (targets.length === 0) {
      return { entries: [], note: 'no .json files found in project root' }
    }

    const entries: DiagnosticEntry[] = []

    // 1. npx jsonlint (file-level)
    if (await isCommandAvailable('npx jsonlint --version')) {
      const fileList = targets.map((f) => `"${f}"`).join(' ')
      const res = await runDiagnosticCommand(
        `npx jsonlint --quiet ${fileList}`,
        dir, 60_000,
      )
      if (!res.failed) {
        for (const f of targets) {
          entries.push(...parseJsonlintOutput(res.stderr || res.stdout, f))
        }
      }
      if (entries.length > 0) return { entries }
      if (!res.failed) return { entries }
    }

    // 2. Fallback: node JSON.parse per-file
    if (await isCommandAvailable('node --version')) {
      for (const f of targets) {
        // Экранируем обратные слэши и одинарные кавычки для inline-скрипта
        const safePath = String(f).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
        const cmd = `node -e "JSON.parse(require('fs').readFileSync('${safePath}','utf8'))"`
        const res = await runDiagnosticCommand(cmd, dir, 15_000)
        if (!res.failed && res.stderr) {
          entries.push(...parseNodeJsonError(res.stderr, f))
        }
      }
      if (entries.length > 0) {
        return { entries, note: 'jsonlint not found — used node JSON.parse (syntax check only)' }
      }
      return { entries }
    }

    if (entries.length === 0) {
      return {
        entries: [],
        note: 'jsonlint not installed — JSON diagnostics skipped. Install: npm install -g jsonlint',
      }
    }

    return { entries }
  },
}
