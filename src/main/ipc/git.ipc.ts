import { ipcMain } from 'electron'
import { runGit } from '../git/runGit'
import { parseBranchList } from '../../shared/git/parseBranches'
import { buildCheckoutPlan, explainCheckoutError } from '../../shared/git/checkoutPlan'
import { readGraph } from '../git/graph'
import { generateCommitMessage } from '../git/commitMessage'
import { readFile, stat } from 'fs/promises'
import { join } from 'path'

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
  // Git добавляет \n между записями лога после \x00 разделителя.
  // Формат: hash1\nauthor1\ndate1\nsubject1\nbody1\x00\nhash2\nauthor2\n...
  // После split('\x00') вторая и последующие записи начинаются с \n,
  // что ломает split('\n')[0] → hash = '' (пустой).
  // Фикс: обрезаем ведущие \n в каждой записи.
  const records = raw.split('\x00')
    .map(r => r.replace(/^\n+/, ''))
    .filter(r => r.length > 0)
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

/**
 * Строки в новых (untracked) файлах: `git diff HEAD --numstat` их не показывает.
 * Потолки — чтобы один сгенерированный артефакт на 200k строк не подвесил статус.
 */
async function countUntrackedLines(workdir: string, files: string[]): Promise<number> {
  const MAX_FILES = 200
  const MAX_FILE_BYTES = 512 * 1024
  // Артефакты сборки/зависимостей новых файлов не должны раздувать счётчик.
  const SKIP = /(^|\/)(node_modules|dist|build|out)\/|\.(lock|map|min\.js|min\.css)$|package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$/i
  let total = 0
  let counted = 0
  for (const rel of files) {
    if (counted >= MAX_FILES) break
    if (SKIP.test(rel)) continue
    counted++
    try {
      const full = join(workdir, rel)
      const info = await stat(full)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue
      const buf = await readFile(full)
      // Бинарники не считаем — у них «строк» не существует.
      if (buf.includes(0)) continue
      let lines = 0
      for (let i = 0; i < buf.length; i++) if (buf[i] === 10) lines++
      if (buf.length > 0 && buf[buf.length - 1] !== 10) lines++
      total += lines
    } catch {
      /* файл исчез между вызовами — не повод падать */
    }
  }
  return total
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

  ipcMain.handle('git:show', async (_e, params: { workdir: string; hash: string; file?: string }) => {
    if (!params.workdir) return { success: false, diff: '', error: 'workdir is required' }
    if (!params.hash) return { success: false, diff: '', error: 'hash is required' }
    try {
      const args = ['show', '--no-color', params.hash]
      if (params.file) {
        args.push('--')
        args.push(params.file)
      }
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

  // git add — staged файл(ы)
  ipcMain.handle('git:add', async (_e, params: { workdir: string; files: string[] }) => {
    if (!params.workdir || !params.files.length) return { success: false, error: 'workdir and files are required' }
    try {
      await runGit(params.workdir, ['add', '--', ...params.files])
      return { success: true }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message ?? e) }
    }
  })

  // git reset HEAD — unstage файл(ы)
  ipcMain.handle('git:reset', async (_e, params: { workdir: string; files: string[] }) => {
    if (!params.workdir || !params.files.length) return { success: false, error: 'workdir and files are required' }
    try {
      await runGit(params.workdir, ['reset', 'HEAD', '--', ...params.files])
      return { success: true }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message ?? e) }
    }
  })

  // git checkout -- (discard changes) или git rm (untracked)
  ipcMain.handle('git:discard', async (_e, params: { workdir: string; files: string[]; untracked: boolean }) => {
    if (!params.workdir || !params.files.length) return { success: false, error: 'workdir and files are required' }
    try {
      if (params.untracked) {
        await runGit(params.workdir, ['clean', '-f', '--', ...params.files])
      } else {
        await runGit(params.workdir, ['checkout', '--', ...params.files])
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message ?? e) }
    }
  })

  // git diff --stat — статистика добавленных/удалённых строк по файлу
  ipcMain.handle('git:diffStat', async (_e, params: { workdir: string; file?: string; staged?: boolean }) => {
    if (!params.workdir) return { success: false, error: 'workdir is required' }
    try {
      const args = ['diff', '--numstat']
      if (params.staged) args.push('--staged')
      args.push('--')
      if (params.file) args.push(params.file)
      const out = await runGit(params.workdir, args)
      // Формат: "added\tdeleted\tpath"
      const lines = out.split('\n').filter(l => l.length > 0)
      const stats: Array<{ path: string; added: number; deleted: number }> = []
      for (const line of lines) {
        const parts = line.split('\t')
        if (parts.length >= 3) {
          stats.push({ path: parts[2], added: parseInt(parts[0], 10) || 0, deleted: parseInt(parts[1], 10) || 0 })
        }
      }
      return { success: true, stats }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message ?? e), stats: [] }
    }
  })

  // ── git commit ──────────────────────────────────────────────────────
  ipcMain.handle('git:commit', async (_e, params: { workdir: string; message: string; amend?: boolean }) => {
    if (!params.workdir) return { success: false, error: 'workdir is required' }
    if (!params.message?.trim()) return { success: false, error: 'message is required' }
    try {
      const args = ['commit', '-m', params.message]
      if (params.amend) args.push('--amend', '--no-edit')
      const out = await runGit(params.workdir, args)
      return { success: true, output: out }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message ?? e) }
    }
  })

  // ── git push ────────────────────────────────────────────────────────
  ipcMain.handle('git:push', async (_e, params: { workdir: string; remote?: string; branch?: string }) => {
    if (!params.workdir) return { success: false, error: 'workdir is required' }
    try {
      const args = ['push']
      if (params.remote) args.push(params.remote)
      if (params.branch) args.push(params.branch)
      const out = await runGit(params.workdir, args)
      return { success: true, output: out }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message ?? e) }
    }
  })

  // ── git pull ─────────────────────────────────────────────────────────
  ipcMain.handle('git:pull', async (_e, params: { workdir: string; remote?: string; branch?: string }) => {
    if (!params.workdir) return { success: false, error: 'workdir is required' }
    try {
      const args = ['pull']
      if (params.remote) args.push(params.remote)
      if (params.branch) args.push(params.branch)
      const out = await runGit(params.workdir, args)
      return { success: true, output: out }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message ?? e) }
    }
  })

  // ── git fetch ───────────────────────────────────────────────────────
  ipcMain.handle('git:fetch', async (_e, params: { workdir: string; remote?: string }) => {
    if (!params.workdir) return { success: false, error: 'workdir is required' }
    try {
      const args = ['fetch']
      if (params.remote) args.push(params.remote)
      const out = await runGit(params.workdir, args)
      return { success: true, output: out }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message ?? e) }
    }
  })

  // ── git fileVersions — original (HEAD) + modified (working copy) ─────
  // Возвращает содержимое файла из HEAD и из рабочей копии для Monaco DiffEditor.
  // Для untracked: original = '', modified = содержимое файла.
  // Для deleted: original = содержимое из HEAD, modified = ''.
  ipcMain.handle('git:fileVersions', async (_e, params: { workdir: string; file: string; ref?: string }) => {
    if (!params.workdir || !params.file) return { success: false, error: 'workdir and file are required', original: '', modified: '' }
    try {
      let original = ''
      let modified = ''

      // Если указан ref (например хеш коммита) — берём версии из ref и ref~1
      if (params.ref) {
        try {
          original = await runGit(params.workdir, ['show', `${params.ref}~1:${params.file}`])
        } catch { /* файл новый в этом коммите */ }
        try {
          modified = await runGit(params.workdir, ['show', `${params.ref}:${params.file}`])
        } catch { /* файл удалён в этом коммите */ }
      } else {
        // Рабочая копия: original из HEAD, modified с диска
        try {
          original = await runGit(params.workdir, ['show', `HEAD:${params.file}`])
        } catch { /* untracked или нет в HEAD */ }

        try {
          const fullPath = join(params.workdir, params.file)
          modified = await readFile(fullPath, 'utf-8')
        } catch { /* файл удалён */ }
      }

      return { success: true, original, modified }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message ?? e), original: '', modified: '' }
    }
  })

  // ── git showFiles — список файлов изменённых в коммите ───────────────
  ipcMain.handle('git:showFiles', async (_e, params: { workdir: string; hash: string }) => {
    if (!params.workdir || !params.hash) return { success: false, error: 'workdir and hash are required', files: [] }
    try {
      const out = await runGit(params.workdir, ['show', '--name-status', '--format=', params.hash])
      const files: Array<{ path: string; status: string }> = []
      for (const line of out.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        // Формат: "M\tpath" или "R100\told\tpath" или "A\tpath"
        const parts = trimmed.split('\t')
        if (parts.length >= 2) {
          const status = parts[0]
          const path = parts[parts.length - 1] // для rename последний — новый путь
          files.push({ path, status: status[0] })
        }
      }
      return { success: true, files }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message ?? e), files: [] }
    }
  })

  // ── git branchList — список веток ────────────────────────────────────
  // all=true → объекты { name, current, remote } (включая удалённые).
  // Без all → только локальные строки, это дефолт для панелей переключения.
  ipcMain.handle('git:branchList', async (_e, workdir: string, all?: boolean) => {
    if (!workdir) return { success: false, error: 'workdir is required', branches: [], current: null }
    try {
      if (all) {
        // Парсинг — в src/shared/git/parseBranches.ts (там же объяснение бага с trim).
        const out = await runGit(workdir, [
          'branch', '--list', '--all',
          '--format=%(HEAD)%09%(refname)%09%(refname:short)',
        ])
        const { branches, current } = parseBranchList(out)
        return { success: true, branches, current }
      }

      const out = await runGit(workdir, ['branch', '--list', '--format=%(HEAD)%09%(refname:short)'])
      const branches: string[] = []
      let current: string | null = null
      for (const rawLine of out.split('\n')) {
        const line = rawLine.replace(/\r$/, '')
        if (!line.trim()) continue
        // «*» стоит в первой колонке, имя — после TAB (trim съел бы TAB у не-текущих).
        const isCurrent = line.charAt(0) === '*'
        const name = line.slice(line.indexOf('\t') + 1).trim()
        if (!name) continue
        if (isCurrent) current = name
        branches.push(name)
      }
      return { success: true, branches, current }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message ?? e), branches: [], current: null }
    }
  })

  // ── git checkout — переключение ветки ────────────────────────────────
  // Правки в рабочем дереве почти всегда есть (агент правит файлы), поэтому
  // голый `checkout` падал с "local changes would be overwritten". План команд
  // (stash → checkout → stash pop) строится в src/shared/git/checkoutPlan.ts.
  ipcMain.handle('git:checkout', async (_e, params: { workdir: string; branch: string }) => {
    if (!params.workdir || !params.branch) return { success: false, error: 'workdir and branch are required' }
    try {
      const { workdir, branch } = params
      const [statusOut, localOut, remoteOut] = await Promise.all([
        runGit(workdir, ['status', '--porcelain']).catch(() => ''),
        runGit(workdir, ['branch', '--list', '--format=%(refname:short)']).catch(() => ''),
        runGit(workdir, ['branch', '--remotes', '--format=%(refname:short)']).catch(() => ''),
      ])
      const lines = (s: string): string[] => s.split('\n').map(l => l.trim()).filter(Boolean)

      const plan = buildCheckoutPlan(branch, {
        localBranches: lines(localOut),
        remoteBranches: lines(remoteOut),
        dirty: lines(statusOut).length > 0,
      })

      let stashed = false
      const output: string[] = []
      for (let i = 0; i < plan.steps.length; i++) {
        try {
          output.push(await runGit(workdir, plan.steps[i].args))
          if (plan.steps[i].args[0] === 'stash' && plan.steps[i].args[1] === 'push') stashed = true
        } catch (stepErr) {
          const raw = String((stepErr as Error)?.message ?? stepErr)
          // Правки спрятаны, но переключение не удалось — вернуть их обратно,
          // иначе пользователь останется на старой ветке без своих изменений.
          if (plan.restoreOnFailureAt.includes(i) && stashed) {
            await runGit(workdir, ['stash', 'pop']).catch(() => {})
          }
          return { success: false, error: explainCheckoutError(raw), stashed }
        }
      }

      return { success: true, output: output.join('\n'), stashed }
    } catch (e) {
      return { success: false, error: explainCheckoutError(String((e as Error)?.message ?? e)) }
    }
  })

  // ── git branchCreate — создание новой ветки ──────────────────────────
  ipcMain.handle('git:branchCreate', async (_e, params: { workdir: string; branch: string; checkout?: boolean }) => {
    if (!params.workdir || !params.branch) return { success: false, error: 'workdir and branch are required' }
    try {
      const args = ['branch', params.branch]
      const out = await runGit(params.workdir, args)
      if (params.checkout) {
        await runGit(params.workdir, ['checkout', params.branch])
      }
      return { success: true, output: out }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message ?? e) }
    }
  })

  // ── git stash ────────────────────────────────────────────────────────
  ipcMain.handle('git:stash', async (_e, params: { workdir: string; message?: string }) => {
    if (!params.workdir) return { success: false, error: 'workdir is required' }
    try {
      const args = ['stash', 'push']
      if (params.message) args.push('-m', params.message)
      const out = await runGit(params.workdir, args)
      return { success: true, output: out }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message ?? e) }
    }
  })

  // ── git stashPop ──────────────────────────────────────────────────────
  ipcMain.handle('git:stashPop', async (_e, params: { workdir: string }) => {
    if (!params.workdir) return { success: false, error: 'workdir is required' }
    try {
      const out = await runGit(params.workdir, ['stash', 'pop'])
      return { success: true, output: out }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message ?? e) }
    }
  })

  // ── git stashList ────────────────────────────────────────────────────
  ipcMain.handle('git:stashList', async (_e, workdir: string) => {
    if (!workdir) return { success: false, error: 'workdir is required', stashes: [] }
    try {
      const out = await runGit(workdir, ['stash', 'list', '--format=%gd|%s|%cr'])
      const stashes: Array<{ ref: string; message: string; date: string }> = []
      for (const line of out.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const [ref, message, date] = trimmed.split('|')
        stashes.push({ ref, message: message ?? '', date: date ?? '' })
      }
      return { success: true, stashes }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message ?? e), stashes: [] }
    }
  })

  // ── git logFile — история файла ──────────────────────────────────────
  ipcMain.handle('git:logFile', async (_e, params: { workdir: string; file: string; limit?: number }) => {
    if (!params.workdir || !params.file) return { success: false, entries: [], error: 'workdir and file are required' }
    try {
      const limit = Math.min(params.limit ?? 20, 100)
      const format = '%H%n%an%n%ad%n%s%n%b%x00'
      const out = await runGit(params.workdir, ['log', '--follow', `--format=${format}`, `--max-count=${limit}`, '--date=short', '--', params.file])
      return { success: true, entries: parseLog(out) }
    } catch (e) {
      return { success: false, entries: [], error: String((e as Error)?.message ?? e) }
    }
  })

  // ── git repoSummary — всё для панели «Обзор» одним вызовом ──
  ipcMain.handle('git:repoSummary', async (_e, workdir: string) => {
    const empty = {
      success: false, branch: null as string | null, ahead: 0, behind: 0,
      clean: true, files: 0, added: 0, deleted: 0, staged: 0, unstaged: 0, untracked: 0,
    }
    if (!workdir) return { ...empty, error: 'workdir is required' }
    try {
      const [statusRaw, numstatRaw, untrackedRaw] = await Promise.all([
        runGit(workdir, ['status', '--porcelain=v1', '-b']),
        runGit(workdir, ['diff', 'HEAD', '--numstat']).catch(() => ''),
        runGit(workdir, ['ls-files', '--others', '--exclude-standard']).catch(() => ''),
      ])
      const status = parseStatus(statusRaw)

      let added = 0
      let deleted = 0
      for (const line of numstatRaw.split('\n')) {
        const parts = line.split('\t')
        if (parts.length < 3) continue
        if (parts[0] !== '-') added += parseInt(parts[0], 10) || 0
        if (parts[1] !== '-') deleted += parseInt(parts[1], 10) || 0
      }

      let staged = 0
      let unstaged = 0
      for (const f of status.files) {
        if (f.indexStatus === '?' && f.worktreeStatus === '?') continue
        if (f.indexStatus !== ' ' && f.indexStatus !== '?') staged++
        if (f.worktreeStatus !== ' ' && f.worktreeStatus !== '?') unstaged++
      }

      const untrackedList = untrackedRaw.split('\n').map(l => l.trim()).filter(Boolean)
      const untracked = untrackedList.length
      // `git diff HEAD --numstat` не видит новые файлы (они вне индекса), из-за
      // чего «Изменения» показывали +350 вместо +3767. Считаем строки сами,
      // с потолком на файл и на общий объём — чтобы не читать гигабайты.
      added += await countUntrackedLines(workdir, untrackedList)

      return {
        success: true,
        branch: status.branch,
        ahead: status.ahead,
        behind: status.behind,
        clean: status.clean,
        files: status.files.length,
        added,
        deleted,
        staged,
        unstaged,
        untracked,
      }
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      if (msg.includes('not a git repository')) return { ...empty, notARepo: true }
      return { ...empty, error: msg }
    }
  })

  // ── git graph — коммиты всех веток + раскладка дорожек ──────────────────
  ipcMain.handle('git:graph', async (_e, params: { workdir: string; limit?: number }) => {
    if (!params?.workdir) return { success: false, commits: [], maxLanes: 1, error: 'workdir is required' }
    try {
      const graph = await readGraph(params.workdir, params.limit ?? 200)
      return { success: true, ...graph }
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      if (msg.includes('does not have any commits yet') || msg.includes('unknown revision')) {
        return { success: true, commits: [], maxLanes: 1 }
      }
      return { success: false, commits: [], maxLanes: 1, error: msg }
    }
  })

  // ── git generateCommitMessage — сообщение коммита локальной моделью ─────
  ipcMain.handle('git:generateCommitMessage', async (_e, params: { workdir: string; lang?: 'ru' | 'en' }) => {
    if (!params?.workdir) {
      return { success: false, message: '', source: 'fallback', error: 'workdir is required', stats: { files: 0, added: 0, deleted: 0, untracked: 0 } }
    }
    return generateCommitMessage(params.workdir, params.lang === 'en' ? 'en' : 'ru')
  })

  // ── git commitAndPush — один клик «Коммит и push» ───────────────────────
  ipcMain.handle('git:commitAndPush', async (_e, params: { workdir: string; message: string; includeUnstaged?: boolean; push?: boolean }) => {
    if (!params?.workdir) return { success: false, error: 'workdir is required' }
    if (!params.message?.trim()) return { success: false, error: 'message is required' }
    try {
      if (params.includeUnstaged) await runGit(params.workdir, ['add', '-A'])
      await runGit(params.workdir, ['commit', '-m', params.message])
      if (params.push !== false) await runGit(params.workdir, ['push'])
      return { success: true }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message ?? e) }
    }
  })
}
