// ── Ruby провайдер: rubocop → ruby -c (syntax fallback) ──

import { resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasAnyMarker } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// rubocop JSON: { files: [{ path, offenses: [{ severity, message, location: { line, column } }] }] }
function parseRubocopJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  try {
    const data = JSON.parse(stdout)
    for (const file of data.files || []) {
      for (const offense of file.offenses || []) {
        entries.push({
          file: file.path || '',
          line: offense.location?.line ?? 0,
          col: offense.location?.column,
          severity: offense.severity === 'error' || offense.severity === 'fatal' ? 'error' : 'warning',
          message: offense.message || '',
          source: 'rubocop',
        })
      }
    }
  } catch { /* not JSON */ }
  return entries
}

export const rubyProvider: DiagnosticProvider = {
  name: 'ruby',

  detect(dir) {
    return hasAnyMarker(dir, ['Gemfile', 'Gemfile.lock', '.rubocop.yml', '.standard.yml']) ||
      hasAnyMarker(dir, ['.ruby-version'])
  },

  async run(dir, files?) {
    const fileArgs = files && files.length > 0
      ? ' ' + files.map((f) => `"${resolve(dir, f)}"`).join(' ')
      : ' .'

    // 1. rubocop
    if (await isCommandAvailable('rubocop --version')) {
      const cmd = `rubocop --format json${fileArgs}`
      const res = await runDiagnosticCommand(cmd, dir, 120_000)
      if (!res.failed) {
        return { entries: parseRubocopJson(res.stdout) }
      }
    }

    // 2. Fallback: ruby -c (per-file syntax check)
    if (files && files.length > 0) {
      const entries: DiagnosticEntry[] = []
      for (const f of files) {
        const fp = resolve(dir, f)
        const res = await runDiagnosticCommand(`ruby -c "${fp}"`, dir, 30_000)
        if (res.stderr && res.stderr.toLowerCase().includes('syntax error')) {
          entries.push({
            file: f,
            line: 0,
            severity: 'error',
            message: res.stderr.trim(),
            source: 'ruby-syntax',
          })
        }
      }
      return { entries, note: 'rubocop not found — used ruby -c (syntax check only)' }
    }

    return {
      entries: [],
      note: 'rubocop not installed — Ruby diagnostics skipped. Install: gem install rubocop',
    }
  },
}
