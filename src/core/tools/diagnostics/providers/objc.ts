// ── Objective-C провайдер: cmake build → clang -fsyntax-only ──

import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasFileMatching, filterEntriesByFiles } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// clang/gcc format: "file.m:line:col: error: message" или "file.m:line: error: message"
const GCC_RE = /^(.+?):(\d+):(?:(\d+):)?\s+(error|warning):\s*(.+)$/

function parseGccFormat(output: string, source: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(GCC_RE)
    if (!m) continue
    const [, file, lineNum, col, severity, message] = m
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      col: col ? Number(col) : undefined,
      severity: severity as 'error' | 'warning',
      message: message.trim(),
      source,
    })
  }
  return entries
}

export const objcProvider: DiagnosticProvider = {
  name: 'objc',

  detect(dir) {
    // Исключаем Swift-проекты (Package.swift → это Swift, не ObjC)
    if (existsSync(join(dir, 'Package.swift'))) return false
    // .xcodeproj — это директория, readdirSync её видит
    return hasFileMatching(dir, ['.xcodeproj', '.m', '.mm']) ||
      existsSync(join(dir, 'Podfile'))
  },

  async run(dir, files?) {
    const entries: DiagnosticEntry[] = []
    const notes: string[] = []

    // 1. Если есть build/ и CMakeLists.txt — cmake --build build
    if (existsSync(join(dir, 'build')) && existsSync(join(dir, 'CMakeLists.txt'))) {
      const res = await runDiagnosticCommand('cmake --build build', dir, 180_000)
      if (!res.failed) {
        let buildEntries = parseGccFormat(res.stdout + '\n' + res.stderr, 'cmake-objc')
        if (files && files.length > 0) buildEntries = filterEntriesByFiles(buildEntries, dir, files)
        entries.push(...buildEntries)
      }
    }

    // 2. clang -fsyntax-only -fobjc-arc (per-file syntax check)
    const hasClang = await isCommandAvailable('clang --version')
    if (hasClang && files && files.length > 0) {
      for (const f of files) {
        const fp = resolve(dir, f)
        const res = await runDiagnosticCommand(
          `clang -fsyntax-only -fobjc-arc "${fp}"`,
          dir, 30_000,
        )
        entries.push(...parseGccFormat(res.stderr, 'clang-objc'))
      }
    } else if (!hasClang) {
      notes.push('clang not installed — Objective-C syntax check skipped')
    } else if (!files || files.length === 0) {
      notes.push('no files specified — clang per-file syntax check skipped')
    }

    return { entries, note: notes.length > 0 ? notes.join('; ') : undefined }
  },
}
