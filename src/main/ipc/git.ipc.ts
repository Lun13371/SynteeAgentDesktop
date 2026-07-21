import { ipcMain } from 'electron'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

const GIT_TIMEOUT_MS = 8000

async function runGit(workdir: string, args: string[]): Promise<string> {
  const cmd = `git -C "${workdir}" ${args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ')}`
  const { stdout } = await execAsync(cmd, { timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 })
  return stdout
}

export interface GitFileStatus {
  path: string
  indexStatus: string
  worktreeStatus: string
  raw: string
}

export interface GitStatusResult {
  branch: string | null
  ahead: number
  behind: number
  files: GitFileStatus[]
  clean: boolean
}

function parseStatus(raw: string): GitStatusResult {
  const lines = raw.split('\n').filter(l => l.length > 0)
  let branch: string | null = null
  let ahead = 0
  let behind = 0
  const files: GitFileStatus[] = []

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const header = line.slice(3)
      const m = header.match(/^(\S+?)(\.\.\.(\S+?))?( \[(ahead|behind) (\d+)(, (ahead|behind) (\d+))?\])?$/)
      if (m) {
        branch = m[1]
        if (m[5] === 'ahead') ahead = parseInt(m[6], 10) || 0
        if (m[5] === 'behind') behind = parseInt(m[6], 10) || 0
        if (m[8] === 'ahead') ahead = parseInt(m[9], 10) || 0
        if (m[8] === 'behind') behind = parseInt(m[9], 10) || 0
      } else {
        branch = header.split(' ')[0]
      }
      continue
    }
    if (line.length < 3) continue
    const indexStatus = line[0]
    const worktreeStatus = line[1]
    const path = line.slice(3)
    files.push({ path, indexStatus, worktreeStatus, raw: line })
  }

  return { branch, ahead, behind, files, clean: files.length === 0 }
}

export interface GitLogEntry {
  hash: string
  shortHash: string
  author: string
  date: string
  message: string
}

function parseLog(raw: string): GitLogEntry[] {
  const records = raw.split('\x00').filter(r => r.length > 0)
  return records.map(r => {
    const [hash, author, date, ...msgParts] = r.split('\n')
    return {
      hash,
      shortHash: hash.slice(0, 7),
      author: author ?? '',
      date: date ?? '',
      message: msgParts.join('\n'),
    }
  })
}

export function registerGitIPC(): void {
  ipcMain.handle('git:status', async (_e, workdir: string) => {
    if (!workdir) return { success: false, error: 'workdir is required', branch: null, files: [], clean: true, ahead: 0, behind: 0 }
    try {
      const out = await runGit(workdir, ['status', '--porcelain=v1', '-b'])
      const result = parseStatus(out)
      return { success: true, ...result }
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      if (msg.includes('not a git repository')) {
        return { success: false, error: 'Not a git repository', notARepo: true, branch: null, files: [], clean: true, ahead: 0, behind: 0 }
      }
      return { success: false, error: msg, branch: null, files: [], clean: true, ahead: 0, behind: 0 }
    }
  })

  ipcMain.handle('git:diff', async (_e, params: { workdir: string; file?: string; staged?: boolean }) => {
    if (!params.workdir) return { success: false, diff: '', error: 'workdir is required' }
    try {
      const args = ['diff', '--no-color']
      if (params.staged) args.push('--staged')
      args.push('--')
      if (params.file) args.push(params.file)
      const diff = await runGit(params.workdir, args)
      return { success: true, diff }
    } catch (e) {
      return { success: false, diff: '', error: String((e as Error)?.message ?? e) }
    }
  })

  ipcMain.handle('git:log', async (_e, params: { workdir: string; limit?: number }) => {
    if (!params.workdir) return { success: false, entries: [], error: 'workdir is required' }
    try {
      const limit = Math.min(params.limit ?? 20, 100)
      const format = '%H%n%an%n%ad%n%s%n%b%x00'
      const out = await runGit(params.workdir, ['log', `--format=${format}`, `--max-count=${limit}`, '--date=short'])
      return { success: true, entries: parseLog(out) }
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      if (msg.includes('not a git repository')) {
        return { success: false, entries: [], notARepo: true }
      }
      return { success: false, entries: [], error: msg }
    }
  })

  ipcMain.handle('git:branch', async (_e, workdir: string) => {
    if (!workdir) return { success: false, branch: null, error: 'workdir is required' }
    try {
      const out = await runGit(workdir, ['branch', '--show-current'])
      return { success: true, branch: out.trim() || null }
    } catch (e) {
      return { success: false, branch: null, error: String((e as Error)?.message ?? e) }
    }
  })

  ipcMain.handle('git:isRepo', async (_e, workdir: string) => {
    if (!workdir) return false
    try {
      await runGit(workdir, ['rev-parse', '--is-inside-work-tree'])
      return true
    } catch {
      return false
    }
  })
}
