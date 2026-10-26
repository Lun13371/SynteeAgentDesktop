import type Store from 'electron-store'
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { getAllProjects } from '../../core/db/projects'
import { runGit } from '../git/runGit'
import type { MainWindow } from '../windows/MainWindow'
import type { NotificationManager } from './NotificationManager'
import { IPC_EVENTS } from '../../shared/constants'
import type { GitSyncCommit, GitSyncProjectState, GitSyncState } from '../../shared/types'

const POLL_INTERVAL_MS = 15 * 60_000
const FETCH_TIMEOUT_MS = 30_000
const MAX_COMMITS = 50
const DEFERRED_STORE_KEY = 'gitSyncDeferred'

type DeferredMap = Record<string, string[]>

function deferredKey(workdir: string, branch: string, upstream: string): string {
  return `${workdir}\u0000${branch}\u0000${upstream}`
}

function parseCommits(raw: string): GitSyncCommit[] {
  return raw.split('\x1e')
    .map(record => record.trim())
    .filter(Boolean)
    .map(record => {
      const [hash, shortHash, author, date, ...messageParts] = record.split('\x1f')
      return { hash: hash ?? '', shortHash: shortHash ?? (hash ?? '').slice(0, 7), author: author ?? '', date: date ?? '', message: messageParts.join('\x1f') }
    })
    .filter(commit => commit.hash)
}

function parseCounts(raw: string): { ahead: number; behind: number } {
  // Для @{u}...HEAD первый счётчик — только upstream (behind),
  // второй — только локальная ветка (ahead).
  const [behind, ahead] = raw.trim().split(/\s+/).map(Number)
  return { ahead: Number.isFinite(ahead) ? ahead : 0, behind: Number.isFinite(behind) ? behind : 0 }
}

export class GitSyncManager {
  private timer: NodeJS.Timeout | null = null
  private checking = false
  private state: GitSyncState = { enabled: true, checking: false, projects: [], lastCheckedAt: 0 }
  private notificationProjects = new Map<string, string>()
  private notifiedSignatures = new Map<string, string>()
  /** Проверки после chat:send: workdir → promise, чтобы быстрые сообщения
   * не запускали несколько fetch одного репозитория одновременно. */
  private workdirChecks = new Map<string, Promise<void>>()

  constructor(
    private readonly store: Store,
    private readonly mainWindow: MainWindow,
    private readonly notifications: NotificationManager,
  ) {
    this.state.enabled = this.readEnabled()
  }

  start(): void {
    if (this.timer || !this.readEnabled()) return
    this.state.enabled = true
    this.publish()
    // Первый fetch после регистрации IPC/инициализации БД. Уведомление
    // намеренно включено: пользователь должен узнать об обновлениях сразу.
    void this.checkNow(true)
    this.timer = setInterval(() => { void this.checkNow(true) }, POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  setEnabled(enabled: boolean): void {
    this.state.enabled = enabled
    if (!enabled) {
      this.stop()
      this.state = { enabled: false, checking: false, projects: [], lastCheckedAt: this.state.lastCheckedAt }
      this.publish()
      return
    }
    this.start()
  }

  getState(): GitSyncState {
    return this.state
  }

  /**
   * Неблокирующая проверка репозитория после отправки сообщения.
   * Метод сам запускает работу и сразу возвращает Promise<void>; вызывающий
   * код использует void и не добавляет Git в критический путь chat:send.
   */
  checkWorkdir(workdir: string, notify = true): void {
    const normalized = workdir.trim()
    if (!normalized || !this.readEnabled()) return
    if (this.workdirChecks.has(normalized)) return

    const project = getAllProjects().find(item => item.workdir === workdir)
    if (!project) return
    const task = this.checkProject(project.id, project.name, project.workdir, notify)
      .then(result => {
        const current = this.state.projects.filter(item => item.workdir !== project.workdir)
        this.state = {
          ...this.state,
          enabled: true,
          projects: result ? [...current, result] : current,
          lastCheckedAt: Date.now(),
        }
        this.publish()
      })
      .catch(error => {
        console.warn(`[git-sync] post-send check failed for ${normalized}:`, String((error as Error)?.message ?? error))
      })
      .finally(() => {
        this.workdirChecks.delete(normalized)
      })
    this.workdirChecks.set(normalized, task)
  }

  async checkNow(notify = false): Promise<GitSyncState> {
    if (!this.readEnabled()) {
      this.setEnabled(false)
      return this.state
    }
    if (this.checking) return this.state
    this.checking = true
    this.state = { ...this.state, enabled: true, checking: true }
    this.publish()

    try {
      const projects = getAllProjects()
      const next: GitSyncProjectState[] = []
      for (const project of projects) {
        const result = await this.checkProject(project.id, project.name, project.workdir, notify)
        if (result) next.push(result)
      }
      this.state = { enabled: true, checking: false, projects: next, lastCheckedAt: Date.now() }
      this.publish()
    } catch (error) {
      this.state = { ...this.state, checking: false, lastCheckedAt: Date.now() }
      this.publish()
      console.warn('[git-sync] check failed:', error)
    } finally {
      this.checking = false
    }
    return this.state
  }

  async apply(projectId: string): Promise<{ success: boolean; error?: string; state: GitSyncState }> {
    const project = this.state.projects.find(item => item.projectId === projectId)
    if (!project) return { success: false, error: 'Git sync project not found', state: this.state }
    if (project.diverged) return { success: false, error: 'Ветки разошлись — автоматический pull отключён', state: this.state }
    try {
      await runGit(project.workdir, ['pull', '--ff-only'], { timeoutMs: FETCH_TIMEOUT_MS })
      this.clearDeferred(project)
      this.notifiedSignatures.delete(projectId)
      await this.checkNow(false)
      return { success: true, state: this.state }
    } catch (error) {
      const message = String((error as Error)?.message ?? error)
      return { success: false, error: message, state: this.state }
    }
  }

  later(projectId: string): GitSyncState {
    const project = this.state.projects.find(item => item.projectId === projectId)
    if (!project) return this.state
    this.notifiedSignatures.delete(projectId)
    const deferred = this.readDeferred()
    const key = deferredKey(project.workdir, project.branch, project.upstream)
    const previous = new Set(deferred[key] ?? [])
    for (const commit of project.commits) previous.add(commit.hash)
    deferred[key] = [...previous].slice(-200)
    this.writeDeferred(deferred)
    this.state = { ...this.state, projects: this.state.projects.filter(item => item.projectId !== projectId) }
    this.publish()
    return this.state
  }

  async handleNotificationAction(notificationId: string, actionId: string): Promise<void> {
    const projectId = this.notificationProjects.get(notificationId)
    if (!projectId) return
    if (actionId === 'apply') {
      const result = await this.apply(projectId)
      if (!result.success) {
        const errorId = `git-sync-error-${projectId}-${Date.now()}`
        this.notificationProjects.set(errorId, projectId)
        this.notifications.push({
          id: errorId,
          type: 'git_sync', priority: 'warning', title: 'Git: не удалось применить обновления',
          body: result.error ?? 'Ветки могли разойтись. Откройте Git-панель.',
          actions: [{ id: 'open-git', label: 'Открыть Git', icon: 'git' }],
        })
      }
    } else if (actionId === 'later') {
      this.later(projectId)
    } else if (actionId === 'open-git') {
      this.openGit(projectId)
    }
    this.notificationProjects.delete(notificationId)
  }

  private async checkProject(projectId: string, projectName: string, workdir: string, notify: boolean): Promise<GitSyncProjectState | null> {
    try {
      const branch = (await runGit(workdir, ['symbolic-ref', '--short', 'HEAD'], { timeoutMs: FETCH_TIMEOUT_MS })).trim()
      if (!branch) return null
      const upstream = (await runGit(workdir, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { timeoutMs: FETCH_TIMEOUT_MS })).trim()
      if (!upstream) return null
      await runGit(workdir, ['fetch', '--prune'], { timeoutMs: FETCH_TIMEOUT_MS })
      const counts = parseCounts(await runGit(workdir, ['rev-list', '--left-right', '--count', '@{u}...HEAD'], { timeoutMs: FETCH_TIMEOUT_MS }))
      const commits = parseCommits(await runGit(workdir, [
        'log', 'HEAD..@{u}', `--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e`, '--date=short', `--max-count=${MAX_COMMITS}`,
      ], { timeoutMs: FETCH_TIMEOUT_MS }))
      const deferred = this.readDeferred()
      const key = deferredKey(workdir, branch, upstream)
      const remoteHashes = new Set(commits.map(commit => commit.hash))
      const deferredHashes = (deferred[key] ?? []).filter(hash => remoteHashes.has(hash))
      if (deferredHashes.length !== (deferred[key] ?? []).length) {
        deferred[key] = deferredHashes
        this.writeDeferred(deferred)
      }
      const visibleCommits = commits.filter(commit => !deferredHashes.includes(commit.hash))
      const result: GitSyncProjectState = {
        projectId, projectName, workdir, branch, upstream,
        commits: visibleCommits, ahead: counts.ahead, behind: counts.behind,
        diverged: counts.ahead > 0 && counts.behind > 0,
        lastCheckedAt: Date.now(),
      }
      if (notify && (visibleCommits.length > 0 || result.diverged)) this.notifyProject(result)
      if (visibleCommits.length === 0 && !result.diverged) return null
      return result
    } catch (error) {
      // A repository without an upstream, detached HEAD, or a transient fetch
      // failure should not create a noisy badge. Keep the error only in logs.
      console.warn(`[git-sync] ${workdir}:`, String((error as Error)?.message ?? error))
      return null
    }
  }

  private notifyProject(project: GitSyncProjectState): void {
    const signature = `${project.branch}|${project.upstream}|${project.diverged ? 'diverged' : project.commits.map(commit => commit.hash).join(',')}`
    if (this.notifiedSignatures.get(project.projectId) === signature) return
    this.notifiedSignatures.set(project.projectId, signature)
    const id = `git-sync-${project.projectId}-${project.lastCheckedAt}`
    this.notificationProjects.set(id, project.projectId)
    const count = project.commits.length
    const body = project.diverged
      ? `${project.projectName}: ветки ${project.branch} и ${project.upstream} разошлись. Новых коммитов: ${count}.`
      : `${project.projectName}: ${project.upstream} опережает локальную ветку на ${count} коммит${count === 1 ? '' : count < 5 ? 'а' : 'ов'}.`
    this.notifications.push({
      id, type: 'git_sync', title: 'Доступны Git-обновления', body, priority: project.diverged ? 'warning' : 'info',
      actions: [
        { id: 'apply', label: 'Применить', icon: 'download' },
        { id: 'later', label: 'Позже', icon: 'clock' },
        { id: 'open-git', label: 'Открыть Git', icon: 'git' },
      ], duration: 0,
    })
  }

  private openGit(projectId: string): void {
    const project = this.state.projects.find(item => item.projectId === projectId)
    this.mainWindow.show()
    this.mainWindow.getWindow()?.webContents.send('nav:open-git', { workdir: project?.workdir })
  }

  private clearDeferred(project: GitSyncProjectState): void {
    const deferred = this.readDeferred()
    delete deferred[deferredKey(project.workdir, project.branch, project.upstream)]
    this.writeDeferred(deferred)
  }

  private readEnabled(): boolean {
    return this.store.get('gitSyncEnabled', true) !== false
  }

  private readDeferred(): DeferredMap {
    const raw = this.store.get(DEFERRED_STORE_KEY, {})
    return raw && typeof raw === 'object' ? raw as DeferredMap : {}
  }

  private writeDeferred(value: DeferredMap): void {
    this.store.set(DEFERRED_STORE_KEY, value)
  }

  private publish(): void {
    const win: BrowserWindow | null = this.mainWindow.getWindow()
    win?.webContents.send(IPC_EVENTS.GIT_SYNC_STATE, this.state)
  }
}

let globalInstance: GitSyncManager | null = null

export function initGitSyncManager(store: Store, mainWindow: MainWindow, notifications: NotificationManager): GitSyncManager {
  globalInstance = new GitSyncManager(store, mainWindow, notifications)
  return globalInstance
}

export function getGitSyncManager(): GitSyncManager | null {
  return globalInstance
}

export function registerGitSyncIPC(manager: GitSyncManager): void {
  ipcMain.handle('git-sync:getState', () => manager.getState())
  ipcMain.handle('git-sync:checkNow', () => manager.checkNow(false))
  ipcMain.handle('git-sync:apply', (_event, projectId: string) => manager.apply(projectId))
  ipcMain.handle('git-sync:later', (_event, projectId: string) => manager.later(projectId))
}
