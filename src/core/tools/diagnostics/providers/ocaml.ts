// ── OCaml провайдер: dune build → ocamlfind ocamlc ──

import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasFileMatching, filterEntriesByFiles } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// dune/ocamlc: 'File "file.ml", line 12, characters 5-10: Error: message'
// или 'File "file.ml", line 12, characters 5-10: Warning: message'
const OCAML_RE = /^File\s+"(.+?)",\s*line\s+(\d+),\s*characters\s+(\d+)-\d+:\s*(.+)$/

function parseOcaml(output: string, source: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(OCAML_RE)
    if (!m) continue
    const [, file, lineNum, col, rest] = m
    const lower = rest.toLowerCase()
    let severity: 'error' | 'warning' = 'error'
    let message = rest
    if (lower.startsWith('error')) {
      severity = 'error'
      message = rest.replace(/^error[:\s]+/i, '')
    } else if (lower.startsWith('warning')) {
      severity = 'warning'
      message = rest.replace(/^warning[:\s]+/i, '')
    }
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      col: Number(col),
      severity,
      message: message.trim(),
      source,
    })
  }
  return entries
}

export const ocamlProvider: DiagnosticProvider = {
  name: 'ocaml',

  detect(dir) {
    return existsSync(join(dir, 'dune-project')) ||
      existsSync(join(dir, 'dune')) ||
      hasFileMatching(dir, ['.opam']) ||
      existsSync(join(dir, '_oasis'))
  },

  async run(dir, files?) {
    const entries: DiagnosticEntry[] = []
    const failures: string[] = []

    const hasDuneProject = existsSync(join(dir, 'dune-project'))

    // 1. dune build (если есть dune-project)
    if (hasDuneProject && await isCommandAvailable('dune --version')) {
      const res = await runDiagnosticCommand('dune build', dir, 180_000)
      if (res.failed) {
        failures.push(`dune: ${res.failureReason}`)
      } else {
        let duneEntries = parseOcaml(res.stdout + '\n' + res.stderr, 'dune')
        if (files && files.length > 0) duneEntries = filterEntriesByFiles(duneEntries, dir, files)
        entries.push(...duneEntries)
      }
    }

    // 2. Fallback: ocamlfind ocamlc (per-file syntax check)
    if (entries.length === 0 && files && files.length > 0 && await isCommandAvailable('ocamlfind')) {
      for (const f of files) {
        if (!f.endsWith('.ml') && !f.endsWith('.mli')) continue
        const fp = resolve(dir, f)
        const res = await runDiagnosticCommand(
          `ocamlfind ocamlc -c "${fp}"`,
          dir, 60_000,
        )
        entries.push(...parseOcaml(res.stderr + '\n' + res.stdout, 'ocamlc'))
      }
    }

    if (entries.length === 0 && failures.length === 0) {
      const hasDune = await isCommandAvailable('dune --version')
      const hasOcamlc = await isCommandAvailable('ocamlfind')
      if (!hasDune && !hasOcamlc) {
        return { entries: [], note: 'dune and ocamlfind not installed — OCaml diagnostics skipped' }
      }
    }

    return {
      entries,
      failed: failures.length > 0 ? failures.join('; ') : undefined,
    }
  },
}
