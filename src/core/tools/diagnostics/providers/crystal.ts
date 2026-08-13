// ── Crystal провайдер: crystal build --no-codegen ──

import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { filterEntriesByFiles } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// crystal build: "file.cr:line:col: Error: message"
// или "file.cr:line:col: Warning: message"
const CRYSTAL_RE = /^(.+?):(\d+):(\d+):\s+(Error|Warning):\s+(.+)$/

function parseCrystal(output: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(CRYSTAL_RE)
    if (!m) continue
    const [, file, lineNum, col, level, message] = m
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      col: Number(col),
      severity: level === 'Error' ? 'error' : 'warning',
      message: message.trim(),
      source: 'crystal-build',
    })
  }
  return entries
}

export const crystalProvider: DiagnosticProvider = {
  name: 'crystal',

  detect(dir) {
    return existsSync(join(dir, 'shard.yml'))
  },

  async run(dir, files?) {
    if (!await isCommandAvailable('crystal --version')) {
      return { entries: [], note: 'crystal not installed — Crystal diagnostics skipped' }
    }

    const entries: DiagnosticEntry[] = []

    const cmd = files && files.length > 0
      ? `crystal build --no-codegen ${files.map((f) => `"${resolve(dir, f)}"`).join(' ')}`
      : 'crystal build --no-codegen src/*.cr'
    const res = await runDiagnosticCommand(cmd, dir, 120_000)
    if (res.failed) {
      // crystal build возвращает exit!=0 при ошибках — но failed=true значит
      // команда не запустилась (not installed, timeout). Если есть stderr — парсим.
      if (!res.stderr && !res.stdout) {
        return { entries: [], failed: res.failureReason }
      }
    }

    let crystalEntries = parseCrystal(res.stderr + '\n' + res.stdout)
    if (files && files.length > 0) {
      crystalEntries = filterEntriesByFiles(crystalEntries, dir, files)
    }
    entries.push(...crystalEntries)

    return { entries }
  },
}
