// ── GraphQL провайдер: graphql-schema-linter → graphql-eslint → graphql validate ──

import { existsSync } from 'fs'
import { resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasAnyMarker, hasFileMatching } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

const CONFIG_MARKERS = [
  '.graphqlrc',
  '.graphqlrc.yml',
  '.graphqlrc.json',
  '.graphqlrc.yaml',
  'graphql.config.json',
  'graphql.config.yml',
  'graphql.config.yaml',
]

// graphql-schema-linter JSON: [{ message, location: [{ line, column }], rule }]
function parseSchemaLinterJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  try {
    const data = JSON.parse(stdout)
    for (const item of data) {
      const loc = item.location?.[0] ?? {}
      entries.push({
        file: loc.path || loc.file || '',
        line: loc.line ?? 0,
        col: loc.column,
        severity: 'warning',
        message: item.rule ? `${item.rule}: ${item.message || ''}` : (item.message || ''),
        source: 'graphql-schema-linter',
      })
    }
  } catch { /* not JSON */ }
  return entries
}

// eslint JSON (flat): [{ filePath, messages: [{ line, column, ruleId, message, severity }] }]
function parseEslintJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  try {
    const data = JSON.parse(stdout)
    for (const file of data) {
      for (const msg of file.messages || []) {
        entries.push({
          file: file.filePath || '',
          line: msg.line ?? 0,
          col: msg.column,
          severity: msg.severity === 2 ? 'error' : 'warning',
          message: msg.ruleId ? `${msg.ruleId}: ${msg.message || ''}` : (msg.message || ''),
          source: 'graphql-eslint',
        })
      }
    }
  } catch { /* not JSON */ }
  return entries
}

// graphql validate: text output, errors like "Error: <message> at line N"
const GRAPHQL_VALIDATE_RE = /(?:Error|error):\s*(.+?)(?:\s+at\s+line\s+(\d+))?$/
function parseGraphqlValidate(stdout: string, file: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of stdout.split('\n')) {
    const m = line.match(GRAPHQL_VALIDATE_RE)
    if (m) {
      entries.push({
        file,
        line: m[2] ? Number(m[2]) : 0,
        severity: 'error',
        message: m[1].trim(),
        source: 'graphql-validate',
      })
    }
  }
  return entries
}

export const graphqlProvider: DiagnosticProvider = {
  name: 'graphql',

  detect(dir) {
    return hasFileMatching(dir, ['.graphql', '.gql']) ||
      hasAnyMarker(dir, CONFIG_MARKERS)
  },

  async run(dir, files?) {
    // Собираем target-файлы
    let targets = files && files.length > 0
      ? files.map((f) => resolve(dir, f))
      : []

    if (targets.length === 0) {
      try {
        const { readdirSync } = await import('fs')
        targets = readdirSync(dir)
          .filter((f: string) => f.endsWith('.graphql') || f.endsWith('.gql'))
          .map((f: string) => resolve(dir, f))
      } catch { /* ignore */ }
    }

    if (targets.length === 0) {
      return { entries: [], note: 'no .graphql/.gql files found in project root' }
    }

    const entries: DiagnosticEntry[] = []

    // 1. graphql-schema-linter (file-level)
    if (await isCommandAvailable('graphql-schema-linter --version')) {
      const cmd = `graphql-schema-linter --json ${targets.map((f) => `"${f}"`).join(' ')}`
      const res = await runDiagnosticCommand(cmd, dir, 60_000)
      if (!res.failed) {
        entries.push(...parseSchemaLinterJson(res.stdout || res.stderr))
      }
      if (entries.length > 0) return { entries }
    }

    // 2. eslint с @graphql-eslint (project-level, --ext .graphql)
    const hasGraphqlEslint = existsSync(resolve(dir, 'node_modules', '@graphql-eslint')) ||
      existsSync(resolve(dir, 'node_modules', '@graphql-eslint', 'eslint'))
    if (hasGraphqlEslint && await isCommandAvailable('npx eslint --version')) {
      const cmd = `npx eslint --format json --ext .graphql --ext .gql .`
      const res = await runDiagnosticCommand(cmd, dir, 120_000)
      if (!res.failed) {
        entries.push(...parseEslintJson(res.stdout))
      }
      if (entries.length > 0) return { entries }
    }

    // 3. Fallback: graphql validate (basic schema validation, per-file)
    if (await isCommandAvailable('graphql --version')) {
      for (const f of targets) {
        const res = await runDiagnosticCommand(`graphql validate "${f}"`, dir, 30_000)
        if (!res.failed && (res.stdout || res.stderr)) {
          entries.push(...parseGraphqlValidate(res.stdout + '\n' + res.stderr, f))
        }
      }
      if (entries.length > 0) {
        return { entries, note: 'graphql-schema-linter/eslint not found — used graphql validate (basic validation)' }
      }
    }

    if (entries.length === 0) {
      return {
        entries: [],
        note: 'graphql-schema-linter not installed — GraphQL diagnostics skipped. Install: npm install -g graphql-schema-linter',
      }
    }

    return { entries }
  },
}
