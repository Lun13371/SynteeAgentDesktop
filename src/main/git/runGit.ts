import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export const GIT_TIMEOUT_MS = 8000

/**
 * Выполняет git-команду в указанном workdir.
 * Используется как IPC-хендлерами git.ipc.ts, так и модулем изоляции суб-агентов
 * (WorktreeIsolation.ts) — отсюда общий экспорт, а не приватный хелпер в ipc.
 *
 * ВНИМАНИЕ: используем execFile, а НЕ exec. exec гонит команду через cmd.exe
 * (Windows), который раскрывает %VAR% паттерны. Git log --format='%H%n%an%n%ad%n%s%n%b'
 * ломается: %H%, %an%, %ad%, %s%, %b% интерпретируются cmd.exe как env vars.
 * execFile передаёт аргументы напрямую git без shell-обработки — % сохраняются.
 * maxBuffer 4MB — достаточно для status/log/diff типичных репо.
 */
export interface RunGitOptions {
  timeoutMs?: number
  /**
   * Доп. переменные окружения (перекрывают process.env). Нужно фоновому fetch:
   * он не должен ждать ввода логина/пароля и вешать main-процесс.
   */
  env?: NodeJS.ProcessEnv
}

export async function runGit(workdir: string, args: string[], options?: RunGitOptions): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', workdir, ...args], {
    timeout: options?.timeoutMs ?? GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options?.env },
  })
  return stdout
}

/**
 * True, если path — внутри git work tree. Не выбрасывает.
 * Используется для решения: создавать ли worktree для суб-агента или
 * fallback'ить на shared workdir (не-git проекты).
 */
export async function isGitRepo(workdir: string): Promise<boolean> {
  if (!workdir) return false
  try {
    await runGit(workdir, ['rev-parse', '--is-inside-work-tree'])
    return true
  } catch {
    return false
  }
}
