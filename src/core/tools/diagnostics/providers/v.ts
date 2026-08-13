// ── V провайдер: v check ──

import { resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasAnyMarker, hasFileMatching, filterEntriesByFiles } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// v check: "file.v:line: error: message"
// или "file.v:line: warning: message"
const V_RE = /^(.+?):(\d+):\s+(error|warning):\s+(.+)$/

function parseV(output: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(V_RE)
    if (!m) continue
    const [, file, lineNum, severity, message] = m
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      severity: severity as 'error' | 'warning',
      message: message.trim(),
      source: 'v-check',
    })
  }
  return entries
}

export const vProvider: DiagnosticProvider = {
  name: 'v',

  detect(dir) {
    return hasAnyMarker(dir, ['v.mod']) || hasFileMatching(dir, ['.v'])
  },

  async run(dir, files?) {
    if (!await isCommandAvailable('v --version')) {
      return { entries: [], note: 'v not installed — V diagnostics skipped' }
    }

    const entries: DiagnosticEntry[] = []

    const cmd = files && files.length > 0
      ? `v check ${files.map((f) => `"${resolve(dir, f)}"`).join(' ')}`
      : 'v check .'
    const res = await runDiagnosticCommand(cmd, dir, 120_000)
    if (res.failed) {
      return { entries: [], failed: res.failureReason }
    }

    let vEntries = parseV(res.stdout + '\n' + res.stderr)
    if (files && files.length > 0) {
      vEntries = filterEntriesByFiles(vEntries, dir, files)
    }
    entries.push(...vEntries)

    return { entries }
  },
}
