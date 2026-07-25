import { homedir } from 'os'
import { execAsync, smartTrimOutput, type ToolResult } from './_shared'

export async function runCommand(cmd: string, cwd?: string, shell?: string, timeout?: number): Promise<ToolResult> {
  try {
    const isWin = process.platform === 'win32'
    const timeoutMs = (timeout || 60) * 1000
    const maxBuffer = 10 * 1024 * 1024  // 10MB — иначе Node падает с ERR_CHILD_PROCESS_STDOUT_MAXBUFFER до smartTrimOutput

    let execCmd: string
    let execOpts: Parameters<typeof execAsync>[1]

    if (isWin) {
      // Windows: PowerShell по умолчанию — понимает ls/cat/rm/mkdir/grep и т.д.
      // cmd только если явно указан shell: 'cmd'
      if (shell === 'cmd') {
        execCmd = cmd
        execOpts = {
          cwd: cwd || homedir(),
          timeout: timeoutMs,
          shell: 'cmd.exe',
          encoding: 'utf8',
          maxBuffer,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        }
      } else {
        // PowerShell: используем -EncodedCommand (base64 UTF-16LE) вместо
        // встраивания команды в двойные кавычки. Это полностью устраняет
        // проблему экранирования (", $(), backtick и т.д.) — команда передаётся
        // как данные, а не как часть shell-строки.
        const psScript = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${cmd}`
        const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
        execCmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
        execOpts = {
          cwd: cwd || homedir(),
          timeout: timeoutMs,
          encoding: 'utf8',
          maxBuffer,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        }
      }
    } else {
      // Linux/Mac — bash напрямую
      execCmd = cmd
      execOpts = {
        cwd: cwd || homedir(),
        timeout: timeoutMs,
        shell: '/bin/bash',
        encoding: 'utf8',
        maxBuffer,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      }
    }

    const { stdout, stderr } = await execAsync(execCmd, execOpts)
    const stdoutClean = (stdout as string)?.trim() || ''
    const stderrClean = (stderr as string)?.trim() || ''
    let out = smartTrimOutput(stdoutClean) || '(нет вывода)'
    if (stderrClean) out += `\n[stderr]:\n${smartTrimOutput(stderrClean)}`
    return { success: true, output: `[exit: 0]\n${out}` }
  } catch (e: any) {
    const stdoutPart = smartTrimOutput(e.stdout?.trim() || '')
    const stderrPart = smartTrimOutput(e.stderr?.trim() || '')
    const exitCode = typeof e.code === 'number' ? e.code : 1
    let out = `[exit: ${exitCode}]`
    if (stdoutPart) out += `\n[stdout]:\n${stdoutPart}`
    if (stderrPart) out += `\n[stderr]:\n${stderrPart}`
    return {
      success: false,
      output: out,
      error: stderrPart || e.message?.replace(/Command failed:.+\n?/, '').trim() || 'Команда завершилась с ошибкой',
    }
  }
}
