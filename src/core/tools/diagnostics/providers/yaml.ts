// ── YAML провайдер: yamllint ──

import { resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasFileMatching } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// yamllint JSON: [{ file, line, column, level, message }]
function parseYamllintJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  try {
    const data = JSON.parse(stdout)
    for (const item of data) {
      entries.push({
        file: item.file || '',
        line: item.line ?? 0,
        col: item.column,
        severity: item.level === 'error' ? 'error' : 'warning',
        message: item.message || '',
        source: 'yamllint',
      })
    }
  } catch { /* not JSON */ }
  return entries
}

export const yamlProvider: DiagnosticProvider = {
  name: 'yaml',

  detect(dir) {
    return hasFileMatching(dir, ['.yamllint', '.yamllint.yaml', '.yamllint.yml']) ||
      hasFileMatching(dir, ['.yaml', '.yml'])
  },

  async run(dir, files?) {
    if (!await isCommandAvailable('yamllint --version')) {
      return { entries: [], note: 'yamllint not installed — YAML diagnostics skipped. Install: pip install yamllint' }
    }

    // Если files не передан, ищем .yaml/.yml в корне
    let targets = files && files.length > 0
      ? files.map((f) => resolve(dir, f))
      : []

    if (targets.length === 0) {
      try {
        const { readdirSync } = await import('fs')
        targets = readdirSync(dir)
          .filter((f: string) => f.endsWith('.yaml') || f.endsWith('.yml'))
          .map((f: string) => resolve(dir, f))
      } catch { /* ignore */ }
    }

    if (targets.length === 0) {
      return { entries: [], note: 'no .yaml/.yml files found in project root' }
    }

    const cmd = `yamllint -f json ${targets.map((f) => `"${f}"`).join(' ')}`
    const res = await runDiagnosticCommand(cmd, dir, 60_000)
    if (res.failed) {
      return { entries: [], failed: res.failureReason }
    }

    return { entries: parseYamllintJson(res.stdout) }
  },
}
