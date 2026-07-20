/**
 * Persistent shell sessions — один живой shell-процесс на chatId вместо
 * fresh exec() на каждый run_command вызов (см. GAP_ANALYSIS.md §1
 * "Нет persistent shell-сессии"). cd/env переживают между вызовами и между
 * сообщениями чата, т.к. процесс живёт в main-процессе (не в Worker, который
 * пересоздаётся на каждый chat:send).
 *
 * Команды пишутся в stdin, конец команды определяется по уникальному
 * маркеру в stdout с кодом завершения. Для PowerShell используем $? (bool
 * успеха последнего statement — работает и для cmdlets, не только native
 * exe, в отличие от $LASTEXITCODE, который для cmdlets не обновляется).
 */
import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { homedir } from 'os'

interface PendingExec {
  markerId: string
  resolve: (result: { output: string; exitCode: number; timedOut?: boolean }) => void
  timer: NodeJS.Timeout
}

interface ShellSession {
  proc: ChildProcess
  stdoutBuf: string
  stderrBuf: string
  pending: PendingExec | null
}

function escapePsSingleQuote(s: string): string {
  return s.replace(/'/g, "''")
}

function escapeBashSingleQuote(s: string): string {
  return s.replace(/'/g, "'\\''")
}

class ShellSessionManager {
  private sessions = new Map<string, ShellSession>()

  private spawnShell(cwd: string): ChildProcess {
    const isWin = process.platform === 'win32'
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8' }
    if (isWin) {
      const proc = spawn('powershell.exe', ['-NoLogo', '-NoExit', '-Command', '-'], {
        cwd, stdio: 'pipe', env,
      })
      proc.stdin?.write('[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n')
      return proc
    }
    return spawn('/bin/bash', [], { cwd, stdio: 'pipe', env })
  }

  private getOrCreate(chatId: string, cwd: string): ShellSession {
    const existing = this.sessions.get(chatId)
    if (existing) return existing
    const proc = this.spawnShell(cwd)
    const session: ShellSession = { proc, stdoutBuf: '', stderrBuf: '', pending: null }
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => this.onStdout(chatId, chunk))
    proc.stderr?.on('data', (chunk: string) => {
      const s = this.sessions.get(chatId)
      if (s) s.stderrBuf += chunk
    })
    proc.on('exit', () => { this.sessions.delete(chatId) })
    proc.on('error', () => { this.sessions.delete(chatId) })
    this.sessions.set(chatId, session)
    return session
  }

  private onStdout(chatId: string, chunk: string): void {
    const session = this.sessions.get(chatId)
    if (!session) return
    session.stdoutBuf += chunk
    if (!session.pending) return
    const { markerId } = session.pending
    const markerRe = new RegExp(`${markerId}:(\\d+)`)
    const m = session.stdoutBuf.match(markerRe)
    if (!m || m.index === undefined) return
    const exitCode = Number(m[1])
    const output = session.stdoutBuf.slice(0, m.index).trimEnd()
    const stderr = session.stderrBuf.trim()
    session.stdoutBuf = ''
    session.stderrBuf = ''
    const pending = session.pending
    session.pending = null
    clearTimeout(pending.timer)
    pending.resolve({
      output: stderr ? `${output}\n[stderr]:\n${stderr}` : output,
      exitCode,
    })
  }

  /**
   * Выполняет команду в persistent shell-сессии чата. Если cwd передан явно
   * (модель указала cwd отдельно от текущего состояния сессии) — делаем
   * Set-Location/cd перед командой; это меняет cwd сессии и для следующих
   * вызовов, что соответствует ожидаемому поведению "cd персистится".
   */
  async exec(
    chatId: string,
    command: string,
    cwd: string | undefined,
    timeoutSec: number,
  ): Promise<{ output: string; exitCode: number; timedOut?: boolean }> {
    const session = this.getOrCreate(chatId, cwd || homedir())
    if (session.pending) {
      // run_command сериализован в Agent.ts (isSequentialTool) — параллельных
      // вызовов на одну сессию быть не должно, но защищаемся на всякий случай.
      return { output: '', exitCode: 1, timedOut: false }
    }

    const markerId = `__SYNTEE_DONE_${randomUUID().replace(/-/g, '')}__`
    const isWin = process.platform === 'win32'
    const prefix = cwd
      ? (isWin ? `Set-Location -LiteralPath '${escapePsSingleQuote(cwd)}'; ` : `cd '${escapeBashSingleQuote(cwd)}'; `)
      : ''
    const suffix = isWin
      ? `\nWrite-Output "${markerId}:$(if ($?) { 0 } else { 1 })"`
      : `\necho "${markerId}:$?"`
    const fullCmd = prefix + command + suffix + '\n'

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        session.pending = null
        this.kill(chatId)
        resolve({ output: '', exitCode: 1, timedOut: true })
      }, Math.max(1, timeoutSec) * 1000)
      session.pending = { markerId, resolve, timer }
      session.proc.stdin?.write(fullCmd)
    })
  }

  kill(chatId: string): void {
    const session = this.sessions.get(chatId)
    if (!session) return
    if (session.pending) {
      clearTimeout(session.pending.timer)
      session.pending = null
    }
    session.proc.kill()
    this.sessions.delete(chatId)
  }

  killAll(): void {
    for (const chatId of Array.from(this.sessions.keys())) this.kill(chatId)
  }
}

export const shellSessionManager = new ShellSessionManager()
