// ── Docker провайдер: hadolint ──

import { resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasFileMatching } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// hadolint JSON: [{ file, line, column, code, message, level }]
function parseHadolintJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  try {
    const data = JSON.parse(stdout)
    for (const item of data) {
      entries.push({
        file: item.file || '',
        line: item.line ?? 0,
        col: item.column,
        severity: item.level === 'error' ? 'error' : 'warning',
        message: item.code ? `${item.code}: ${item.message}` : item.message,
        source: 'hadolint',
      })
    }
  } catch { /* not JSON */ }
  return entries
}

export const dockerProvider: DiagnosticProvider = {
  name: 'docker',

  detect(dir) {
    return hasFileMatching(dir, ['Dockerfile']) ||
      hasFileMatching(dir, ['.dockerfile']) ||
      hasFileMatching(dir, ['.hadolint.yaml'])
  },

  async run(dir, files?) {
    if (!await isCommandAvailable('hadolint --version')) {
      return { entries: [], note: 'hadolint not installed — Docker diagnostics skipped. Install: https://github.com/hadolint/hadolint' }
    }

    // Если files не передан, ищем Dockerfile в корне
    let targets = files && files.length > 0
      ? files.map((f) => resolve(dir, f))
      : []

    if (targets.length === 0) {
      try {
        const { readdirSync } = await import('fs')
        targets = readdirSync(dir)
          .filter((f: string) => f === 'Dockerfile' || f.endsWith('.dockerfile') || f.startsWith('Dockerfile.'))
          .map((f: string) => resolve(dir, f))
      } catch { /* ignore */ }
    }

    if (targets.length === 0) {
      return { entries: [], note: 'no Dockerfile found in project root' }
    }

    const cmd = `hadolint --format json ${targets.map((f) => `"${f}"`).join(' ')}`
    const res = await runDiagnosticCommand(cmd, dir, 30_000)
    if (res.failed) {
      return { entries: [], failed: res.failureReason }
    }

    return { entries: parseHadolintJson(res.stdout) }
  },
}
