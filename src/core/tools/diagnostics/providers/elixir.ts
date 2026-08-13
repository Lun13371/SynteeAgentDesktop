// ── Elixir провайдер: mix compile + credo ──

import { existsSync } from 'fs'
import { join } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { filterEntriesByFiles } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// mix compile: "warning: message\n  path/file.ex:line:col"
// или "error: message\n  path/file.ex:line:col"
const MIX_WARNING_RE = /^warning:\s*(.+)$/
const MIX_ERROR_RE = /^(?:\*\*\s*)?(?:error|CompileError):\s*(.+)$/
const MIX_FILE_RE = /^\s+(.+?):(\d+)(?::(\d+))?$/

function parseMixCompile(output: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  const lines = output.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const wMatch = line.match(MIX_WARNING_RE)
    const eMatch = line.match(MIX_ERROR_RE)
    if (wMatch || eMatch) {
      const severity = eMatch ? 'error' : 'warning'
      const message = (eMatch || wMatch)![1].trim()
      // Ищем file:line на следующей строке
      if (i + 1 < lines.length) {
        const fMatch = lines[i + 1].match(MIX_FILE_RE)
        if (fMatch) {
          const [, file, lineNum, col] = fMatch
          entries.push({
            file: file.trim(),
            line: Number(lineNum),
            col: col ? Number(col) : undefined,
            severity: severity as 'error' | 'warning',
            message,
            source: 'mix-compile',
          })
        }
      }
    }
  }
  return entries
}

// credo JSON: [{ check, category, filename, line_no, message, priority, severity }]
function parseCredoJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  try {
    const data = JSON.parse(stdout)
    for (const item of data) {
      entries.push({
        file: item.filename || '',
        line: item.line_no ?? 0,
        severity: item.severity === 'error' ? 'error' : 'warning',
        message: `${item.check || ''}: ${item.message || ''}`.trim(),
        source: 'credo',
      })
    }
  } catch { /* not JSON */ }
  return entries
}

export const elixirProvider: DiagnosticProvider = {
  name: 'elixir',

  detect(dir) {
    return existsSync(join(dir, 'mix.exs'))
  },

  async run(dir, files?) {
    const entries: DiagnosticEntry[] = []
    const failures: string[] = []

    // 1. mix compile
    const res = await runDiagnosticCommand('mix compile', dir, 120_000)
    if (res.failed) {
      failures.push(`mix compile: ${res.failureReason}`)
    } else {
      let compileEntries = parseMixCompile(res.stdout + '\n' + res.stderr)
      if (files && files.length > 0) compileEntries = filterEntriesByFiles(compileEntries, dir, files)
      entries.push(...compileEntries)
    }

    // 2. credo (если доступен и есть .credo.exs)
    if (existsSync(join(dir, '.credo.exs')) && await isCommandAvailable('mix credo --version')) {
      const cmd = files && files.length > 0
        ? `mix credo --format json ${files.map((f) => `"${join(dir, f)}"`).join(' ')}`
        : 'mix credo --format json'
      const credoRes = await runDiagnosticCommand(cmd, dir, 60_000)
      if (!credoRes.failed) {
        let credoEntries = parseCredoJson(credoRes.stdout)
        if (files && files.length > 0) credoEntries = filterEntriesByFiles(credoEntries, dir, files)
        entries.push(...credoEntries)
      }
    }

    return {
      entries,
      failed: failures.length > 0 ? failures.join('; ') : undefined,
    }
  },
}
