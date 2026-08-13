// ── Clojure провайдер: clj-kondo → clojure load-file fallback ──

import { resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasAnyMarker, hasFileMatching } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// clj-kondo JSON: { findings: [{ filename, row, col, level, message, type }] }
function parseCljKondoJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  try {
    const data = JSON.parse(stdout)
    for (const f of data.findings || []) {
      // level может быть ":error", ":warning", ":info"
      const level = String(f.level || '').replace(/^:/, '')
      const severity: 'error' | 'warning' =
        level === 'warning' || level === 'info' ? 'warning' : 'error'
      const message = f.type
        ? `[${f.type}] ${f.message || ''}`
        : (f.message || '')
      entries.push({
        file: f.filename || '',
        line: f.row ?? 0,
        col: f.col,
        severity,
        message: message.trim(),
        source: 'clj-kondo',
      })
    }
  } catch { /* not JSON */ }
  return entries
}

export const clojureProvider: DiagnosticProvider = {
  name: 'clojure',

  detect(dir) {
    return hasAnyMarker(dir, ['project.clj', 'deps.edn', 'shadow-cljs.edn']) ||
      hasFileMatching(dir, ['.clj', '.cljs', '.cljc'])
  },

  async run(dir, files?) {
    // 1. clj-kondo (project-level linter)
    if (await isCommandAvailable('clj-kondo --version')) {
      const res = await runDiagnosticCommand(
        'clj-kondo --lint . --format json',
        dir, 120_000,
      )
      if (!res.failed) {
        return { entries: parseCljKondoJson(res.stdout) }
      }
    }

    // 2. Fallback: clojure -M -e "(load-file ...)" per-file (syntax only)
    if (files && files.length > 0 && await isCommandAvailable('clojure --version')) {
      const entries: DiagnosticEntry[] = []
      for (const f of files) {
        const fp = resolve(dir, f).replace(/\\/g, '/')
        // Одинарные кавычки — литеральные в PowerShell и bash
        const res = await runDiagnosticCommand(
          `clojure -M -e '(load-file "${fp}")'`,
          dir, 30_000,
        )
        const out = (res.stderr + '\n' + res.stdout).toLowerCase()
        if (res.failed || out.includes('error') || out.includes('exception')) {
          entries.push({
            file: f,
            line: 0,
            severity: 'error',
            message: (res.stderr || res.stdout).trim().slice(0, 500),
            source: 'clojure-load',
          })
        }
      }
      return { entries, note: 'clj-kondo not found — used clojure load-file (syntax check only)' }
    }

    return {
      entries: [],
      note: 'clj-kondo not installed — Clojure diagnostics skipped. Install: https://github.com/clj-kondo/clj-kondo',
    }
  },
}
