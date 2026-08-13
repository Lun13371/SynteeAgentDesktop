// ── Perl провайдер: perl -c (syntax) + perlcritic ──

import { resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasAnyMarker, hasFileMatching } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// perl -c stderr: "syntax error at file.pl line 5, near '...'"
// или "Missing right curly or square bracket at file.pl line 10"
// или "Can't find string terminator ... at file.pl line 1"
const PERL_ERR_RE = /at\s+(.+?)\s+line\s+(\d+)/

function parsePerlSyntax(output: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    // "syntax OK" — нет ошибок
    if (line.toLowerCase().includes('syntax ok')) continue
    const m = line.match(PERL_ERR_RE)
    if (m) {
      entries.push({
        file: m[1].trim(),
        line: Number(m[2]),
        severity: 'error',
        message: line.trim(),
        source: 'perl-syntax',
      })
    }
  }
  return entries
}

// perlcritic --json: [{ file, line, column, severity, policy, description }]
function parsePerlcriticJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  try {
    const data = JSON.parse(stdout)
    for (const item of data) {
      entries.push({
        file: item.file || '',
        line: item.line ?? 0,
        col: item.column,
        // perlcritic severity: 1..5 (5 — самый строгий); считаем >= 4 ошибкой
        severity: Number(item.severity) >= 4 ? 'error' : 'warning',
        message: item.policy
          ? `[${item.policy}] ${item.description || ''}`
          : (item.description || ''),
        source: 'perlcritic',
      })
    }
  } catch { /* not JSON */ }
  return entries
}

export const perlProvider: DiagnosticProvider = {
  name: 'perl',

  detect(dir) {
    return hasAnyMarker(dir, ['Makefile.PL', 'Build.PL', 'cpanfile', 'META.yml', 'META.json']) ||
      hasFileMatching(dir, ['.pl', '.pm'])
  },

  async run(dir, files?) {
    const hasPerl = await isCommandAvailable('perl --version')
    if (!hasPerl) {
      return { entries: [], note: 'perl not installed — Perl diagnostics skipped' }
    }

    // Если files не передан — без perlcritic (нужны конкретные файлы),
    // а perl -c на всём проекте не имеет смысла
    if (!files || files.length === 0) {
      return { entries: [], note: 'no files specified — Perl diagnostics requires file list' }
    }

    const entries: DiagnosticEntry[] = []

    // 1. perl -c (per-file syntax check)
    for (const f of files) {
      const fp = resolve(dir, f)
      const res = await runDiagnosticCommand(`perl -c "${fp}"`, dir, 15_000)
      // perl -c пишет результат в stderr
      entries.push(...parsePerlSyntax(res.stderr + '\n' + res.stdout))
    }

    // 2. perlcritic (если доступен) — lint/стиль
    if (await isCommandAvailable('perlcritic --version')) {
      const fileList = files.map((f) => `"${resolve(dir, f)}"`).join(' ')
      const res = await runDiagnosticCommand(
        `perlcritic --json ${fileList}`,
        dir, 60_000,
      )
      if (!res.failed) {
        entries.push(...parsePerlcriticJson(res.stdout))
      }
    }

    return { entries }
  },
}
