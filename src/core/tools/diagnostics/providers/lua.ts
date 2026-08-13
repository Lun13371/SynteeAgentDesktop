// ── Lua провайдер: luacheck → lua syntax fallback ──

import { resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasAnyMarker, hasFileMatching } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

// luacheck JSON: { files: [{ filename, warnings: [{ line, column, message, code }] }] }
function parseLuacheckJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  try {
    const data = JSON.parse(stdout)
    for (const file of data.files || []) {
      for (const w of file.warnings || []) {
        entries.push({
          file: file.filename || '',
          line: w.line ?? 0,
          col: w.column,
          severity: 'warning',
          message: w.code ? `${w.code}: ${w.message}` : w.message,
          source: 'luacheck',
        })
      }
    }
  } catch { /* not JSON */ }
  return entries
}

export const luaProvider: DiagnosticProvider = {
  name: 'lua',

  detect(dir) {
    return hasAnyMarker(dir, ['.luarc.json', '.luacheckrc', 'selene.toml']) ||
      hasFileMatching(dir, ['.lua'])
  },

  async run(dir, files?) {
    const fileArgs = files && files.length > 0
      ? ' ' + files.map((f) => `"${resolve(dir, f)}"`).join(' ')
      : ' .'

    // 1. luacheck
    if (await isCommandAvailable('luacheck --version')) {
      const cmd = `luacheck --format json${fileArgs}`
      const res = await runDiagnosticCommand(cmd, dir, 60_000)
      if (!res.failed) {
        return { entries: parseLuacheckJson(res.stdout) }
      }
    }

    // 2. Fallback: lua -e loadfile (per-file syntax check)
    if (files && files.length > 0) {
      const entries: DiagnosticEntry[] = []
      for (const f of files) {
        const fp = resolve(dir, f)
        const res = await runDiagnosticCommand(
          `lua -e "assert(loadfile('${fp.replace(/\\/g, '/')}'))"`,
          dir, 15_000,
        )
        if (res.stderr && res.stderr.toLowerCase().includes('error')) {
          entries.push({
            file: f,
            line: 0,
            severity: 'error',
            message: res.stderr.trim(),
            source: 'lua-syntax',
          })
        }
      }
      return { entries, note: 'luacheck not found — used lua loadfile (syntax check only)' }
    }

    return {
      entries: [],
      note: 'luacheck not installed — Lua diagnostics skipped. Install: luarocks install luacheck',
    }
  },
}
