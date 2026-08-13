// ── Zig провайдер: zig build ──

import { existsSync } from 'fs'
import { join } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { filterEntriesByFiles } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// zig build: "file.zig:line:col: error: message"
// или "file.zig:line:col: warning: message"
const ZIG_RE = /^(.+?):(\d+):(\d+):\s+(error|warning):\s+(.+)$/

function parseZig(output: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(ZIG_RE)
    if (!m) continue
    const [, file, lineNum, col, severity, message] = m
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      col: Number(col),
      severity: severity as 'error' | 'warning',
      message: message.trim(),
      source: 'zig-build',
    })
  }
  return entries
}

export const zigProvider: DiagnosticProvider = {
  name: 'zig',

  detect(dir) {
    return existsSync(join(dir, 'build.zig'))
  },

  async run(dir, files?) {
    if (!await isCommandAvailable('zig version')) {
      return { entries: [], note: 'zig not installed — Zig diagnostics skipped' }
    }

    const entries: DiagnosticEntry[] = []

    const res = await runDiagnosticCommand('zig build', dir, 180_000)
    if (res.failed) {
      return { entries: [], failed: res.failureReason }
    }

    let zigEntries = parseZig(res.stdout + '\n' + res.stderr)
    if (files && files.length > 0) {
      zigEntries = filterEntriesByFiles(zigEntries, dir, files)
    }
    entries.push(...zigEntries)

    return { entries }
  },
}
