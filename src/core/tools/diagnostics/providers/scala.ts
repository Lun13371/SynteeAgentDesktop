// ── Scala провайдер: sbt compile + scalafmt ──

import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasAnyMarker, filterEntriesByFiles } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// sbt: "[error] path/file.scala:12:5: message"
const SBT_RE = /^\[(error|warn)\]\s+(.+?):(\d+)(?::(\d+))?:\s*(.+)$/

function parseSbt(output: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(SBT_RE)
    if (!m) continue
    const [, level, file, lineNum, col, message] = m
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      col: col ? Number(col) : undefined,
      severity: level === 'error' ? 'error' : 'warning',
      message: message.trim(),
      source: 'sbt',
    })
  }
  return entries
}

export const scalaProvider: DiagnosticProvider = {
  name: 'scala',

  detect(dir) {
    return hasAnyMarker(dir, ['build.sbt', 'build.sc']) || existsSync(join(dir, 'project', 'build.properties'))
  },

  async run(dir, files?) {
    const entries: DiagnosticEntry[] = []
    const failures: string[] = []

    // 1. sbt compile
    const sbtBin = existsSync(join(dir, 'sbt')) || existsSync(join(dir, 'sbt.bat'))
      ? (process.platform === 'win32' ? 'sbt.bat' : './sbt')
      : 'sbt'

    const res = await runDiagnosticCommand(`${sbtBin} compile`, dir, 180_000)
    if (res.failed) {
      failures.push(`sbt: ${res.failureReason}`)
    } else {
      let sbtEntries = parseSbt(res.stdout + '\n' + res.stderr)
      if (files && files.length > 0) sbtEntries = filterEntriesByFiles(sbtEntries, dir, files)
      entries.push(...sbtEntries)
    }

    // 2. scalafmt (если .scalafmt.conf есть и scalafmt доступен)
    if (existsSync(join(dir, '.scalafmt.conf')) && await isCommandAvailable('scalafmt --version')) {
      const cmd = files && files.length > 0
        ? `scalafmt --test ${files.map((f) => `"${resolve(dir, f)}"`).join(' ')}`
        : 'scalafmt --test .'
      const fmtRes = await runDiagnosticCommand(cmd, dir, 60_000)
      if (!fmtRes.failed && fmtRes.stdout) {
        // scalafmt --test выводит имена файлов, которые не отформатированы
        for (const line of fmtRes.stdout.split('\n')) {
          if (line.trim() && !line.includes('All files are formatted')) {
            entries.push({
              file: line.trim(),
              line: 1,
              severity: 'warning',
              message: 'file is not scalafmt-compliant',
              source: 'scalafmt',
            })
          }
        }
      }
    }

    return {
      entries,
      failed: failures.length > 0 ? failures.join('; ') : undefined,
    }
  },
}
