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
        // chcp 65001 переключает code page консоли на UTF-8 ДО запуска
        // пользовательской команды. Без этого нативные exe (aapt2, git,
        // tsc) пишут логи в OEM-кодировке (cp866 на русской локали) —
        // Node декодирует stdout как utf8 и получает `attr/??` вместо
        // реальных кириллических имён. `>nul` глушит вывод "65001" из
        // chcp, чтобы он не засорял результат команды.
        execCmd = `chcp 65001 >nul && ${cmd}`
        execOpts = {
          cwd: cwd || homedir(),
          timeout: timeoutMs,
          shell: 'cmd.exe',
          encoding: 'utf8',
          maxBuffer,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        }
      } else {
        // PowerShell: используем -EncodedCommand (base64 UTF-16LE) вместо
        // встраивания команды в двойные кавычки. Это полностью устраняет
        // проблему экранирования (", $(), backtick и т.д.) — команда передаётся
        // как данные, а не как часть shell-строки.
        // OutputEncoding — как PS декодирует stdout нативных exe в строки.
        // InputEncoding — как PS кодирует строки при записи в консоль и
        // pipe; без него кириллица в аргументах/pipe ломается в PS 5.1.
        // pwsh 7+ UTF-8 по умолчанию — обе строки безвредны (idempotent).
        const psScript = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Console]::InputEncoding=[System.Text.Encoding]::UTF8; ${cmd}`
        const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
        execCmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
        execOpts = {
          cwd: cwd || homedir(),
          timeout: timeoutMs,
          encoding: 'utf8',
          maxBuffer,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        }
      }
    } else {
      // Linux/Mac — bash напрямую. LANG/LC_ALL — на случай не-UTF локали.
      execCmd = cmd
      execOpts = {
        cwd: cwd || homedir(),
        timeout: timeoutMs,
        shell: '/bin/bash',
        encoding: 'utf8',
        maxBuffer,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          LANG: 'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8',
        },
      }
    }

    const { stdout, stderr } = await execAsync(execCmd, execOpts)
    const stdoutClean = (stdout as string)?.trim() || ''
    const stderrClean = (stderr as string)?.trim() || ''
    let out = smartTrimOutput(stdoutClean) || '(no output)'
    if (stderrClean) out += `\n[stderr]:\n${smartTrimOutput(stderrClean)}`
    return { success: true, output: `[exit: 0]\n${out}` }
  } catch (e: any) {
    const stdoutPart = smartTrimOutput(e.stdout?.trim() || '')
    const stderrPart = smartTrimOutput(e.stderr?.trim() || '')
    // Node child_process marks a process killed by timeout: e.killed=true,
    // e.signal='SIGTERM' (sometimes null, but killed=true). execAsync throws
    // with e.code = null/string (not a number) in this case. Without an
    // explicit check, the timeout was masked as "Command failed" exit:1 —
    // the AI did not understand the command timed out and retried the same
    // call in a loop.
    const timedOut = e.killed === true || e.signal === 'SIGTERM'
    if (timedOut) {
      let out = `[timeout: ${timeout || 60}s — process killed]`
      if (stdoutPart) out += `\n[stdout before kill]:\n${stdoutPart}`
      if (stderrPart) out += `\n[stderr before kill]:\n${stderrPart}`
      return {
        success: false,
        output: out,
        error: `Command exceeded the timeout (${timeout || 60}s). Pass a larger timeout (e.g. 120 or 300), run the command in the background, or break it into shorter steps.`,
      }
    }
    const exitCode = typeof e.code === 'number' ? e.code : 1
    let out = `[exit: ${exitCode}]`
    if (stdoutPart) out += `\n[stdout]:\n${stdoutPart}`
    if (stderrPart) out += `\n[stderr]:\n${stderrPart}`
    return {
      success: false,
      output: out,
      error: stderrPart || e.message?.replace(/Command failed:.+\n?/, '').trim() || 'Command failed',
    }
  }
}
