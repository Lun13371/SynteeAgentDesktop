// ── Haskell провайдер: ghc -fno-code + hlint ──

import { resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasAnyMarker } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// ghc: "file.hs:12:5: error: message" или "file.hs:12:5: warning: message"
const GHC_RE = /^(.+?):(\d+):(?:(\d+):)?\s+(error|warning):\s*(.+)$/

function parseGhc(output: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(GHC_RE)
    if (!m) continue
    const [, file, lineNum, col, severity, message] = m
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      col: col ? Number(col) : undefined,
      severity: severity as 'error' | 'warning',
      message: message.trim(),
      source: 'ghc',
    })
  }
  return entries
}

// hlint JSON: [{ file, startLine, endLine, hint, severity }]
function parseHlintJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  try {
    const data = JSON.parse(stdout)
    for (const item of data) {
      entries.push({
        file: item.file || '',
        line: item.startLine ?? 0,
        severity: 'warning',
        message: item.hint || '',
        source: 'hlint',
      })
    }
  } catch { /* not JSON */ }
  return entries
}

export const haskellProvider: DiagnosticProvider = {
  name: 'haskell',

  detect(dir) {
    return hasAnyMarker(dir, ['.cabal', 'stack.yaml', 'Setup.hs', 'flake.nix', 'hie.yaml'])
  },

  async run(dir, files?) {
    const entries: DiagnosticEntry[] = []

    // 1. ghc -fno-code (per-file type/syntax check)
    if (files && files.length > 0 && await isCommandAvailable('ghc --version')) {
      for (const f of files) {
        const fp = resolve(dir, f)
        const res = await runDiagnosticCommand(
          `ghc -fno-code -Wall "${fp}"`,
          dir, 60_000,
        )
        entries.push(...parseGhc(res.stderr))
      }
    }

    // 2. hlint
    if (await isCommandAvailable('hlint --version')) {
      const cmd = files && files.length > 0
        ? `hlint --json ${files.map((f) => `"${resolve(dir, f)}"`).join(' ')}`
        : 'hlint --json .'
      const res = await runDiagnosticCommand(cmd, dir, 60_000)
      if (!res.failed) {
        entries.push(...parseHlintJson(res.stdout))
      }
    }

    if (entries.length === 0 && !await isCommandAvailable('ghc --version') && !await isCommandAvailable('hlint --version')) {
      return { entries: [], note: 'ghc and hlint not installed — Haskell diagnostics skipped' }
    }

    return { entries }
  },
}
