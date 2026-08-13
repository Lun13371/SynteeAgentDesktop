// ── Groovy провайдер: npm-groovy-lint → groovyc fallback ──

import { resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasAnyMarker, hasFileMatching } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// npm-groovy-lint JSON: { files: [{ path, errors: [{ line, column, severity, message, rule }] }] }
function parseGroovyLintJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  try {
    const data = JSON.parse(stdout)
    for (const file of data.files || []) {
      for (const err of file.errors || []) {
        const sev = String(err.severity || '').toLowerCase()
        entries.push({
          file: file.path || '',
          line: err.line ?? 0,
          col: err.column,
          severity: sev === 'error' ? 'error' : 'warning',
          message: err.rule
            ? `[${err.rule}] ${err.message || ''}`
            : (err.message || ''),
          source: 'npm-groovy-lint',
        })
      }
    }
  } catch { /* not JSON */ }
  return entries
}

// groovyc: "file.groovy: line: message" (gcc-like, без severity word)
const GROOVYC_RE = /^(.+?):(\d+):\s*(.+)$/

function parseGroovyc(output: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(GROOVYC_RE)
    if (!m) continue
    const [, file, lineNum, rest] = m
    // Пропускаем информационные строки
    if (rest.toLowerCase().includes('compilation successful')) continue
    const isErr = rest.toLowerCase().includes('error')
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      severity: isErr ? 'error' : 'warning',
      message: rest.trim(),
      source: 'groovyc',
    })
  }
  return entries
}

export const groovyProvider: DiagnosticProvider = {
  name: 'groovy',

  detect(dir) {
    // build.gradle (без .kts — это Kotlin), Jenkinsfile, *.groovy, gradle.properties
    return hasAnyMarker(dir, ['build.gradle', 'Jenkinsfile', 'gradle.properties']) ||
      hasFileMatching(dir, ['.groovy'])
  },

  async run(dir, files?) {
    // 1. npm-groovy-lint (file-level или project-level)
    if (await isCommandAvailable('npm-groovy-lint --version')) {
      const target = files && files.length > 0
        ? files.map((f) => `"${resolve(dir, f)}"`).join(' ')
        : '.'
      const res = await runDiagnosticCommand(
        `npm-groovy-lint --format json ${target}`,
        dir, 120_000,
      )
      if (!res.failed) {
        return { entries: parseGroovyLintJson(res.stdout) }
      }
    }

    // 2. Fallback: groovyc (per-file compile / syntax check)
    if (files && files.length > 0 && await isCommandAvailable('groovyc --version')) {
      const entries: DiagnosticEntry[] = []
      for (const f of files) {
        const fp = resolve(dir, f)
        const res = await runDiagnosticCommand(`groovyc "${fp}"`, dir, 30_000)
        entries.push(...parseGroovyc(res.stderr + '\n' + res.stdout))
      }
      return { entries, note: 'npm-groovy-lint not found — used groovyc (syntax check only)' }
    }

    return {
      entries: [],
      note: 'npm-groovy-lint not installed — Groovy diagnostics skipped. Install: npm install -g npm-groovy-lint',
    }
  },
}
