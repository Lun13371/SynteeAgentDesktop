// ── Markdown провайдер: markdownlint ──

import { resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasAnyMarker, hasFileMatching } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// markdownlint JSON: [{ fileName, lineNumber, ruleNames, ruleDescription, errorRange }]
function parseMarkdownlintJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  try {
    const data = JSON.parse(stdout)
    for (const file of data) {
      for (const issue of file.issues || file.violations || []) {
        // markdownlint-cli2 format: { line, rule, message }
        // markdownlint-cli format: { lineNumber, ruleNames, ruleDescription }
        const line = issue.lineNumber ?? issue.line ?? 0
        const rule = (issue.ruleNames || [issue.rule || '']).flat().join('/')
        const msg = issue.ruleDescription || issue.message || ''
        entries.push({
          file: file.fileName || '',
          line,
          severity: 'warning',
          message: rule ? `${rule}: ${msg}` : msg,
          source: 'markdownlint',
        })
      }
    }
  } catch { /* not JSON */ }
  return entries
}

export const markdownProvider: DiagnosticProvider = {
  name: 'markdown',

  detect(dir) {
    return hasAnyMarker(dir, ['.markdownlint.json', '.markdownlint.yaml', '.markdownlint.yml', '.markdownlintignore', '.markdownlint-cli2.jsonc']) ||
      hasFileMatching(dir, ['.md', '.markdown'])
  },

  async run(dir, files?) {
    if (!await isCommandAvailable('markdownlint --version')) {
      return { entries: [], note: 'markdownlint not installed — Markdown diagnostics skipped. Install: npm install -g markdownlint-cli' }
    }

    // Если files не передан, ищем .md в корне
    let targets = files && files.length > 0
      ? files.map((f) => resolve(dir, f))
      : []

    if (targets.length === 0) {
      try {
        const { readdirSync } = await import('fs')
        targets = readdirSync(dir)
          .filter((f: string) => f.endsWith('.md') || f.endsWith('.markdown'))
          .map((f: string) => resolve(dir, f))
      } catch { /* ignore */ }
    }

    if (targets.length === 0) {
      return { entries: [], note: 'no .md files found in project root' }
    }

    const cmd = `markdownlint --json ${targets.map((f) => `"${f}"`).join(' ')}`
    const res = await runDiagnosticCommand(cmd, dir, 60_000)
    if (res.failed) {
      return { entries: [], failed: res.failureReason }
    }

    return { entries: parseMarkdownlintJson(res.stdout) }
  },
}
