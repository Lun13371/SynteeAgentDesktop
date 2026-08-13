// ── Java / Kotlin провайдер: Maven (mvn) или Gradle ──

import { existsSync } from 'fs'
import { join } from 'path'
import { runDiagnosticCommand } from '../runner'
import { filterEntriesByFiles } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// Maven: "[ERROR] path/file.java:[12,13] message"
const MAVEN_RE = /^\[ERROR\]\s+(.+?):\[(\d+),(\d+)\]\s+(.+)$/
// Gradle: "path/file.java:12: error: message" или e: "path/file.java:12: warning: message"
const GRADLE_RE = /^(.+?):(\d+):\s+(error|warning):\s*(.+)$/

function parseMaven(output: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(MAVEN_RE)
    if (!m) continue
    const [, file, lineNum, col, message] = m
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      col: Number(col),
      severity: 'error',
      message: message.trim(),
      source: 'maven',
    })
  }
  return entries
}

function parseGradle(output: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(GRADLE_RE)
    if (!m) continue
    const [, file, lineNum, severity, message] = m
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      severity: severity as 'error' | 'warning',
      message: message.trim(),
      source: 'gradle',
    })
  }
  return entries
}

export const javaProvider: DiagnosticProvider = {
  name: 'java',

  detect(dir) {
    return existsSync(join(dir, 'pom.xml')) ||
      existsSync(join(dir, 'build.gradle')) ||
      existsSync(join(dir, 'build.gradle.kts'))
  },

  async run(dir, files?) {
    const isMaven = existsSync(join(dir, 'pom.xml'))
    const isGradle = existsSync(join(dir, 'build.gradle')) || existsSync(join(dir, 'build.gradle.kts'))

    const entries: DiagnosticEntry[] = []
    const failures: string[] = []

    if (isMaven) {
      const res = await runDiagnosticCommand('mvn compile -q -o', dir, 180_000)
      if (res.failed) {
        // Maven offline mode может не работать — пробуем online
        const res2 = await runDiagnosticCommand('mvn compile -q', dir, 180_000)
        if (res2.failed) {
          failures.push(`maven: ${res2.failureReason}`)
        } else {
          let mavenEntries = parseMaven(res2.stdout + '\n' + res2.stderr)
          if (files && files.length > 0) mavenEntries = filterEntriesByFiles(mavenEntries, dir, files)
          entries.push(...mavenEntries)
        }
      } else {
        let mavenEntries = parseMaven(res.stdout + '\n' + res.stderr)
        if (files && files.length > 0) mavenEntries = filterEntriesByFiles(mavenEntries, dir, files)
        entries.push(...mavenEntries)
      }
    } else if (isGradle) {
      const gradlew = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew'
      const res = await runDiagnosticCommand(`${gradlew} compileJava --quiet`, dir, 180_000)
      if (res.failed) {
        // Пробуем системный gradle
        const res2 = await runDiagnosticCommand('gradle compileJava --quiet', dir, 180_000)
        if (res2.failed) {
          failures.push(`gradle: ${res2.failureReason}`)
        } else {
          let gradleEntries = parseGradle(res2.stdout + '\n' + res2.stderr)
          if (files && files.length > 0) gradleEntries = filterEntriesByFiles(gradleEntries, dir, files)
          entries.push(...gradleEntries)
        }
      } else {
        let gradleEntries = parseGradle(res.stdout + '\n' + res.stderr)
        if (files && files.length > 0) gradleEntries = filterEntriesByFiles(gradleEntries, dir, files)
        entries.push(...gradleEntries)
      }
    }

    return {
      entries,
      failed: failures.length > 0 ? failures.join('; ') : undefined,
    }
  },
}
