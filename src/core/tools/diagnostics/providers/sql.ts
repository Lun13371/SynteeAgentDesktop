// ── SQL провайдер: sqlfluff ──

import { resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasFileMatching, hasAnyMarker } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// sqlfluff JSON: [{ filepath, violations: [{ line_no, line_pos, code, description }] }]
function parseSqlfluffJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  try {
    const data = JSON.parse(stdout)
    for (const file of data) {
      for (const v of file.violations || []) {
        entries.push({
          file: file.filepath || '',
          line: v.line_no ?? 0,
          col: v.line_pos,
          severity: 'warning',
          message: v.code ? `${v.code}: ${v.description}` : v.description,
          source: 'sqlfluff',
        })
      }
    }
  } catch { /* not JSON */ }
  return entries
}

export const sqlProvider: DiagnosticProvider = {
  name: 'sql',

  detect(dir) {
    return hasAnyMarker(dir, ['.sqlfluff', '.sqlfluffignore']) ||
      hasFileMatching(dir, ['.sql'])
  },

  async run(dir, files?) {
    if (!await isCommandAvailable('sqlfluff --version')) {
      return { entries: [], note: 'sqlfluff not installed — SQL diagnostics skipped. Install: pip install sqlfluff' }
    }

    // Если files не передан, ищем .sql в корне (нерекурсивно)
    let targets = files && files.length > 0
      ? files.map((f) => resolve(dir, f))
      : []

    if (targets.length === 0) {
      try {
        const { readdirSync } = await import('fs')
        targets = readdirSync(dir)
          .filter((f: string) => f.endsWith('.sql'))
          .map((f: string) => resolve(dir, f))
      } catch { /* ignore */ }
    }

    if (targets.length === 0) {
      return { entries: [], note: 'no .sql files found in project root' }
    }

    const cmd = `sqlfluff lint --format json ${targets.map((f) => `"${f}"`).join(' ')}`
    const res = await runDiagnosticCommand(cmd, dir, 60_000)
    if (res.failed) {
      return { entries: [], failed: res.failureReason }
    }

    return { entries: parseSqlfluffJson(res.stdout) }
  },
}
