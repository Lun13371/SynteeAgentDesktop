// ── C# / .NET провайдер: dotnet build + dotnet format ──

import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasFileMatching, filterEntriesByFiles } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// MSBuild: "path/file.cs(line,col): error CS0000: message"
//          "path/file.cs(line,col): warning CS0000: message"
const MSBUILD_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(.+?):\s*(.+)$/

function parseMsbuild(output: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(MSBUILD_RE)
    if (!m) continue
    const [, file, lineNum, col, severity, code, message] = m
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      col: Number(col),
      severity: severity as 'error' | 'warning',
      message: `${code}: ${message.trim()}`,
      source: 'dotnet',
    })
  }
  return entries
}

export const dotnetProvider: DiagnosticProvider = {
  name: 'dotnet',

  detect(dir) {
    return hasFileMatching(dir, ['.csproj', '.sln', '.fsproj'])
  },

  async run(dir, files?) {
    const entries: DiagnosticEntry[] = []
    const failures: string[] = []

    // 1. dotnet build (без restore для скорости)
    const buildRes = await runDiagnosticCommand(
      'dotnet build --no-restore --nologo',
      dir,
      180_000,
    )
    if (buildRes.failed) {
      failures.push(`dotnet build: ${buildRes.failureReason}`)
    } else {
      let buildEntries = parseMsbuild(buildRes.stdout + '\n' + buildRes.stderr)
      if (files && files.length > 0) buildEntries = filterEntriesByFiles(buildEntries, dir, files)
      entries.push(...buildEntries)
    }

    // 2. dotnet format (если доступен)
    if (await isCommandAvailable('dotnet format --version')) {
      const fmtRes = await runDiagnosticCommand(
        'dotnet format --verify-no-changes --no-restore --severity warn',
        dir,
        120_000,
      )
      if (!fmtRes.failed) {
        let fmtEntries = parseMsbuild(fmtRes.stdout + '\n' + fmtRes.stderr)
        fmtEntries = fmtEntries.map((e) => ({ ...e, source: 'dotnet-format' }))
        if (files && files.length > 0) fmtEntries = filterEntriesByFiles(fmtEntries, dir, files)
        entries.push(...fmtEntries)
      }
    }

    return {
      entries,
      failed: failures.length > 0 ? failures.join('; ') : undefined,
    }
  },
}
