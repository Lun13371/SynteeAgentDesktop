// ── Julia провайдер: StaticAnalyzer → julia include fallback ──

import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasAnyMarker, hasFileMatching } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// Julia syntax/load errors:
//   ERROR: LoadError: syntax: incomplete: premature end of input
//   in expression starting at /path/to/file.jl:5
// или:
//   ERROR: LoadError: MethodError: ...
//   in expression starting at /path/to/file.jl:10
const JULIA_ERR_RE = /^ERROR:\s*LoadError:\s*(.+)$/
const JULIA_LOC_RE = /in expression starting at\s+(.+?):(\d+)/

function parseJuliaSyntax(output: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  const lines = output.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const errMatch = lines[i].match(JULIA_ERR_RE)
    if (!errMatch) continue
    const message = errMatch[1].trim()
    // Ищем file:line в следующих строках
    let file = ''
    let lineNum = 0
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const locMatch = lines[j].match(JULIA_LOC_RE)
      if (locMatch) {
        file = locMatch[1].trim()
        lineNum = Number(locMatch[2])
        break
      }
    }
    entries.push({
      file,
      line: lineNum,
      severity: 'error',
      message,
      source: 'julia-syntax',
    })
  }
  return entries
}

export const juliaProvider: DiagnosticProvider = {
  name: 'julia',

  detect(dir) {
    return hasAnyMarker(dir, ['Project.toml', 'Manifest.toml']) ||
      hasFileMatching(dir, ['.jl'])
  },

  async run(dir, files?) {
    const hasJulia = await isCommandAvailable('julia --version')
    if (!hasJulia) {
      return { entries: [], note: 'julia not installed — Julia diagnostics skipped' }
    }

    // 1. StaticAnalyzer.jl (если установлен в проекте)
    // Проверяем доступность пакета без запуска самой проверки
    if (existsSync(join(dir, 'Project.toml'))) {
      const saCheck = await runDiagnosticCommand(
        `julia --project=. -e 'using StaticAnalyzer; exit(0)'`,
        dir, 60_000,
      )
      if (!saCheck.failed && !saCheck.stderr.toLowerCase().includes('error') &&
          !saCheck.stderr.toLowerCase().includes('argument')) {
        // StaticAnalyzer доступен — запускаем проверку
        if (files && files.length > 0) {
          const fileList = files.map((f) => `"${resolve(dir, f)}"`).join(', ')
          const saRes = await runDiagnosticCommand(
            `julia --project=. -e 'using StaticAnalyzer; check_files(${fileList})'`,
            dir, 120_000,
          )
          if (!saRes.failed) {
            return { entries: parseJuliaSyntax(saRes.stderr + '\n' + saRes.stdout) }
          }
        }
      }
    }

    // 2. Fallback: julia --compile=min -e 'include("file.jl")' per-file (syntax only)
    if (files && files.length > 0) {
      const entries: DiagnosticEntry[] = []
      for (const f of files) {
        const fp = resolve(dir, f).replace(/\\/g, '/')
        const res = await runDiagnosticCommand(
          `julia --compile=min -e 'include("${fp}")'`,
          dir, 30_000,
        )
        const out = res.stderr + '\n' + res.stdout
        entries.push(...parseJuliaSyntax(out))
      }
      return { entries, note: 'used julia include (syntax check only)' }
    }

    return {
      entries: [],
      note: 'no files specified — Julia diagnostics requires file list',
    }
  },
}
