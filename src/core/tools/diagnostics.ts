import { existsSync } from 'fs'
import { join } from 'path'
import { execAsync, smartTrimOutput, type ToolResult } from './_shared'

// ── get_diagnostics — tsc --noEmit (оба проекта) + eslint --format json ──
interface DiagnosticEntry {
  file: string
  line: number
  col?: number
  severity: 'error' | 'warning'
  message: string
  source: 'tsc' | 'eslint'
}

// Формат tsc: "C:\path\file.ts(12,5): error TS2322: Type 'X' is not assignable..."
const TSC_LINE_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.+)$/

function parseTscOutput(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of stdout.split('\n')) {
    const m = line.match(TSC_LINE_RE)
    if (!m) continue
    const [, file, lineNum, col, severity, code, message] = m
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      col: Number(col),
      severity: severity as 'error' | 'warning',
      message: `${code}: ${message.trim()}`,
      source: 'tsc',
    })
  }
  return entries
}

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

async function runDiagnosticCommand(cmd: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
      encoding: 'utf8',
    })
    return { stdout: stdout as string, stderr: stderr as string }
  } catch (e: any) {
    // tsc/eslint возвращают ненулевой exit code когда находят ошибки —
    // это не сбой выполнения команды, а нормальный результат.
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

export async function getDiagnostics(cwd?: string): Promise<ToolResult> {
  const dir = cwd || process.cwd()
  if (!existsSync(dir)) return { success: false, output: '', error: 'Директория не найдена: ' + dir }

  const allEntries: DiagnosticEntry[] = []
  const notes: string[] = []

  const nodeTsconfig = join(dir, 'tsconfig.node.json')
  const webTsconfig = join(dir, 'tsconfig.web.json')
  const rootTsconfig = join(dir, 'tsconfig.json')

  if (existsSync(nodeTsconfig) && existsSync(webTsconfig)) {
    const [nodeRes, webRes] = await Promise.all([
      runDiagnosticCommand('npx tsc -p tsconfig.node.json --noEmit', dir),
      runDiagnosticCommand('npx tsc -p tsconfig.web.json --noEmit', dir),
    ])
    allEntries.push(...parseTscOutput(nodeRes.stdout + '\n' + nodeRes.stderr))
    allEntries.push(...parseTscOutput(webRes.stdout + '\n' + webRes.stderr))
  } else if (existsSync(rootTsconfig)) {
    const res = await runDiagnosticCommand('npx tsc -p tsconfig.json --noEmit', dir)
    allEntries.push(...parseTscOutput(res.stdout + '\n' + res.stderr))
  } else {
    notes.push('tsconfig не найден — TypeScript проверка пропущена')
  }

  const eslintConfigCandidates = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts']
  if (eslintConfigCandidates.some(f => existsSync(join(dir, f)))) {
    const res = await runDiagnosticCommand('npx eslint . --format json', dir)
    allEntries.push(...parseEslintOutput(res.stdout))
  } else {
    notes.push('eslint.config не найден — линт пропущен')
  }

  allEntries.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)

  const errorCount = allEntries.filter(e => e.severity === 'error').length
  const warningCount = allEntries.filter(e => e.severity === 'warning').length

  if (allEntries.length === 0) {
    const okMsg = notes.length ? `Ошибок не найдено.\n${notes.join('\n')}` : 'Ошибок не найдено. Проект компилируется и линтится чисто.'
    return { success: true, output: okMsg }
  }

  const lines = allEntries.map(e => `[${e.source}] ${e.severity === 'error' ? 'ERROR' : 'WARN'} ${e.file}:${e.line}${e.col ? ':' + e.col : ''} — ${e.message}`)
  const header = `Найдено ${errorCount} ошибок, ${warningCount} предупреждений:`
  const body = smartTrimOutput([header, ...notes, ...lines].join('\n'), 8000)
  return { success: errorCount === 0, output: body }
}
