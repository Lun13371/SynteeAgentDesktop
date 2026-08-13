// ── Универсальный раннер диагностических команд ──
// Перенесён из diagnostics.ts без изменения логики.
// Отличает «команда не найдена / timeout» (failed=true) от «найдены ошибки»
// (failed=false, exit!=0 — норма для tsc/eslint/ruff когда есть ошибки).

import { execAsync } from '../_shared'
import type { DiagRunResult } from './types'

export async function runDiagnosticCommand(
  cmd: string,
  cwd: string,
  timeoutMs = 120_000,
): Promise<DiagRunResult> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
      encoding: 'utf8',
    })
    return { stdout: stdout as string, stderr: stderr as string, failed: false, failureReason: '' }
  } catch (e: any) {
    const stdout = e.stdout ?? ''
    const stderr = e.stderr ?? ''

    // Timeout: Node marks killed/signal=SIGTERM.
    if (e.killed === true || e.signal === 'SIGTERM') {
      return {
        stdout,
        stderr,
        failed: true,
        failureReason: `command exceeded the ${Math.round(timeoutMs / 1000)}s timeout. Try running "${cmd}" manually`,
      }
    }

    // Signs of NOT-running: stderr contains "not found"/"Cannot find module"/
    // "is not recognized"/"unable to resolve"/"no such file".
    const stderrLower = (stderr || '').toLowerCase()
    const stdoutLower = (stdout || '').toLowerCase()
    const notInstalledMarkers = [
      'is not recognized',
      'is not recognized as',
      'command not found',
      'no such file or directory',
      'cannot find module',
      'unable to resolve',
      'npm err! missing',
      'npx: not found',
      'could not find',
      'err! code e404',
      'eslint: not found',
      'tsc: not found',
      'not an executable',
      'the term \'',
    ]
    const notInstalled = notInstalledMarkers.some(
      (m) => stderrLower.includes(m) || stdoutLower.includes(m),
    )

    if (notInstalled) {
      return {
        stdout,
        stderr,
        failed: true,
        failureReason: `command not installed or not found: ${(stderr || stdout).slice(0, 200)}`,
      }
    }

    // If exit!=0, but stderr is non-empty and stdout is empty — most likely a
    // failure (not "no errors found"). But some tools write errors to stdout.
    // We only mark as failed if there's truly no usable output.
    if (stderr && !stdout && !stderrLower.includes('error') && !stderrLower.includes('warning')) {
      return {
        stdout,
        stderr,
        failed: true,
        failureReason: `command crashed without valid output: ${stderr.slice(0, 200)}`,
      }
    }

    // Normal case: exit!=0 because of found errors.
    return { stdout, stderr, failed: false, failureReason: '' }
  }
}

/**
 * Быстрая проверка — доступна ли команда в системе (без запуска самой проверки).
 * Используется провайдерами для каскадных fallback (ruff → mypy → py_compile).
 */
export async function isCommandAvailable(cmd: string): Promise<boolean> {
  try {
    await execAsync(cmd, {
      timeout: 10_000,
      maxBuffer: 1024,
      shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
      encoding: 'utf8',
    })
    return true
  } catch (e: any) {
    // Если exit code != 0 но команда нашлась — это OK (например `ruff version` может вернуть 1)
    const stderr = (e.stderr || '').toLowerCase()
    const stdout = (e.stdout || '').toLowerCase()
    const notFoundMarkers = [
      'is not recognized',
      'command not found',
      'no such file or directory',
      'cannot find module',
      'not an executable',
      'the term \'',
    ]
    return !notFoundMarkers.some((m) => stderr.includes(m) || stdout.includes(m))
  }
}
