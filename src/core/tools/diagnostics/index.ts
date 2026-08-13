// ── Оркестратор диагностики: автоопределение стека + параллельный запуск ──
// Заменяет старый diagnostics.ts. Реэкспортирует getDiagnostics для barrel-модуля.

import { existsSync } from 'fs'
import { resolve } from 'path'
import { smartTrimOutput, type ToolResult } from '../_shared'
import { DIAGNOSTIC_PROVIDERS } from './providers'
import { formatDiagnosticsOutput } from './formatter'
import type { DiagnosticEntry } from './types'

/**
 * Универсальная диагностика проекта. Автоопределяет стек по файлам-маркерам,
 * запускает соответствующие type-checkers и linters для каждого найденного стека.
 *
 * @param cwd — директория проекта (по умолчанию process.cwd())
 * @param files — конкретные файлы для проверки (если undefined — весь проект)
 */
export async function getDiagnostics(
  cwd?: string,
  files?: string[],
): Promise<ToolResult> {
  const dir = cwd || process.cwd()
  if (!existsSync(dir)) {
    return { success: false, output: '', error: 'Directory not found: ' + dir }
  }

  // Нормализуем files (если переданы)
  const normalizedFiles = files && files.length > 0
    ? files.map((f) => resolve(dir, f))
    : undefined

  // Автоопределение: какие провайдеры применимы к проекту
  const applicableProviders = DIAGNOSTIC_PROVIDERS.filter((p) => p.detect(dir))

  if (applicableProviders.length === 0) {
    return {
      success: true,
      output:
        'No supported language toolchain detected in this project. ' +
        'Use run_command to run your project\'s linter/type-checker manually.',
    }
  }

  // Параллельный запуск всех применимых провайдеров
  const detectedNames: string[] = []
  const results = await Promise.allSettled(
    applicableProviders.map(async (p) => {
      detectedNames.push(p.name)
      return p.run(dir, normalizedFiles)
    }),
  )

  const allEntries: DiagnosticEntry[] = []
  const failures: string[] = []
  const notes: string[] = []

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const provider = applicableProviders[i]
    if (r.status === 'fulfilled') {
      if (r.value.failed) {
        failures.push(`${provider.name}: ${r.value.failed}`)
      }
      if (r.value.note) {
        notes.push(`[${provider.name}] ${r.value.note}`)
      }
      allEntries.push(...r.value.entries)
    } else {
      failures.push(`${provider.name}: crashed — ${r.reason}`)
    }
  }

  const { success, output } = formatDiagnosticsOutput({
    entries: allEntries,
    failures,
    notes,
    detectedProviders: detectedNames,
  })

  return { success, output: smartTrimOutput(output, 8000) }
}

// Re-export types for external consumers
export type { DiagnosticEntry, DiagnosticProvider } from './types'
