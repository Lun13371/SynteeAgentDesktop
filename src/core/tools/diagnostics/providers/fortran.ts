// ── Fortran провайдер: gfortran -fsyntax-only (per-file) ──

import { readdirSync } from 'fs'
import { resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasFileMatching } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

const FORTRAN_EXTS = ['.f90', '.f', '.f95', '.f03', '.f08', '.for', '.f77']

// gfortran имеет два формата вывода:
//   1. Однострочный: "file.f90:line:col: Error: message"
//   2. Многострочный: "file.f90:line:col:" затем код, затем "Error: message"
function parseGfortran(output: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  let curFile = ''
  let curLine = 0
  let curCol: number | undefined

  for (const line of output.split('\n')) {
    // Однострочный: file:line:col: Error: message
    const single = line.match(/^(.+?):(\d+):(\d+):\s+(Error|Warning|Fatal):\s*(.+)$/i)
    if (single) {
      const [, file, lineNum, col, severity, message] = single
      entries.push({
        file: file.trim(),
        line: Number(lineNum),
        col: Number(col),
        severity: severity.toLowerCase() === 'warning' ? 'warning' : 'error',
        message: message.trim(),
        source: 'gfortran',
      })
      curFile = ''
      continue
    }

    // Многострочный: заголовок локации "file.f90:line:col:"
    const loc = line.match(/^(.+?):(\d+):(\d+):$/)
    if (loc) {
      curFile = loc[1].trim()
      curLine = Number(loc[2])
      curCol = Number(loc[3])
      continue
    }

    // Строка с Error/Warning (после заголовка локации)
    const msg = line.match(/^(Error|Warning|Fatal):\s*(.+)$/i)
    if (msg && curFile) {
      entries.push({
        file: curFile,
        line: curLine,
        col: curCol,
        severity: msg[1].toLowerCase() === 'warning' ? 'warning' : 'error',
        message: msg[2].trim(),
        source: 'gfortran',
      })
    }
  }
  return entries
}

export const fortranProvider: DiagnosticProvider = {
  name: 'fortran',

  detect(dir) {
    return hasFileMatching(dir, FORTRAN_EXTS)
  },

  async run(dir, files?) {
    const hasGfortran = await isCommandAvailable('gfortran --version')
    if (!hasGfortran) {
      return { entries: [], note: 'gfortran not installed — Fortran diagnostics skipped' }
    }

    // Если files не передан — ищем Fortran файлы в корне
    let targetFiles = files && files.length > 0 ? files : []
    if (targetFiles.length === 0) {
      try {
        targetFiles = readdirSync(dir)
          .filter((f) => FORTRAN_EXTS.some((ext) => f.endsWith(ext)))
      } catch { /* dir not readable */ }
    }
    if (targetFiles.length === 0) {
      return { entries: [], note: 'no Fortran source files found' }
    }

    // gfortran -fsyntax-only (per-file)
    const entries: DiagnosticEntry[] = []
    for (const f of targetFiles) {
      const fp = resolve(dir, f)
      const res = await runDiagnosticCommand(
        `gfortran -fsyntax-only -Wall "${fp}"`,
        dir, 30_000,
      )
      entries.push(...parseGfortran(res.stderr + '\n' + res.stdout))
    }

    return { entries }
  },
}
