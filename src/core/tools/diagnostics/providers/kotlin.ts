// ── Kotlin провайдер: Gradle compileKotlin → kotlinc → ktlint ──

import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasFileMatching, filterEntriesByFiles } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// Kotlin Gradle plugin: "e: file.kt: (12, 5): message" (e=error, w=warning)
const KOTLIN_GRADLE_RE = /^([ew]):\s+(.+?):\s*\((\d+),\s*(\d+)\):\s*(.+)$/
// Standard kotlinc: "file.kt:12:5: error: message"
const KOTLINC_RE = /^(.+?):(\d+):(\d+):\s*(error|warning):\s*(.+)$/

function parseKotlinGradle(output: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(KOTLIN_GRADLE_RE)
    if (!m) continue
    const [, level, file, lineNum, col, message] = m
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      col: Number(col),
      severity: level === 'w' ? 'warning' : 'error',
      message: message.trim(),
      source: 'kotlin-gradle',
    })
  }
  return entries
}

function parseKotlinc(output: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(KOTLINC_RE)
    if (!m) continue
    const [, file, lineNum, col, severity, message] = m
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      col: Number(col),
      severity: severity as 'error' | 'warning',
      message: message.trim(),
      source: 'kotlinc',
    })
  }
  return entries
}

// ktlint JSON: [{ file, errors: [{ line, column, rule, message }] }]
function parseKtlintJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  try {
    const data = JSON.parse(stdout)
    for (const item of data) {
      const file = item.file || ''
      for (const err of item.errors || []) {
        entries.push({
          file,
          line: err.line ?? 0,
          col: err.column,
          severity: 'warning',
          message: `[${err.rule || 'ktlint'}] ${err.message || ''}`.trim(),
          source: 'ktlint',
        })
      }
    }
  } catch { /* not JSON */ }
  return entries
}

export const kotlinProvider: DiagnosticProvider = {
  name: 'kotlin',

  detect(dir) {
    return hasFileMatching(dir, ['.kt']) ||
      existsSync(join(dir, 'build.gradle.kts')) ||
      existsSync(join(dir, 'settings.gradle.kts'))
  },

  async run(dir, files?) {
    const entries: DiagnosticEntry[] = []
    const failures: string[] = []

    const hasGradlew = existsSync(join(dir, 'gradlew')) || existsSync(join(dir, 'gradlew.bat'))
    const hasGradleKts = existsSync(join(dir, 'build.gradle.kts')) || existsSync(join(dir, 'build.gradle'))

    // 1. Gradle compileKotlin
    if (hasGradlew || hasGradleKts) {
      const gradlew = process.platform === 'win32'
        ? (existsSync(join(dir, 'gradlew.bat')) ? '.\\gradlew.bat' : 'gradlew.bat')
        : './gradlew'
      const res = await runDiagnosticCommand(
        `${gradlew} compileKotlin --quiet`,
        dir, 180_000,
      )
      if (res.failed) {
        // Пробуем системный gradle
        const res2 = await runDiagnosticCommand('gradle compileKotlin --quiet', dir, 180_000)
        if (res2.failed) {
          failures.push(`gradle: ${res2.failureReason}`)
        } else {
          let gradleEntries = parseKotlinGradle(res2.stdout + '\n' + res2.stderr)
          if (files && files.length > 0) gradleEntries = filterEntriesByFiles(gradleEntries, dir, files)
          entries.push(...gradleEntries)
        }
      } else {
        let gradleEntries = parseKotlinGradle(res.stdout + '\n' + res.stderr)
        if (files && files.length > 0) gradleEntries = filterEntriesByFiles(gradleEntries, dir, files)
        entries.push(...gradleEntries)
      }
    }

    // 2. kotlinc (per-file syntax check, если нет gradle или как дополнение)
    if (!hasGradlew && !hasGradleKts && files && files.length > 0 && await isCommandAvailable('kotlinc -version')) {
      for (const f of files) {
        if (!f.endsWith('.kt')) continue
        const fp = resolve(dir, f)
        const res = await runDiagnosticCommand(
          `kotlinc "${fp}" -d "${join(dir, '.tmp-kotlinc-out')}" -no-stdlib -no-reflect`,
          dir, 60_000,
        )
        entries.push(...parseKotlinc(res.stderr + '\n' + res.stdout))
      }
    }

    // 3. ktlint (formatting + lint, file-level)
    if (files && files.length > 0 && await isCommandAvailable('ktlint --version')) {
      const ktFiles = files.filter((f) => f.endsWith('.kt'))
      if (ktFiles.length > 0) {
        const cmd = `ktlint --report=json ${ktFiles.map((f) => `"${resolve(dir, f)}"`).join(' ')}`
        const res = await runDiagnosticCommand(cmd, dir, 60_000)
        if (!res.failed) {
          let ktlintEntries = parseKtlintJson(res.stdout)
          if (files && files.length > 0) ktlintEntries = filterEntriesByFiles(ktlintEntries, dir, files)
          entries.push(...ktlintEntries)
        }
      }
    }

    if (entries.length === 0 && failures.length === 0) {
      const hasGradle = hasGradlew || hasGradleKts
      const hasKotlinc = await isCommandAvailable('kotlinc -version')
      const hasKtlint = await isCommandAvailable('ktlint --version')
      if (!hasGradle && !hasKotlinc && !hasKtlint) {
        return { entries: [], note: 'gradle, kotlinc and ktlint not installed — Kotlin diagnostics skipped' }
      }
    }

    return {
      entries,
      failed: failures.length > 0 ? failures.join('; ') : undefined,
    }
  },
}
