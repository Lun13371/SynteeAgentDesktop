// ── Swift провайдер: swift build + swiftlint ──

import { existsSync } from 'fs'
import { join } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { filterEntriesByFiles, hasFileMatching } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// swift build: "path/file.swift:12:5: error: message" или "warning: message"
const SWIFT_RE = /^(.+?):(\d+):(\d+):\s+(error|warning):\s*(.+)$/

function parseSwift(output: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(SWIFT_RE)
    if (!m) continue
    const [, file, lineNum, col, severity, message] = m
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      col: Number(col),
      severity: severity as 'error' | 'warning',
      message: message.trim(),
      source: 'swift-build',
    })
  }
  return entries
}

// swiftlint JSON: [{ file, line, character, severity, rule_id, type }]
function parseSwiftlintJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  try {
    const data = JSON.parse(stdout)
    for (const item of data) {
      entries.push({
        file: item.file || '',
        line: item.line ?? 0,
        col: item.character,
        severity: item.severity === 'error' ? 'error' : 'warning',
        message: item.rule_id ? `${item.rule_id}: ${item.type || ''}` : item.type || '',
        source: 'swiftlint',
      })
    }
  } catch { /* not JSON */ }
  return entries
}

export const swiftProvider: DiagnosticProvider = {
  name: 'swift',

  detect(dir) {
    return existsSync(join(dir, 'Package.swift')) ||
      hasFileMatching(dir, ['.xcodeproj', '.xcworkspace']) ||
      existsSync(join(dir, '.swiftlint.yml'))
  },

  async run(dir, files?) {
    const entries: DiagnosticEntry[] = []
    const notes: string[] = []

    // 1. swift build (если есть Package.swift)
    if (existsSync(join(dir, 'Package.swift'))) {
      const res = await runDiagnosticCommand('swift build', dir, 180_000)
      if (!res.failed) {
        let buildEntries = parseSwift(res.stdout + '\n' + res.stderr)
        if (files && files.length > 0) buildEntries = filterEntriesByFiles(buildEntries, dir, files)
        entries.push(...buildEntries)
      }
    } else {
      notes.push('Package.swift not found — swift build skipped (Xcode projects require xcodebuild)')
    }

    // 2. swiftlint (если доступен)
    if (await isCommandAvailable('swiftlint version')) {
      const cmd = files && files.length > 0
        ? `swiftlint lint --reporter json ${files.map((f) => `"${join(dir, f)}"`).join(' ')}`
        : 'swiftlint lint --reporter json'
      const res = await runDiagnosticCommand(cmd, dir, 60_000)
      if (!res.failed) {
        let lintEntries = parseSwiftlintJson(res.stdout)
        if (files && files.length > 0) lintEntries = filterEntriesByFiles(lintEntries, dir, files)
        entries.push(...lintEntries)
      }
    }

    return { entries, note: notes.length > 0 ? notes.join('; ') : undefined }
  },
}
