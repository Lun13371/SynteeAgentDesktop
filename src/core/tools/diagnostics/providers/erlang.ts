// ── Erlang провайдер: rebar3 compile → erlc fallback ──

import { resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasAnyMarker, hasFileMatching, filterEntriesByFiles } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// rebar3/erlc: "file.erl:line: Warning: message" или "file.erl:line: Error: message"
const ERL_RE = /^(.+?):(\d+):\s+(Warning|Error):\s*(.+)$/i

function parseErlang(output: string, source: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(ERL_RE)
    if (!m) continue
    const [, file, lineNum, level, message] = m
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      severity: level.toLowerCase() === 'error' ? 'error' : 'warning',
      message: message.trim(),
      source,
    })
  }
  return entries
}

export const erlangProvider: DiagnosticProvider = {
  name: 'erlang',

  detect(dir) {
    return hasAnyMarker(dir, ['rebar.config', 'erlang.mk']) ||
      hasFileMatching(dir, ['.app', '.erl'])
  },

  async run(dir, files?) {
    const entries: DiagnosticEntry[] = []

    // 1. rebar3 compile (project-level)
    if (await isCommandAvailable('rebar3 --version')) {
      const res = await runDiagnosticCommand('rebar3 compile', dir, 120_000)
      if (!res.failed) {
        let rebarEntries = parseErlang(res.stdout + '\n' + res.stderr, 'rebar3')
        if (files && files.length > 0) rebarEntries = filterEntriesByFiles(rebarEntries, dir, files)
        entries.push(...rebarEntries)
      }
      return { entries }
    }

    // 2. Fallback: erlc (per-file compile)
    if (files && files.length > 0 && await isCommandAvailable('erlc --version')) {
      for (const f of files) {
        const fp = resolve(dir, f)
        const res = await runDiagnosticCommand(`erlc "${fp}"`, dir, 30_000)
        entries.push(...parseErlang(res.stderr + '\n' + res.stdout, 'erlc'))
      }
      return { entries, note: 'rebar3 not found — used erlc (per-file compile)' }
    }

    // 3. No files + no rebar3 — пробуем erlc на .erl файлах в корне
    if ((!files || files.length === 0) && await isCommandAvailable('erlc --version')) {
      return { entries: [], note: 'rebar3 not installed and no files specified — Erlang diagnostics skipped' }
    }

    return {
      entries: [],
      note: 'rebar3/erlc not installed — Erlang diagnostics skipped',
    }
  },
}
