// ── R провайдер: lintr → R parse (syntax only) ──

import { resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasAnyMarker, hasFileMatching } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// lintr text output: "file.R:line:col: MESSAGE"
// MESSAGE often starts with style keyword: "style: ...", "warning: ...", "error: ..."
const LINTR_RE = /^(.+?):(\d+):(\d+):\s*(.+)$/

function parseLintr(output: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(LINTR_RE)
    if (!m) continue
    const [, file, lineNum, col, rest] = m
    const lower = rest.toLowerCase()
    let severity: 'error' | 'warning' = 'warning'
    let message = rest
    if (lower.startsWith('error')) {
      severity = 'error'
      message = rest.replace(/^error[:\s]+/i, '')
    } else if (lower.startsWith('warning')) {
      severity = 'warning'
      message = rest.replace(/^warning[:\s]+/i, '')
    } else if (lower.startsWith('style')) {
      severity = 'warning'
      message = rest.replace(/^style[:\s]+/i, '')
    }
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      col: Number(col),
      severity,
      message: message.trim(),
      source: 'lintr',
    })
  }
  return entries
}

// R parse error: "Error in parse("file.R") : <message>"
// или "file.R:line:col: message"
const R_PARSE_RE = /^(?:Error in parse\(["'](.+?)["']\)\s*:\s*|(.+?):(\d+):(\d+):\s*)(.+)$/

function parseRParseError(output: string, file: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(R_PARSE_RE)
    if (!m) continue
    if (m[1]) {
      // "Error in parse("file.R") : message"
      entries.push({
        file,
        line: 0,
        severity: 'error',
        message: m[5].trim(),
        source: 'r-parse',
      })
    } else {
      // "file.R:line:col: message"
      entries.push({
        file: m[2].trim(),
        line: Number(m[3]),
        col: Number(m[4]),
        severity: 'error',
        message: m[5].trim(),
        source: 'r-parse',
      })
    }
  }
  return entries
}

export const rProvider: DiagnosticProvider = {
  name: 'r',

  detect(dir) {
    return hasAnyMarker(dir, ['DESCRIPTION', 'renv.lock', '.Rprofile']) ||
      hasFileMatching(dir, ['.Rproj', '.R'])
  },

  async run(dir, files?) {
    const entries: DiagnosticEntry[] = []

    const rAvailable = await isCommandAvailable('R --version')
    if (!rAvailable) {
      return { entries: [], note: 'R not installed — R diagnostics skipped' }
    }

    // 1. lintr (если доступен)
    const lintrAvailable = await isCommandAvailable('R -e "library(lintr)"')
    if (lintrAvailable) {
      const cmd = files && files.length > 0
        ? `R -e "lintr::lint(c(${files.map((f) => `'${resolve(dir, f)}'`).join(',')}))"`
        : `R -e "lintr::lint_dir('.')"`
      const res = await runDiagnosticCommand(cmd, dir, 120_000)
      if (!res.failed) {
        let lintrEntries = parseLintr(res.stdout + '\n' + res.stderr)
        if (files && files.length > 0) {
          // lintr уже запущен на конкретных файлах, но всё равно фильтруем
          lintrEntries = lintrEntries.filter((e) =>
            files.some((f) => e.file.endsWith(f) || resolve(dir, f).endsWith(e.file)),
          )
        }
        entries.push(...lintrEntries)
      }
      return { entries }
    }

    // 2. Fallback: R parse (per-file syntax only)
    if (files && files.length > 0) {
      for (const f of files) {
        if (!f.endsWith('.R') && !f.endsWith('.r')) continue
        const fp = resolve(dir, f)
        const res = await runDiagnosticCommand(
          `R -e "parse('${fp}')"`,
          dir, 30_000,
        )
        if (res.stderr || res.stdout) {
          entries.push(...parseRParseError(res.stderr + '\n' + res.stdout, f))
        }
      }
    } else {
      // Без files — проверяем все .R файлы в корне
      const res = await runDiagnosticCommand(
        `R -e "files <- list.files('.', pattern='\\\\\\\\.R$', full.names=TRUE); for (f in files) { tryCatch(parse(f), error=function(e) cat(paste0(f, ':', conditionMessage(e), '\\\\n'), file=stderr())) }"`,
        dir, 60_000,
      )
      entries.push(...parseRParseError(res.stderr + '\n' + res.stdout, ''))
    }

    return { entries }
  },
}
