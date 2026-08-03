import { existsSync } from 'fs'
import { join } from 'path'
import { execAsync, smartTrimOutput, type ToolResult } from './_shared'

// ── get_diagnostics — tsc --noEmit (both projects) + eslint --format json ──
interface DiagnosticEntry {
  file: string
  line: number
  col?: number
  severity: 'error' | 'warning'
  message: string
  source: 'tsc' | 'eslint'
}

// tsc format: "C:\path\file.ts(12,5): error TS2322: Type 'X' is not assignable..."
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

interface DiagRunResult {
  stdout: string
  stderr: string
  /** true if exec threw not because of errors found (tsc/eslint exit!=0 on
   *  errors is normal), but because of a failure: timeout, command not found,
   *  npx crashed, no node_modules. Previously such failures were masked as
   *  "No errors found" — the AI thought the project was clean. */
  failed: boolean
  failureReason: string
}

async function runDiagnosticCommand(cmd: string, cwd: string): Promise<DiagRunResult> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
      encoding: 'utf8',
    })
    return { stdout: stdout as string, stderr: stderr as string, failed: false, failureReason: '' }
  } catch (e: any) {
    // tsc/eslint return a non-zero exit code when they find errors —
    // this is NOT an execution failure, but a normal result. Signs of a normal
    // result: there is stdout (tsc writes errors to stdout, eslint --format
    // json to stdout) and no signs of timeout/not-running.
    const stdout = e.stdout ?? ''
    const stderr = e.stderr ?? ''
    // Timeout: Node marks killed/signal=SIGTERM.
    if (e.killed === true || e.signal === 'SIGTERM') {
      return {
        stdout, stderr,
        failed: true,
        failureReason: `command exceeded the 120s timeout (possibly a large project or a hung tsc). Try running "npx tsc --noEmit" manually`,
      }
    }
    // Signs of NOT-running: stderr contains "not found"/"Cannot find module"/
    // "is not recognized"/"unable to resolve"/"no such file". tsc/eslint
    // with exit!=0 and stdout errors do NOT have such phrases in stderr.
    const stderrLower = (stderr || '').toLowerCase()
    const stdoutLower = (stdout || '').toLowerCase()
    const notInstalledMarkers = [
      'is not recognized',        // cmd.exe on Windows
      'is not recognized as',      // cmd.exe variant
      'command not found',        // bash
      'no such file or directory',
      'cannot find module',
      'unable to resolve',
      'npm err! missing',
      'npx: not found',
      'could not find',
      'err! code e404',
      'eslint: not found',
      'tsc: not found',
    ]
    // eslint when the config is missing writes to stderr "ESLint couldn't find a
    // configuration file" / "Couldn't find eslint.config.js". This is a config
    // failure, not "no errors found".
    const eslintConfigMissing = stdoutLower.includes("couldn't find") || stderrLower.includes("couldn't find")
      || stdoutLower.includes('no eslint config') || stderrLower.includes('no eslint config')
    const notInstalled = notInstalledMarkers.some(m => stderrLower.includes(m) || stdoutLower.includes(m))
    // tsc with exit!=0 and non-empty stdout containing "(N,N): error TS" — this
    // is a normal result (errors found). We check by the presence of a tsc patch.
    const hasTscErrors = /\(\d+,\d+\):\s+(error|warning)\s+TS\d+:/.test(stdout)
    // eslint with exit!=0 and a valid JSON output — normal result.
    let hasEslintJson = false
    try { JSON.parse(stdout); hasEslintJson = true } catch { /* not JSON — may be a failure */ }

    if (notInstalled || eslintConfigMissing) {
      const reason = notInstalled
        ? `command not installed or not found: ${(stderr || stdout).slice(0, 200)}`
        : 'eslint config not found — lint did not run'
      return { stdout, stderr, failed: true, failureReason: reason }
    }
    // If exit!=0, but stdout is neither tsc errors nor eslint JSON, and stderr
    // is non-empty — most likely a failure (not "no errors found").
    if (!hasTscErrors && !hasEslintJson && stderr && !stdout) {
      return {
        stdout, stderr,
        failed: true,
        failureReason: `command crashed without valid output: ${stderr.slice(0, 200)}`,
      }
    }
    // Normal case: exit!=0 because of found errors (tsc/eslint).
    return { stdout, stderr, failed: false, failureReason: '' }
  }
}

export async function getDiagnostics(cwd?: string): Promise<ToolResult> {
  const dir = cwd || process.cwd()
  if (!existsSync(dir)) return { success: false, output: '', error: 'Directory not found: ' + dir }

  const allEntries: DiagnosticEntry[] = []
  const notes: string[] = []
  // Diagnostic command failures (not "no errors found", but an actual failure):
  // tsc/eslint not installed, timeout, config missing. Previously such
  // failures were masked as success=true "No errors found" — the AI broke
  // types, diagnostics said "all clean", the AI completed the task with
  // confidence. Now we collect failures and report them explicitly.
  const failures: string[] = []

  const nodeTsconfig = join(dir, 'tsconfig.node.json')
  const webTsconfig = join(dir, 'tsconfig.web.json')
  const rootTsconfig = join(dir, 'tsconfig.json')

  if (existsSync(nodeTsconfig) && existsSync(webTsconfig)) {
    const [nodeRes, webRes] = await Promise.all([
      runDiagnosticCommand('npx tsc -p tsconfig.node.json --noEmit', dir),
      runDiagnosticCommand('npx tsc -p tsconfig.web.json --noEmit', dir),
    ])
    if (nodeRes.failed) failures.push(`tsc (node): ${nodeRes.failureReason}`)
    else allEntries.push(...parseTscOutput(nodeRes.stdout + '\n' + nodeRes.stderr))
    if (webRes.failed) failures.push(`tsc (web): ${webRes.failureReason}`)
    else allEntries.push(...parseTscOutput(webRes.stdout + '\n' + webRes.stderr))
  } else if (existsSync(rootTsconfig)) {
    const res = await runDiagnosticCommand('npx tsc -p tsconfig.json --noEmit', dir)
    if (res.failed) failures.push(`tsc: ${res.failureReason}`)
    else allEntries.push(...parseTscOutput(res.stdout + '\n' + res.stderr))
  } else {
    notes.push('tsconfig not found — TypeScript check skipped')
  }

  const eslintConfigCandidates = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts']
  if (eslintConfigCandidates.some(f => existsSync(join(dir, f)))) {
    const res = await runDiagnosticCommand('npx eslint . --format json', dir)
    if (res.failed) failures.push(`eslint: ${res.failureReason}`)
    else allEntries.push(...parseEslintOutput(res.stdout))
  } else {
    notes.push('eslint.config not found — lint skipped')
  }

  allEntries.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)

  const errorCount = allEntries.filter(e => e.severity === 'error').length
  const warningCount = allEntries.filter(e => e.severity === 'warning').length

  // If diagnostic commands failed — this is NOT "no errors found". Report
  // the failure explicitly, success=false (the check did not run, cannot
  // trust "all clean"). The AI should understand: diagnostics did not run,
  // cannot claim the code is correct.
  if (failures.length > 0) {
    const failLines = failures.map(f => `⚠ DIAGNOSTICS FAILURE: ${f}`)
    const body = [`${failures.length} diagnostic command(s) failed — the check DID NOT run. Cannot claim the project is clean.`, ...failLines, '', ...notes, ...(allEntries.length > 0 ? [`Partial results (from commands that ran): ${errorCount} errors, ${warningCount} warnings:`, ...allEntries.map(e => `[${e.source}] ${e.severity === 'error' ? 'ERROR' : 'WARN'} ${e.file}:${e.line}${e.col ? ':' + e.col : ''} — ${e.message}`)] : [])].join('\n')
    return { success: false, output: smartTrimOutput(body, 8000) }
  }

  if (allEntries.length === 0) {
    const okMsg = notes.length ? `No errors found.\n${notes.join('\n')}` : 'No errors found. The project compiles and lints cleanly.'
    return { success: true, output: okMsg }
  }

  const lines = allEntries.map(e => `[${e.source}] ${e.severity === 'error' ? 'ERROR' : 'WARN'} ${e.file}:${e.line}${e.col ? ':' + e.col : ''} — ${e.message}`)
  const header = `Found ${errorCount} errors, ${warningCount} warnings:`
  const body = smartTrimOutput([header, ...notes, ...lines].join('\n'), 8000)
  return { success: errorCount === 0, output: body }
}
