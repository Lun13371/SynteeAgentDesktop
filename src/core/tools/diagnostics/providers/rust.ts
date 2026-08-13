// ── Rust провайдер: cargo check + clippy ──

import { existsSync } from 'fs'
import { join } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { filterEntriesByFiles } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// cargo --message-format=json: каждая строка — JSON.
// compiler-message: { reason: "compiler-message", message: { spans: [{file_name, line_start, column_start}], level, code?, message } }
function parseCargoJson(stdout: string, source: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    try {
      const msg = JSON.parse(line)
      if (msg.reason !== 'compiler-message') continue
      const m = msg.message
      if (!m?.spans?.length) continue
      const span = m.spans.find((s: any) => s.is_primary) || m.spans[0]
      entries.push({
        file: span.file_name || '',
        line: span.line_start ?? 0,
        col: span.column_start,
        severity: m.level === 'error' ? 'error' : 'warning',
        message: m.code ? `${m.code.code}: ${m.message}` : m.message,
        source,
      })
    } catch { /* not JSON line */ }
  }
  return entries
}

export const rustProvider: DiagnosticProvider = {
  name: 'rust',

  detect(dir) {
    return existsSync(join(dir, 'Cargo.toml'))
  },

  async run(dir, files?) {
    const entries: DiagnosticEntry[] = []
    const failures: string[] = []

    // 1. cargo check
    const checkRes = await runDiagnosticCommand(
      'cargo check --message-format=json',
      dir,
      180_000,
    )
    if (checkRes.failed) {
      failures.push(`cargo check: ${checkRes.failureReason}`)
    } else {
      let checkEntries = parseCargoJson(checkRes.stdout, 'cargo')
      if (files && files.length > 0) checkEntries = filterEntriesByFiles(checkEntries, dir, files)
      entries.push(...checkEntries)
    }

    // 2. cargo clippy (если доступен)
    if (await isCommandAvailable('cargo clippy --version')) {
      const clippyRes = await runDiagnosticCommand(
        'cargo clippy --message-format=json',
        dir,
        180_000,
      )
      if (!clippyRes.failed) {
        let clippyEntries = parseCargoJson(clippyRes.stdout, 'clippy')
        if (files && files.length > 0) clippyEntries = filterEntriesByFiles(clippyEntries, dir, files)
        entries.push(...clippyEntries)
      }
    }

    return {
      entries,
      failed: failures.length > 0 ? failures.join('; ') : undefined,
    }
  },
}
