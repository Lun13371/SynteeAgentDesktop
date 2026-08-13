// ── Protocol Buffers провайдер: buf lint → protoc ──

import { resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasAnyMarker, hasFileMatching } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

const CONFIG_MARKERS = ['buf.yaml', 'buf.gen.yaml', 'buf.lock', 'buf.work.yaml']

// buf lint --format=json: один объект на строку (JSON-lines):
// { path, start_line, end_line, start_column, end_column, type, message, categories }
function parseBufLintJson(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.startsWith('{')) continue
    try {
      const d = JSON.parse(trimmed)
      entries.push({
        file: d.path || '',
        line: d.start_line ?? 0,
        col: d.start_column,
        severity: d.type === 'ERROR' || d.type === 'error' ? 'error' : 'warning',
        message: d.message || '',
        source: 'buf',
      })
    } catch { /* not JSON */ }
  }
  return entries
}

// protoc stderr: "file.proto:line:col: message"
const PROTOC_RE = /^(.+?):(\d+):(\d+):\s*(.+)$/
function parseProtocOutput(stderr: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of stderr.split('\n')) {
    const m = line.match(PROTOC_RE)
    if (!m) continue
    const [, file, lineNum, col, message] = m
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      col: Number(col),
      severity: 'error',
      message: message.trim(),
      source: 'protoc',
    })
  }
  return entries
}

export const protobufProvider: DiagnosticProvider = {
  name: 'protobuf',

  detect(dir) {
    return hasFileMatching(dir, ['.proto']) ||
      hasAnyMarker(dir, CONFIG_MARKERS)
  },

  async run(dir, files?) {
    const entries: DiagnosticEntry[] = []

    // 1. buf lint (project-level)
    if (await isCommandAvailable('buf --version')) {
      const res = await runDiagnosticCommand('buf lint --format=json', dir, 120_000)
      if (!res.failed) {
        entries.push(...parseBufLintJson(res.stdout || res.stderr))
      }
      if (entries.length > 0) return { entries }
      // Если buf отработал без ошибок — возвращаем пусто (не падаем в protoc)
      if (!res.failed) return { entries }
    }

    // 2. Fallback: protoc (file-level)
    if (await isCommandAvailable('protoc --version')) {
      // Собираем target-файлы
      let targets = files && files.length > 0
        ? files.map((f) => resolve(dir, f))
        : []

      if (targets.length === 0) {
        try {
          const { readdirSync } = await import('fs')
          targets = readdirSync(dir)
            .filter((f: string) => f.endsWith('.proto'))
            .map((f: string) => resolve(dir, f))
        } catch { /* ignore */ }
      }

      if (targets.length === 0) {
        return { entries: [], note: 'no .proto files found in project root' }
      }

      // protoc пишет descriptor в /dev/null (или NUL на Windows), ошибки — в stderr
      const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null'
      const fileList = targets.map((f) => `"${f}"`).join(' ')
      const cmd = `protoc --proto_path=. --descriptor_set_out=${devNull} ${fileList}`
      const res = await runDiagnosticCommand(cmd, dir, 60_000)
      if (!res.failed) {
        entries.push(...parseProtocOutput(res.stderr))
      }
      if (entries.length > 0) {
        return { entries, note: 'buf not found — used protoc (syntax check only)' }
      }
    }

    if (entries.length === 0) {
      return {
        entries: [],
        note: 'buf/protoc not installed — Protobuf diagnostics skipped. Install: https://buf.build or apt install protobuf-compiler',
      }
    }

    return { entries }
  },
}
