// ── TOML провайдер: taplo → tomlcheck → python tomllib ──

import { resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasAnyMarker, hasFileMatching } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

const CONFIG_MARKERS = ['.taplo.toml', 'taplo.toml']

// taplo check text output: "file.toml:line:col: message" или "Error: message (at line N)"
const TAPLO_RE = /^(.+?):(\d+):(\d+):\s*(.+)$/
const TAPLO_ERR_RE = /(?:Error|error):\s*(.+?)(?:\s+\(at\s+line\s+(\d+)\))?$/
function parseTaploOutput(output: string, fallbackFile: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(TAPLO_RE)
    if (m) {
      const [, file, lineNum, col, message] = m
      entries.push({
        file: file.trim(),
        line: Number(lineNum),
        col: Number(col),
        severity: 'error',
        message: message.trim(),
        source: 'taplo',
      })
      continue
    }
    const e = line.match(TAPLO_ERR_RE)
    if (e) {
      entries.push({
        file: fallbackFile,
        line: e[2] ? Number(e[2]) : 0,
        severity: 'error',
        message: e[1].trim(),
        source: 'taplo',
      })
    }
  }
  return entries
}

// tomlcheck stderr: "file.toml:line:col: message" или "Error: message at line N"
function parseTomlcheckOutput(stderr: string, fallbackFile: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of stderr.split('\n')) {
    const m = line.match(TAPLO_RE)
    if (m) {
      const [, file, lineNum, col, message] = m
      entries.push({
        file: file.trim(),
        line: Number(lineNum),
        col: Number(col),
        severity: 'error',
        message: message.trim(),
        source: 'tomlcheck',
      })
      continue
    }
    const e = line.match(/(?:Error|error):\s*(.+?)(?:\s+at\s+line\s+(\d+))?$/i)
    if (e) {
      entries.push({
        file: fallbackFile,
        line: e[2] ? Number(e[2]) : 0,
        severity: 'error',
        message: e[1].trim(),
        source: 'tomlcheck',
      })
    }
  }
  return entries
}

// python tomllib: "tomllib.TOMLDecodeError: message (at line N, column C)"
function parseTomllibOutput(stderr: string, file: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of stderr.split('\n')) {
    const m = line.match(/TOMLDecodeError:\s*(.+?)(?:\s*\(at\s+line\s+(\d+)(?:,\s+column\s+(\d+))?\))?\s*$/i)
    if (m) {
      entries.push({
        file,
        line: m[2] ? Number(m[2]) : 0,
        col: m[3] ? Number(m[3]) : undefined,
        severity: 'error',
        message: m[1].trim(),
        source: 'python-tomllib',
      })
    }
  }
  return entries
}

export const tomlProvider: DiagnosticProvider = {
  name: 'toml',

  detect(dir) {
    // Cargo.toml/pyproject.toml детектятся Rust/Python, но TOML-провайдер
    // тоже срабатывает на любые .toml в корне (порядок регистрации решит).
    return hasFileMatching(dir, ['.toml']) ||
      hasAnyMarker(dir, CONFIG_MARKERS)
  },

  async run(dir, files?) {
    // Собираем target-файлы
    let targets = files && files.length > 0
      ? files.map((f) => resolve(dir, f))
      : []

    if (targets.length === 0) {
      try {
        const { readdirSync } = await import('fs')
        targets = readdirSync(dir)
          .filter((f: string) => f.endsWith('.toml'))
          .map((f: string) => resolve(dir, f))
      } catch { /* ignore */ }
    }

    if (targets.length === 0) {
      return { entries: [], note: 'no .toml files found in project root' }
    }

    const entries: DiagnosticEntry[] = []

    // 1. taplo check (file-level)
    if (await isCommandAvailable('taplo --version')) {
      const fileList = targets.map((f) => `"${f}"`).join(' ')
      const res = await runDiagnosticCommand(`taplo check ${fileList}`, dir, 60_000)
      if (!res.failed) {
        for (const f of targets) {
          entries.push(...parseTaploOutput(res.stdout + '\n' + res.stderr, f))
        }
      }
      if (entries.length > 0) return { entries }
      if (!res.failed) return { entries }
    }

    // 2. tomlcheck (file-level)
    if (await isCommandAvailable('tomlcheck --version')) {
      const fileList = targets.map((f) => `"${f}"`).join(' ')
      const res = await runDiagnosticCommand(`tomlcheck ${fileList}`, dir, 60_000)
      if (!res.failed) {
        for (const f of targets) {
          entries.push(...parseTomlcheckOutput(res.stderr, f))
        }
      }
      if (entries.length > 0) {
        return { entries, note: 'taplo not found — used tomlcheck' }
      }
      if (!res.failed) return { entries }
    }

    // 3. Fallback: python tomllib (per-file, syntax only, python 3.11+)
    if (await isCommandAvailable('python --version')) {
      let pythonOk = true
      for (const f of targets) {
        // Экранируем одинарные кавычки в пути
        const safePath = String(f).replace(/'/g, "\\'")
        const cmd = `python -c "import tomllib,sys; tomllib.load(open('${safePath}','rb'))"`
        const res = await runDiagnosticCommand(cmd, dir, 30_000)
        if (!res.failed && res.stderr) {
          entries.push(...parseTomllibOutput(res.stderr, f))
        }
        // Если python ругается на отсутствие tomllib — выходим
        if (res.stderr && /No module named ['"]?tomllib['"]?/i.test(res.stderr)) {
          pythonOk = false
          break
        }
      }
      if (entries.length > 0) {
        return { entries, note: 'taplo/tomlcheck not found — used python tomllib (syntax check only)' }
      }
      if (pythonOk && entries.length === 0) {
        // tomllib отработал без ошибок — всё валидно
        return { entries }
      }
    }

    if (entries.length === 0) {
      return {
        entries: [],
        note: 'taplo/tomlcheck not installed — TOML diagnostics skipped. Install: cargo install taplo-cli or pip install tomlcheck',
      }
    }

    return { entries }
  },
}
