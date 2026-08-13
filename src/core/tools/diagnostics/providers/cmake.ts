// ── CMake провайдер: cmake-lint ──
// Внимание: корневой CMakeLists.txt детектится cpp провайдером, тут — .cmake файлы
// и подкаталоги с CMakeLists.txt, а также конфиги cmake-format/cmake-lint.

import { resolve } from 'path'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasAnyMarker, hasFileMatching } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'

const CONFIG_MARKERS = ['.cmake-format.yaml', '.cmake-format.yml', '.cmake-lint.yaml', '.cmake-lint.yml']

// cmake-lint text output: "file:line:col: message [rule]"
const CMAKELINT_RE = /^(.+?):(\d+)(?::(\d+))?:\s*(.+?)(?:\s+\[(.+)\])?$/
function parseCmakelintOutput(output: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of output.split('\n')) {
    const m = line.match(CMAKELINT_RE)
    if (!m) continue
    const [, file, lineNum, col, message, rule] = m
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      col: col ? Number(col) : undefined,
      severity: 'warning',
      message: rule ? `${rule}: ${message.trim()}` : message.trim(),
      source: 'cmake-lint',
    })
  }
  return entries
}

export const cmakeProvider: DiagnosticProvider = {
  name: 'cmake',

  detect(dir) {
    // Конфиги cmake-format/cmake-lint — точно наш случай
    if (hasAnyMarker(dir, CONFIG_MARKERS)) return true
    // .cmake файлы в корне
    if (hasFileMatching(dir, ['.cmake'])) return true
    return false
  },

  async run(dir, files?) {
    if (!await isCommandAvailable('cmakelint --version')) {
      return {
        entries: [],
        note: 'cmakelint not installed — CMake diagnostics skipped. Install: pip install cmakelint',
      }
    }

    // Собираем target-файлы: .cmake + CMakeLists.txt (но НЕ корневой CMakeLists.txt
    // если он один — он детектится cpp; но если files передан явно — проверяем)
    let targets = files && files.length > 0
      ? files.map((f) => resolve(dir, f))
      : []

    if (targets.length === 0) {
      try {
        const { readdirSync } = await import('fs')
        targets = readdirSync(dir)
          .filter((f: string) => f.endsWith('.cmake'))
          .map((f: string) => resolve(dir, f))
      } catch { /* ignore */ }
    }

    if (targets.length === 0) {
      return { entries: [], note: 'no .cmake files found in project root' }
    }

    const fileList = targets.map((f) => `"${f}"`).join(' ')
    const res = await runDiagnosticCommand(`cmake-lint ${fileList}`, dir, 60_000)
    if (res.failed) {
      return { entries: [], failed: res.failureReason }
    }

    return { entries: parseCmakelintOutput(res.stdout + '\n' + res.stderr) }
  },
}
