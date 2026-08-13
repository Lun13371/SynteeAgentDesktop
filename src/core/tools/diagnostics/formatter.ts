// ── Универсальный форматтер вывода диагностики ──
// Перенесён из diagnostics.ts:202-226, обобщён для любого набора провайдеров.

import { smartTrimOutput } from '../_shared'
import type { DiagnosticEntry } from './types'

export interface FormatInput {
  entries: DiagnosticEntry[]
  failures: string[]
  notes: string[]
  detectedProviders: string[]
}

export function formatDiagnosticsOutput({
  entries,
  failures,
  notes,
  detectedProviders,
}: FormatInput): { success: boolean; output: string } {
  entries.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)

  const errorCount = entries.filter((e) => e.severity === 'error').length
  const warningCount = entries.filter((e) => e.severity === 'warning').length

  // Если диагностические команды упали — это НЕ «no errors found».
  // success=false: проверка не выполнилась, нельзя доверять «всё чисто».
  if (failures.length > 0) {
    const failLines = failures.map((f) => `⚠ DIAGNOSTICS FAILURE: ${f}`)
    const detectedLine =
      detectedProviders.length > 0
        ? `Detected stacks: ${detectedProviders.join(', ')}`
        : ''
    const partialResults =
      entries.length > 0
        ? [
            '',
            `Partial results (from commands that ran): ${errorCount} errors, ${warningCount} warnings:`,
            ...entries.map(
              (e) =>
                `[${e.source}] ${e.severity === 'error' ? 'ERROR' : 'WARN'} ${e.file}:${e.line}${e.col ? ':' + e.col : ''} — ${e.message}`,
            ),
          ]
        : []
    const body = [
      `${failures.length} diagnostic command(s) failed — the check DID NOT run completely. Cannot claim the project is clean.`,
      detectedLine,
      ...failLines,
      '',
      ...notes,
      ...partialResults,
    ]
      .filter(Boolean)
      .join('\n')
    return { success: false, output: smartTrimOutput(body, 8000) }
  }

  if (entries.length === 0) {
    const stackInfo =
      detectedProviders.length > 0 ? ` Checked stacks: ${detectedProviders.join(', ')}.` : ''
    const okMsg = notes.length
      ? `No errors found.${stackInfo}\n${notes.join('\n')}`
      : `No errors found. The project compiles and lints cleanly.${stackInfo}`
    return { success: true, output: okMsg }
  }

  const lines = entries.map(
    (e) =>
      `[${e.source}] ${e.severity === 'error' ? 'ERROR' : 'WARN'} ${e.file}:${e.line}${e.col ? ':' + e.col : ''} — ${e.message}`,
  )
  const header = `Found ${errorCount} errors, ${warningCount} warnings:`
  const body = smartTrimOutput([header, ...notes, ...lines].join('\n'), 8000)
  return { success: errorCount === 0, output: body }
}
