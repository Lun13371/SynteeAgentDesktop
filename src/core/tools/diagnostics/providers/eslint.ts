// ── ESLint провайдер ──
// Перенесён из diagnostics.ts:36-69, 193-200.
// Поддерживает file-level: если files передан, запускает eslint на конкретных файлах.

import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { runDiagnosticCommand } from '../runner'
import type { DiagnosticProvider, DiagnosticEntry, ProviderRunResult } from '../types'

interface EslintJsonMessage {
  line: number
  column: number
  severity: 1 | 2
  message: string
  ruleId?: string | null
}
interface EslintJsonFile {
  filePath: string
  messages: EslintJsonMessage[]
}

function parseEslintOutput(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  let parsed: EslintJsonFile[]
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return entries
  }
  for (const file of parsed) {
    for (const msg of file.messages) {
      entries.push({
        file: file.filePath,
        line: msg.line,
        col: msg.column,
        severity: msg.severity === 2 ? 'error' : 'warning',
        message: msg.ruleId ? `${msg.ruleId}: ${msg.message}` : msg.message,
        source: 'eslint',
      })
    }
  }
  return entries
}

export const eslintProvider: DiagnosticProvider = {
  name: 'eslint',

  detect(dir: string): boolean {
    return [
      'eslint.config.js',
      'eslint.config.mjs',
      'eslint.config.cjs',
      'eslint.config.ts',
    ].some((f) => existsSync(join(dir, f)))
  },

  async run(dir: string, files?: string[]): Promise<ProviderRunResult> {
    // Если files передан — запускаем eslint на конкретных файлах
    let cmd: string
    if (files && files.length > 0) {
      // Нормализуем пути для командной строки
      const fileList = files.map((f) => `"${resolve(dir, f)}"`).join(' ')
      cmd = `npx eslint --format json ${fileList}`
    } else {
      cmd = 'npx eslint . --format json'
    }

    const res = await runDiagnosticCommand(cmd, dir)

    // Дополнительная проверка: eslint когда конфиг отсутствует пишет в stderr
    const stderrLower = (res.stderr || '').toLowerCase()
    const stdoutLower = (res.stdout || '').toLowerCase()
    if (
      !res.failed &&
      (stdoutLower.includes("couldn't find") ||
        stderrLower.includes("couldn't find") ||
        stderrLower.includes('no eslint config'))
    ) {
      return {
        entries: [],
        failed: 'eslint config not found — lint did not run',
      }
    }

    if (res.failed) {
      return { entries: [], failed: res.failureReason }
    }

    return { entries: parseEslintOutput(res.stdout) }
  },
}
