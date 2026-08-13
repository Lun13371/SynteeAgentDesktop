// ── TypeScript провайдер (tsc --noEmit) ──
// Перенесён из diagnostics.ts:6-34, 172-191.

import { existsSync } from 'fs'
import { join } from 'path'
import { runDiagnosticCommand } from '../runner'
import { filterEntriesByFiles } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry, ProviderRunResult } from '../types'

// tsc format: "C:\path\file.ts(12,5): error TS2322: Type 'X' is not assignable..."
const TSC_LINE_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.+)$/

function parseTscOutput(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of stdout.split('\n')) {
    const m = line.match(TSC_LINE_RE)
    if (!m) continue
    const [, file, lineNum, col, severity, code, message] = m
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      col: Number(col),
      severity: severity as 'error' | 'warning',
      message: `${code}: ${message.trim()}`,
      source: 'tsc',
    })
  }
  return entries
}

export const typescriptProvider: DiagnosticProvider = {
  name: 'typescript',

  detect(dir: string): boolean {
    return ['tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json'].some((f) =>
      existsSync(join(dir, f)),
    )
  },

  async run(dir: string, files?: string[]): Promise<ProviderRunResult> {
    const entries: DiagnosticEntry[] = []
    const failures: string[] = []
    const notes: string[] = []

    const nodeTsconfig = join(dir, 'tsconfig.node.json')
    const webTsconfig = join(dir, 'tsconfig.web.json')
    const rootTsconfig = join(dir, 'tsconfig.json')

    if (existsSync(nodeTsconfig) && existsSync(webTsconfig)) {
      const [nodeRes, webRes] = await Promise.all([
        runDiagnosticCommand('npx tsc -p tsconfig.node.json --noEmit --pretty false', dir),
        runDiagnosticCommand('npx tsc -p tsconfig.web.json --noEmit --pretty false', dir),
      ])
      if (nodeRes.failed) failures.push(`tsc (node): ${nodeRes.failureReason}`)
      else entries.push(...parseTscOutput(nodeRes.stdout + '\n' + nodeRes.stderr))
      if (webRes.failed) failures.push(`tsc (web): ${webRes.failureReason}`)
      else entries.push(...parseTscOutput(webRes.stdout + '\n' + webRes.stderr))
    } else if (existsSync(rootTsconfig)) {
      const res = await runDiagnosticCommand('npx tsc -p tsconfig.json --noEmit --pretty false', dir)
      if (res.failed) failures.push(`tsc: ${res.failureReason}`)
      else entries.push(...parseTscOutput(res.stdout + '\n' + res.stderr))
    }

    // tsc не поддерживает file-level → если files передан, фильтруем
    let filtered = entries
    if (files && files.length > 0) {
      filtered = filterEntriesByFiles(entries, dir, files)
    }

    return {
      entries: filtered,
      failed: failures.length > 0 ? failures.join('; ') : undefined,
      note: notes.length > 0 ? notes.join('; ') : undefined,
    }
  },
}
