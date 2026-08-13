// ── PHP провайдер: phpstan → psalm → php -l (каскад) ──

import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasAnyMarker } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// phpstan JSON: { totals: { errors: N }, files: { "path": { messages: [{ message, line, ignorable }] } }
function parsePhpstanJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  try {
    const data = JSON.parse(stdout)
    for (const [file, info] of Object.entries(data.files || {})) {
      for (const msg of (info as any).messages || []) {
        entries.push({
          file,
          line: msg.line ?? 0,
          severity: 'error',
          message: msg.message || '',
          source: 'phpstan',
        })
      }
    }
  } catch { /* not JSON */ }
  return entries
}

// psalm JSON: [{ file_path, line_from, severity, message, snippet }]
function parsePsalmJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  try {
    const data = JSON.parse(stdout)
    for (const item of data) {
      entries.push({
        file: item.file_path || '',
        line: item.line_from ?? 0,
        severity: item.severity === 'error' ? 'error' : 'warning',
        message: item.message || '',
        source: 'psalm',
      })
    }
  } catch { /* not JSON */ }
  return entries
}

// php -l: "PHP Parse error: ... in /path/file.php on line N"
const PHP_L_RE = /in\s+(.+?)\s+on\s+line\s+(\d+)/i
function parsePhpLint(stderr: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of stderr.split('\n')) {
    if (!line.toLowerCase().includes('error')) continue
    const m = line.match(PHP_L_RE)
    if (m) {
      entries.push({
        file: m[1].trim(),
        line: Number(m[2]),
        severity: 'error',
        message: line.replace(/PHP\s+(Parse|Fatal)\s+error:\s*/i, '').trim(),
        source: 'php-lint',
      })
    }
  }
  return entries
}

export const phpProvider: DiagnosticProvider = {
  name: 'php',

  detect(dir) {
    return hasAnyMarker(dir, ['composer.json', 'artisan', 'index.php', 'phpstan.neon', 'phpstan.neon.dist', 'psalm.xml'])
  },

  async run(dir, files?) {
    const fileArgs = files && files.length > 0
      ? ' ' + files.map((f) => `"${resolve(dir, f)}"`).join(' ')
      : ' .'

    // 1. phpstan (если конфиг есть или vendor/bin/phpstan доступен)
    const phpstanBin = existsSync(join(dir, 'vendor/bin/phpstan')) ? 'vendor/bin/phpstan' : 'phpstan'
    if (await isCommandAvailable(`${phpstanBin} --version`)) {
      const cmd = `${phpstanBin} analyse --error-format=json${files && files.length > 0 ? ' ' + files.map((f) => `"${resolve(dir, f)}"`).join(' ') : ''}`
      const res = await runDiagnosticCommand(cmd, dir, 120_000)
      if (!res.failed) {
        return { entries: parsePhpstanJson(res.stdout) }
      }
    }

    // 2. psalm
    const psalmBin = existsSync(join(dir, 'vendor/bin/psalm')) ? 'vendor/bin/psalm' : 'psalm'
    if (await isCommandAvailable(`${psalmBin} --version`)) {
      const cmd = `${psalmBin} --output-format=json${fileArgs}`
      const res = await runDiagnosticCommand(cmd, dir, 120_000)
      if (!res.failed) {
        return { entries: parsePsalmJson(res.stdout) }
      }
    }

    // 3. Fallback: php -l (per-file syntax check)
    if (files && files.length > 0) {
      const entries: DiagnosticEntry[] = []
      for (const f of files) {
        const fp = resolve(dir, f)
        const res = await runDiagnosticCommand(`php -l "${fp}"`, dir, 30_000)
        entries.push(...parsePhpLint(res.stderr + '\n' + res.stdout))
      }
      return { entries, note: 'phpstan/psalm not found — used php -l (syntax check only)' }
    }

    return {
      entries: [],
      note: 'phpstan/psalm not installed — PHP diagnostics skipped. Install: composer require phpstan/phpstan',
    }
  },
}
