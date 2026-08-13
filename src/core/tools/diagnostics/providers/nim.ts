// ── Nim провайдер: nim check ──

import { resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasAnyMarker, hasFileMatching, filterEntriesByFiles } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// nim check: "file.nim(line, col) Error: message"
// или "file.nim(line, col) Hint: message"
// или "file.nim(line, col) Warning: message"
const NIM_RE = /^(.+?)\((\d+),\s*(\d+)\)\s+(Error|Hint|Warning):\s*(.+)$/

function parseNim(output: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(NIM_RE)
    if (!m) continue
    const [, file, lineNum, col, level, message] = m
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      col: Number(col),
      severity: level === 'Error' ? 'error' : 'warning',
      message: message.trim(),
      source: 'nim-check',
    })
  }
  return entries
}

export const nimProvider: DiagnosticProvider = {
  name: 'nim',

  detect(dir) {
    return hasAnyMarker(dir, ['nim.cfg']) || hasFileMatching(dir, ['.nimble', '.nim'])
  },

  async run(dir, files?) {
    if (!await isCommandAvailable('nim --version')) {
      return { entries: [], note: 'nim not installed — Nim diagnostics skipped' }
    }

    const entries: DiagnosticEntry[] = []

    const cmd = files && files.length > 0
      ? `nim check ${files.map((f) => `"${resolve(dir, f)}"`).join(' ')}`
      : 'nim check .'
    const res = await runDiagnosticCommand(cmd, dir, 120_000)
    if (res.failed) {
      return { entries: [], failed: res.failureReason }
    }

    let nimEntries = parseNim(res.stdout + '\n' + res.stderr)
    if (files && files.length > 0) {
      nimEntries = filterEntriesByFiles(nimEntries, dir, files)
    }
    entries.push(...nimEntries)

    return { entries }
  },
}
