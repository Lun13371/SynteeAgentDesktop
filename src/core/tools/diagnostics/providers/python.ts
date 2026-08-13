// ── Python провайдер: ruff → mypy → py_compile (каскадный fallback) ──

import { resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasAnyMarker, filterEntriesByFiles } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

const MARKERS = [
  'pyproject.toml', 'setup.py', 'setup.cfg',
  'requirements.txt', '.python-version', 'Pipfile', 'tox.ini',
]

// ruff JSON: [{ filename, location: { row, column }, code, message, fix }]
function parseRuffJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  try {
    const data = JSON.parse(stdout)
    for (const d of data) {
      entries.push({
        file: d.filename || '',
        line: d.location?.row ?? 0,
        col: d.location?.column,
        severity: 'error',
        message: `${d.code || ''}: ${d.message || ''}`.trim(),
        source: 'ruff',
      })
    }
  } catch { /* not JSON */ }
  return entries
}

// mypy: "file.py:12: error: Message  [error-code]"
const MYPY_RE = /^(.+?):(\d+):\s+(error|warning|note):\s+(.+?)(?:\s+\[(.+)\])?$/
function parseMypyOutput(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of stdout.split('\n')) {
    const m = line.match(MYPY_RE)
    if (!m) continue
    const [, file, lineNum, level, message, code] = m
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      severity: level === 'error' ? 'error' : 'warning',
      message: code ? `${code}: ${message}` : message,
      source: 'mypy',
    })
  }
  return entries
}

// py_compile: 'File "path", line N'  + stderr syntax error
const PY_COMPILE_RE = /File\s+"(.+?)",\s+line\s+(\d+)/
function parsePyCompileOutput(stderr: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  const lines = stderr.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(PY_COMPILE_RE)
    if (m) {
      // Ищем сообщение об ошибке на следующей строке
      let msg = ''
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const errMatch = lines[j].match(/^(?:SyntaxError|IndentationError|.*Error):\s*(.*)/)
        if (errMatch) { msg = errMatch[0]; break }
      }
      entries.push({
        file: m[1].trim(),
        line: Number(m[2]),
        severity: 'error',
        message: msg || 'Syntax error',
        source: 'py-compile',
      })
    }
  }
  return entries
}

export const pythonProvider: DiagnosticProvider = {
  name: 'python',

  detect(dir) {
    return hasAnyMarker(dir, MARKERS)
  },

  async run(dir, files?) {
    const fileArgs = files && files.length > 0
      ? ' ' + files.map((f) => `"${resolve(dir, f)}"`).join(' ')
      : ' .'

    // 1. Пробуем ruff (современный, быстрый)
    if (await isCommandAvailable('ruff --version')) {
      const cmd = `ruff check --output-format=json${fileArgs}`
      const res = await runDiagnosticCommand(cmd, dir)
      if (!res.failed) {
        const entries = parseRuffJson(res.stdout)
        return { entries }
      }
    }

    // 2. Пробуем mypy
    if (await isCommandAvailable('mypy --version')) {
      const cmd = files && files.length > 0
        ? `mypy ${files.map((f) => `"${resolve(dir, f)}"`).join(' ')} --no-error-summary`
        : 'mypy . --no-error-summary'
      const res = await runDiagnosticCommand(cmd, dir, 120_000)
      if (!res.failed) {
        let entries = parseMypyOutput(res.stdout + '\n' + res.stderr)
        if (files && files.length > 0) entries = filterEntriesByFiles(entries, dir, files)
        return { entries }
      }
    }

    // 3. Fallback: py_compile (только syntax, per-file)
    if (files && files.length > 0) {
      const entries: DiagnosticEntry[] = []
      for (const f of files) {
        const fp = resolve(dir, f)
        const res = await runDiagnosticCommand(`python -m py_compile "${fp}"`, dir, 30_000)
        if (res.stderr) {
          entries.push(...parsePyCompileOutput(res.stderr))
        }
      }
      return { entries, note: 'ruff/mypy not found — used py_compile (syntax check only)' }
    }

    // Нет files и нет ruff/mypy — не можем проверить весь проект через py_compile
    return {
      entries: [],
      note: 'ruff and mypy not installed — Python diagnostics skipped. Install ruff: pip install ruff',
    }
  },
}
