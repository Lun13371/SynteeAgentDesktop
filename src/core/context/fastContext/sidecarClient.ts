import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import {
  acquireSidecarLock, releaseSidecarLock, getSidecarLockSnapshot,
  type SidecarLockSnapshot,
} from './sidecarLock'

/** Wire format used by the optional Rust Fast Context sidecar. */
export interface SidecarDefinition {
  name: string
  kind: string
  signature: string
  lineStart: number
  lineEnd: number
  parentName?: string
}

export interface SidecarTopFile {
  path: string
  score: number
  definitions: SidecarDefinition[]
  imports?: string[]
  content?: string
}

export interface SidecarSearchResult {
  slice: string
  topFiles: SidecarTopFile[]
  indexedFilesCount?: number
}

export interface SidecarIndexResult {
  filesFound?: number
  filesChanged?: number
  filesRemoved?: number
  hitCap?: boolean
  complete?: boolean
  hadErrors?: boolean
  [key: string]: unknown
}

export interface SidecarHealthResult {
  ok: boolean
  status?: string
  protocolVersion?: number
  [key: string]: unknown
}

export interface SidecarStatusResult {
  active: boolean
  foregroundBusy: boolean
  pendingPaths: number
  filesChanged: number
  filesRemoved: number
  batches: number
  debounceMs: number
  lastError: string | null
  indexedFilesCount?: number | null
  [key: string]: unknown
}

export type SidecarAvailability = 'unknown' | 'starting' | 'ready' | 'unavailable' | 'stopped'

export type SidecarErrorCode =
  | 'disabled'
  | 'binary_missing'
  | 'database_missing'
  | 'spawn_failed'
  | 'protocol_error'
  | 'request_failed'
  | 'index_unavailable'
  | 'timeout'
  | 'unavailable'

export class SidecarError extends Error {
  readonly code: SidecarErrorCode
  readonly retryable: boolean
  readonly status: SidecarAvailability

  constructor(code: SidecarErrorCode, message: string, options: { retryable?: boolean; status?: SidecarAvailability } = {}) {
    super(message)
    this.name = 'SidecarError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.status = options.status ?? 'unavailable'
  }
}

type JsonRecord = Record<string, unknown>
type PendingRequest = {
  resolve: (value: JsonRecord) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 30_000
const HEALTH_TIMEOUT_MS = 5_000
const MAX_RESTART_BACKOFF_MS = 10_000
const SIDECAR_EXE_NAME = process.platform === 'win32' ? 'syntee-sidecar.exe' : 'syntee-sidecar'
// The main process passes the absolute DB path via SYNTEE_DB_PATH.

let child: ChildProcessWithoutNullStreams | null = null
let stdoutBuffer = ''
let nextRequestId = 1
let restartTimer: ReturnType<typeof setTimeout> | null = null
let restartAttempt = 0
let shuttingDown = false
let availability: SidecarAvailability = 'unknown'
let lastError: SidecarError | null = null
let holdsLock = false
const failureHandlers = new Set<(error: SidecarError) => void>()
const pending = new Map<string, PendingRequest>()

/** Which sidecar processes are alive right now (main + worker threads). */
export function getSidecarProcesses(): SidecarLockSnapshot {
  return getSidecarLockSnapshot()
}

export function setSidecarFailureHandler(handler: ((error: SidecarError) => void) | null): void {
  failureHandlers.clear()
  if (handler) failureHandlers.add(handler)
}

export function addSidecarFailureHandler(handler: (error: SidecarError) => void): () => void {
  failureHandlers.add(handler)
  return () => failureHandlers.delete(handler)
}

export function getSidecarAvailability(): SidecarAvailability { return availability }
export function getSidecarError(): SidecarError | null { return lastError }

function asSidecarError(error: unknown, fallbackCode: SidecarErrorCode = 'request_failed'): SidecarError {
  if (error instanceof SidecarError) return error
  const message = errorMessage(error)
  const code = /timed out/i.test(message) ? 'timeout' : fallbackCode
  return new SidecarError(code, message, { retryable: code === 'timeout' || code === 'spawn_failed' })
}

function markUnavailable(error: unknown): SidecarError {
  const normalized = asSidecarError(error, 'unavailable')
  availability = 'unavailable'
  lastError = normalized
  logSidecar('unavailable', normalized)
  for (const handler of failureHandlers) {
    try { handler(normalized) } catch { /* diagnostics must not crash main */ }
  }
  return normalized
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function logSidecar(message: string, error?: unknown): void {
  // Sidecar is optional. Logging must never make the main process fail.
  try {
    console.warn(`[fast-context-sidecar] ${message}${error ? `: ${errorMessage(error)}` : ''}`)
  } catch { /* best effort */ }
}

function candidatePaths(): string[] {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates = [
    // Packaged electron-builder layout.
    resourcesPath ? join(resourcesPath, 'sidecar', SIDECAR_EXE_NAME) : '',
    resourcesPath ? join(resourcesPath, SIDECAR_EXE_NAME) : '',
    // electron-vite dev / `npm start` layouts.
    join(process.cwd(), 'resources', 'sidecar', SIDECAR_EXE_NAME),
    join(process.cwd(), 'Sidecar', 'target', 'release', SIDECAR_EXE_NAME),
    join(process.cwd(), 'Sidecar', 'target', 'debug', SIDECAR_EXE_NAME),
    join(__dirname, '../../resources/sidecar', SIDECAR_EXE_NAME),
    join(__dirname, '../../../resources/sidecar', SIDECAR_EXE_NAME),
  ]
  return candidates.filter(Boolean)
}

/** Resolve without throwing; strict callers turn a missing binary into a typed error. */
export function resolveSidecarPath(): string | null {
  for (const candidate of candidatePaths()) {
    try {
      if (existsSync(candidate)) return candidate
    } catch { /* inaccessible candidate */ }
  }
  return null
}

/** Rust is the only Fast Context backend.
 *
 * There used to be a TypeScript fallback behind `SYNTEE_USE_SIDECAR=0` /
 * `SYNTEE_USE_TYPESCRIPT_FAST_CONTEXT=1`. It is gone on purpose: two
 * implementations with different indexing rules and ranking made failures
 * invisible and results unreproducible. A missing or crashed sidecar is now a
 * typed SidecarError the caller has to handle. */

function rejectPending(error: Error): void {
  for (const [id, request] of pending) {
    clearTimeout(request.timer)
    request.reject(error)
    pending.delete(id)
  }
}

function handleLine(line: string): void {
  if (!line.trim()) return
  let message: JsonRecord
  try {
    message = JSON.parse(line) as JsonRecord
  } catch (error) {
    logSidecar('invalid JSON on stdout', error)
    return
  }
  const id = String(message.id ?? message.requestId ?? '')
  const request = pending.get(id)
  if (!request) return
  clearTimeout(request.timer)
  pending.delete(id)
  if (message.ok === false || message.error != null) {
    const raw = message.error
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? message)
    request.reject(new Error(text || 'Sidecar request failed'))
    return
  }
  request.resolve((message.result && typeof message.result === 'object'
    ? message.result
    : message) as JsonRecord)
}

function scheduleRestart(): void {
  if (shuttingDown || restartTimer || !resolveSidecarPath()) return
  const delay = Math.min(250 * (2 ** restartAttempt), MAX_RESTART_BACKOFF_MS)
  restartAttempt++
  availability = 'starting'
  restartTimer = setTimeout(() => {
    restartTimer = null
    try { ensureChild() } catch (error) {
      markUnavailable(new SidecarError('spawn_failed', `Sidecar restart failed: ${errorMessage(error)}`, { retryable: true }))
    }
  }, delay)
  restartTimer.unref?.()
}

function onExit(processRef: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null): void {
  if (child !== processRef) return
  child = null
  stdoutBuffer = ''
  if (holdsLock) {
    holdsLock = false
    releaseSidecarLock()
  }
  const reason = `Sidecar exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`
  const error = markUnavailable(new SidecarError('unavailable', reason, { retryable: true }))
  rejectPending(error)
  if (!shuttingDown) {
    logSidecar(`${reason}; will retry with backoff`)
    scheduleRestart()
  }
}

function ensureChild(): ChildProcessWithoutNullStreams {
  if (child && !child.killed) return child
  const executable = resolveSidecarPath()
  if (!executable) {
    throw new SidecarError('binary_missing', 'Rust Fast Context sidecar executable not found', { retryable: false })
  }
  shuttingDown = false
  availability = 'starting'
  const processRef = spawn(executable, [], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child = processRef
  stdoutBuffer = ''
  // Register this thread in the lock registry. Main and each ai-worker thread
  // own their own child; the registry makes duplicates and orphans visible.
  const lock = acquireSidecarLock()
  holdsLock = lock.lockPath !== null
  if (lock.duplicate) {
    const others = lock.others
      .map(holder => `${holder.owner} pid=${holder.pid} thread=${holder.threadId}`)
      .join(', ')
    logSidecar(`another sidecar instance is already running (${others}); this thread started its own`)
  }
  processRef.stdout.setEncoding('utf8')
  processRef.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk
    let newline = stdoutBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline)
      stdoutBuffer = stdoutBuffer.slice(newline + 1)
      handleLine(line)
      newline = stdoutBuffer.indexOf('\n')
    }
  })
  processRef.stderr.setEncoding('utf8')
  processRef.stderr.on('data', (chunk: string) => logSidecar(`stderr: ${String(chunk).trim()}`))
  processRef.once('error', error => {
    logSidecar('process error', error)
    // `error` is followed by `exit` on most platforms, but guard against
    // implementations that only emit `error` to avoid duplicate cleanup.
    onExit(processRef, null, null)
  })
  processRef.once('exit', (code, signal) => onExit(processRef, code, signal))
  restartAttempt = 0
  return processRef
}

async function request(command: string, payload: JsonRecord = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<JsonRecord> {
  const processRef = ensureChild()
  const id = String(nextRequestId++)
  // The Rust sidecar uses the stable `{id, method, params}` JSONL envelope.
  // Accepting a nested `params` here keeps call sites explicit and prevents
  // protocol fields from leaking into command parameters.
  const params = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
    ? payload.params
    : payload
  const message = JSON.stringify({ id, method: command, params }) + '\n'
  return new Promise<JsonRecord>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Sidecar ${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    try {
      processRef.stdin.write(message, error => {
        if (!error) return
        clearTimeout(timer)
        pending.delete(id)
        reject(error)
      })
    } catch (error) {
      clearTimeout(timer)
      pending.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function normalizeDefinition(value: unknown): SidecarDefinition | null {
  if (!value || typeof value !== 'object') return null
  const d = value as JsonRecord
  if (typeof d.name !== 'string') return null
  return {
    name: d.name,
    kind: typeof d.kind === 'string' ? d.kind : 'symbol',
    signature: typeof d.signature === 'string' ? d.signature : d.name,
    lineStart: typeof d.lineStart === 'number' ? d.lineStart : 0,
    lineEnd: typeof d.lineEnd === 'number' ? d.lineEnd : typeof d.lineStart === 'number' ? d.lineStart : 0,
    parentName: typeof d.parentName === 'string' ? d.parentName : undefined,
  }
}

function databasePath(): string {
  const explicit = process.env.SYNTEE_DB_PATH
  if (explicit) return explicit
  // Main sets SYNTEE_DB_PATH during startup. Keeping the client free of an
  // Electron import also makes it safe to reuse from worker-thread code.
  return ''
}

function sidecarParams(extra: JsonRecord): JsonRecord {
  const dbPath = databasePath()
  if (!dbPath) throw new Error('SYNTEE_DB_PATH is not configured')
  return { dbPath, ...extra }
}

function normalizeSearchResult(result: JsonRecord, maxFiles: number, maxTokens: number): SidecarSearchResult {
  const rawFiles = result.topFiles ?? result.top_files ?? result.files ?? result.results
  const topFiles: SidecarTopFile[] = Array.isArray(rawFiles) ? rawFiles.flatMap(raw => {
    if (!raw || typeof raw !== 'object') return []
    const file = raw as JsonRecord
    const path = typeof file.path === 'string' ? file.path
      : typeof file.filePath === 'string' ? file.filePath
        : typeof file.file_path === 'string' ? file.file_path : ''
    if (!path) return []
    const rawDefinitions = file.definitions ?? file.symbols
    const definitions = Array.isArray(rawDefinitions)
      ? rawDefinitions.flatMap(definition => { const normalized = normalizeDefinition(definition); return normalized ? [normalized] : [] })
      : []
    return [{
      path,
      score: typeof file.score === 'number' ? file.score
        : typeof file.rankedScore === 'number' ? file.rankedScore
          : typeof file.ranked_score === 'number' ? file.ranked_score : 0,
      definitions,
      imports: Array.isArray(file.imports) ? file.imports.filter((v): v is string => typeof v === 'string') : undefined,
      content: typeof file.content === 'string' ? file.content : undefined,
    }]
  }).slice(0, maxFiles) : []

  let slice = typeof result.slice === 'string' ? result.slice
    : typeof result.repoMap === 'string' ? result.repoMap
      : typeof result.repo_map === 'string' ? result.repo_map : ''
  if (!slice) {
    const lines: string[] = []
    let tokenEstimate = 0
    for (const file of topFiles) {
      const rows = [file.path]
      if (file.content) rows.push(file.content)
      else rows.push(...file.definitions.slice(0, 12).map(d => `  L${d.lineStart} ${d.kind} ${d.signature}`))
      const cost = rows.reduce((sum, row) => sum + Math.ceil(row.length / 4), 0)
      if (tokenEstimate + cost > maxTokens && lines.length > 0) break
      lines.push(...rows, '')
      tokenEstimate += cost
    }
    slice = lines.join('\n')
  }
  return {
    slice,
    topFiles,
    indexedFilesCount: typeof result.indexedFilesCount === 'number' ? result.indexedFilesCount
      : typeof result.indexed_files_count === 'number' ? result.indexed_files_count
        : typeof result.totalFiles === 'number' ? result.totalFiles
          : typeof result.appliedMaxFiles === 'number' ? result.appliedMaxFiles : undefined,
  }
}

async function requestWithRecovery(command: string, payload: JsonRecord = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<JsonRecord> {
  try {
    const result = await request(command, payload, timeoutMs)
    availability = 'ready'
    lastError = null
    return result
  } catch (error) {
    const first = markUnavailable(error)
    if (!first.retryable || shuttingDown) throw first
    scheduleRestart()
    const delay = Math.min(250 * (2 ** Math.min(restartAttempt, 4)), MAX_RESTART_BACKOFF_MS)
    await new Promise<void>(resolve => setTimeout(resolve, delay))
    try {
      const result = await request(command, payload, timeoutMs)
      availability = 'ready'
      lastError = null
      return result
    } catch (retryError) {
      throw markUnavailable(retryError)
    }
  }
}

export async function sidecarIndex(
  projectId: string,
  workdir: string,
  settings?: JsonRecord,
): Promise<SidecarIndexResult> {
  const options = settings ? {
    maxFiles: typeof settings.maxFiles === 'number' ? settings.maxFiles : undefined,
    maxFileSizeKb: typeof settings.maxFileSizeKb === 'number' ? settings.maxFileSizeKb : undefined,
    ignoreDirs: Array.isArray(settings.ignoreDirs) ? settings.ignoreDirs : undefined,
    // Identifiers matter for lexical retrieval: without references a query like
    // "module manager" misses files that only mention those names in code.
    skipReferences: false,
  } : undefined
  return await requestWithRecovery('index', {
    params: sidecarParams({ projectId, workdir, ...(options ? { options } : {}) }),
  }) as SidecarIndexResult
}

export async function sidecarSearch(
  projectId: string,
  query: string,
  maxFiles = 50,
  maxTokens = 8000,
): Promise<SidecarSearchResult> {
  const result = await requestWithRecovery('search', {
    params: sidecarParams({ projectId, query, maxFiles, maxTokens }),
  })
  return normalizeSearchResult(result, maxFiles, maxTokens)
}

export async function sidecarStartWatching(
  projectId: string,
  workdir: string,
  settings?: JsonRecord,
): Promise<JsonRecord> {
  const options = settings ? {
    maxFiles: typeof settings.maxFiles === 'number' ? settings.maxFiles : undefined,
    maxFileSizeKb: typeof settings.maxFileSizeKb === 'number' ? settings.maxFileSizeKb : undefined,
    ignoreDirs: Array.isArray(settings.ignoreDirs) ? settings.ignoreDirs : undefined,
    skipReferences: false,
  } : undefined
  return requestWithRecovery('startWatching', {
    params: sidecarParams({ projectId, workdir, ...(options ? { options } : {}) }),
  })
}

export async function sidecarStopWatching(): Promise<JsonRecord> {
  return requestWithRecovery('stopWatching', { params: sidecarParams({}) })
}

export async function sidecarForegroundBusy(busy: boolean): Promise<JsonRecord> {
  return requestWithRecovery('foregroundBusy', { params: { busy } })
}

export async function sidecarStatus(): Promise<SidecarStatusResult> {
  return await requestWithRecovery('status', { params: sidecarParams({}) }, HEALTH_TIMEOUT_MS) as SidecarStatusResult
}

export async function sidecarIndexChangedPaths(
  projectId: string,
  workdir: string,
  changedPaths: string[],
  settings?: JsonRecord,
): Promise<SidecarIndexResult> {
  return await requestWithRecovery('indexChangedPaths', {
    params: sidecarParams({ projectId, workdir, changedPaths, options: settings ?? {} }),
  }) as SidecarIndexResult
}

export async function sidecarClear(projectId: string): Promise<JsonRecord> {
  return requestWithRecovery('clear', { params: sidecarParams({ projectId }) })
}

export async function sidecarHealth(): Promise<SidecarHealthResult> {
  const result = await requestWithRecovery('health', { params: sidecarParams({}) }, HEALTH_TIMEOUT_MS)
  const dbReady = result.dbReady !== false
  return { ok: result.ok !== false && dbReady, ...result, dbReady } as SidecarHealthResult
}

/** Best-effort graceful shutdown; safe to call more than once. */
export async function shutdownSidecar(): Promise<void> {
  shuttingDown = true
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  const processRef = child
  if (!processRef) {
    if (holdsLock) {
      holdsLock = false
      releaseSidecarLock()
    }
    return
  }
  try {
    await request('shutdown', {}, 1_000)
  } catch { /* process may already have crashed */ }
  try { processRef.stdin.end() } catch { /* noop */ }
  const killTimer = setTimeout(() => {
    try { if (!processRef.killed) processRef.kill() } catch { /* noop */ }
  }, 1_000)
  killTimer.unref?.()
  child = null
  availability = 'stopped'
  if (holdsLock) {
    holdsLock = false
    releaseSidecarLock()
  }
  rejectPending(new SidecarError('unavailable', 'Sidecar shutting down', { status: 'stopped' }))
}

export const teardownSidecar = shutdownSidecar
