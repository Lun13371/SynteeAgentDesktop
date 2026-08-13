// ── Dart / Flutter провайдер: dart analyze + dart format ──

import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { runDiagnosticCommand } from '../runner'
import { filterEntriesByFiles } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// dart analyze JSON: { diagnostics: [{ file, location: { line, column }, severity, code, message }] }
function parseDartAnalyzeJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  try {
    const data = JSON.parse(stdout)
    for (const d of data.diagnostics || []) {
      entries.push({
        file: d.file || '',
        line: d.location?.line ?? 0,
        col: d.location?.column,
        severity: d.severity === 'error' ? 'error' : 'warning',
        message: d.code ? `${d.code}: ${d.message}` : d.message,
        source: 'dart-analyze',
      })
    }
  } catch { /* not JSON */ }
  return entries
}

export const dartProvider: DiagnosticProvider = {
  name: 'dart',

  detect(dir) {
    return existsSync(join(dir, 'pubspec.yaml'))
  },

  async run(dir, files?) {
    const entries: DiagnosticEntry[] = []

    // 1. dart analyze
    const cmd = files && files.length > 0
      ? `dart analyze --format json ${files.map((f) => `"${resolve(dir, f)}"`).join(' ')}`
      : 'dart analyze --format json'
    const res = await runDiagnosticCommand(cmd, dir, 120_000)
    if (!res.failed) {
      let analyzeEntries = parseDartAnalyzeJson(res.stdout)
      if (files && files.length > 0) analyzeEntries = filterEntriesByFiles(analyzeEntries, dir, files)
      entries.push(...analyzeEntries)
    } else {
      return { entries: [], failed: res.failureReason }
    }

    // 2. dart format (formatting check, только если files переданы)
    if (files && files.length > 0) {
      for (const f of files) {
        const fp = resolve(dir, f)
        const fmtRes = await runDiagnosticCommand(
          `dart format --output=none --set-exit-if-changed "${fp}"`,
          dir, 30_000,
        )
        if (!fmtRes.failed && fmtRes.stdout.includes('changed')) {
          entries.push({
            file: f,
            line: 1,
            severity: 'warning',
            message: 'file is not dart format-compliant',
            source: 'dart-format',
          })
        }
      }
    }

    return { entries }
  },
}
