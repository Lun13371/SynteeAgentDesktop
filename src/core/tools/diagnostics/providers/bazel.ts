// ── Bazel провайдер: buildifier ──

import { resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasAnyMarker } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

const MARKERS = [
  'WORKSPACE',
  'WORKSPACE.bazel',
  'BUILD',
  'BUILD.bazel',
  '.bazelrc',
  'MODULE.bazel',
]

// buildifier --format=json:
// [{ filename, warnings: [{ start: { line, column }, end: { line, column }, category, message }], errors: [...] }]
function parseBuildifierJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  try {
    const data = JSON.parse(stdout)
    const files = Array.isArray(data) ? data : [data]
    for (const file of files) {
      const filename = file.filename || file.path || ''
      // warnings
      for (const w of file.warnings || []) {
        const start = w.start || {}
        entries.push({
          file: filename,
          line: start.line ?? 0,
          col: start.column,
          severity: 'warning',
          message: w.category ? `${w.category}: ${w.message || ''}` : (w.message || ''),
          source: 'buildifier',
        })
      }
      // errors (buildifier может класть ошибки отдельно)
      for (const e of file.errors || []) {
        const start = e.start || {}
        entries.push({
          file: filename,
          line: start.line ?? 0,
          col: start.column,
          severity: 'error',
          message: e.category ? `${e.category}: ${e.message || ''}` : (e.message || ''),
          source: 'buildifier',
        })
      }
    }
  } catch { /* not JSON */ }
  return entries
}

export const bazelProvider: DiagnosticProvider = {
  name: 'bazel',

  detect(dir) {
    return hasAnyMarker(dir, MARKERS)
  },

  async run(dir, files?) {
    if (!await isCommandAvailable('buildifier --version')) {
      return {
        entries: [],
        note: 'buildifier not installed — Bazel diagnostics skipped. Install: go install github.com/bazelbuild/buildtools/buildifier@latest',
      }
    }

    // Собираем target-файлы: BUILD/BUILD.bazel/WORKSPACE/.bzl
    let targets = files && files.length > 0
      ? files.map((f) => resolve(dir, f))
      : []

    if (targets.length === 0) {
      try {
        const { readdirSync } = await import('fs')
        targets = readdirSync(dir)
          .filter((f: string) =>
            f === 'BUILD' || f === 'BUILD.bazel' ||
            f === 'WORKSPACE' || f === 'WORKSPACE.bazel' ||
            f === 'MODULE.bazel' ||
            f.endsWith('.bzl') || f.endsWith('.star'))
          .map((f: string) => resolve(dir, f))
      } catch { /* ignore */ }
    }

    if (targets.length === 0) {
      return { entries: [], note: 'no BUILD/WORKSPACE/.bzl files found in project root' }
    }

    const fileList = targets.map((f) => `"${f}"`).join(' ')
    const res = await runDiagnosticCommand(
      `buildifier --format=json --mode=check ${fileList}`,
      dir, 60_000,
    )
    if (res.failed) {
      return { entries: [], failed: res.failureReason }
    }

    return { entries: parseBuildifierJson(res.stdout) }
  },
}
