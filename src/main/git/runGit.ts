import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export const GIT_TIMEOUT_MS = 8000

/**
 * Выполняет git-команду в указанном workdir.
 * Используется как IPC-хендлерами git.ipc.ts, так и модулем изоляции суб-агентов
 * (WorktreeIsolation.ts) — отсюда общий экспорт, а не приватный хелпер в ipc.
 *
 * Аргументы экранируются (заменяем `"` на `\"`), workdir подставляется через
 * `git -C "<path>"`. maxBuffer 4MB — достаточно для status/log/diff типичных репо.
 */
export async function runGit(workdir: string, args: string[]): Promise<string> {
  const cmd = `git -C "${workdir}" ${args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ')}`
  const { stdout } = await execAsync(cmd, { timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 })
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
