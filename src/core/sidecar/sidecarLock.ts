/**
 * Sidecar lock registry.
 *
 * The Rust sidecar client keeps its child process in module scope, and worker
 * threads have their own module registry — so main and every active ai-worker
 * thread can spawn their own sidecar against the same SQLite file. That is
 * legitimate but wasteful, and it used to be invisible: nothing recorded how
 * many processes were alive or which thread owned them.
 *
 * This registry is a small JSON file next to the database listing live holders
 * (`pid:threadId`). It is diagnostics-grade, not a mutex: it answers "is the
 * Rust backend enabled, how many sidecars are running, and is this a duplicate
 * or an orphan?", and it is cleaned up when a holder exits.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'
import { isMainThread, threadId } from 'worker_threads'

export interface SidecarHolder {
  /** Process id owning the sidecar child. */
  pid: number
  /** worker_threads thread id inside that process. */
  threadId: number
  owner: 'main' | 'worker'
  /** Epoch ms when this holder spawned its sidecar. */
  startedAt: number
}

export interface SidecarLockSnapshot {
  lockPath: string | null
  holders: SidecarHolder[]
  /** Live holders other than the caller (empty when this thread is alone). */
  others: SidecarHolder[]
  /** True when more than one live sidecar process exists. */
  duplicate: boolean
}

const LOCK_FILE_NAME = 'syntee-sidecar.lock'
const self: SidecarHolder = {
  pid: process.pid,
  threadId,
  owner: isMainThread ? 'main' : 'worker',
  startedAt: 0,
}

function lockPath(): string | null {
  const dbPath = process.env.SYNTEE_DB_PATH
  if (!dbPath) return null
  try {
    return join(dirname(dbPath), LOCK_FILE_NAME)
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readHolders(path: string): SidecarHolder[] {
  try {
    if (!existsSync(path)) return []
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const entry = raw as Record<string, unknown>
      if (typeof entry.pid !== 'number' || typeof entry.threadId !== 'number') return []
      return [{
        pid: entry.pid,
        threadId: entry.threadId,
        owner: entry.owner === 'worker' ? 'worker' as const : 'main' as const,
        startedAt: typeof entry.startedAt === 'number' ? entry.startedAt : 0,
      }]
    })
  } catch {
    return []
  }
}

function writeHolders(path: string, holders: SidecarHolder[]): void {
  try {
    if (holders.length === 0) {
      if (existsSync(path)) unlinkSync(path)
      return
    }
    const temp = `${path}.tmp`
    writeFileSync(temp, JSON.stringify(holders), 'utf-8')
    renameSync(temp, path)
  } catch {
    /* diagnostics must never break the sidecar */
  }
}

/** Live holders only: a crashed process must not look like a running sidecar. */
function liveHolders(holders: SidecarHolder[]): SidecarHolder[] {
  return holders.filter(holder => isProcessAlive(holder.pid))
}

/**
 * Register this thread as a sidecar owner. Returns the previous live holders so
 * the caller can log/act on duplicates and stale entries from crashed processes.
 */
export function acquireSidecarLock(): SidecarLockSnapshot {
  const path = lockPath()
  if (!path) return { lockPath: null, holders: [], others: [], duplicate: false }
  const current = liveHolders(readHolders(path))
  const withoutSelf = current.filter(holder => !(holder.pid === self.pid && holder.threadId === self.threadId))
  const mine: SidecarHolder = { ...self, startedAt: Date.now() }
  const holders = [...withoutSelf, mine]
  writeHolders(path, holders)
  return { lockPath: path, holders, others: withoutSelf, duplicate: withoutSelf.length > 0 }
}

/** Unregister this thread (called when the sidecar child exits or is torn down). */
export function releaseSidecarLock(): void {
  const path = lockPath()
  if (!path) return
  const remaining = liveHolders(readHolders(path))
    .filter(holder => !(holder.pid === self.pid && holder.threadId === self.threadId))
  writeHolders(path, remaining)
}

/** Current live owners of a sidecar process (read-only, safe from any thread). */
export function getSidecarLockSnapshot(): SidecarLockSnapshot {
  const path = lockPath()
  if (!path) return { lockPath: null, holders: [], others: [], duplicate: false }
  const holders = liveHolders(readHolders(path))
  return { lockPath: path, holders, others: [], duplicate: holders.length > 1 }
}
