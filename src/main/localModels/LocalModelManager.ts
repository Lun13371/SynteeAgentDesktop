import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'
import { cpus } from 'os'
import { app, webContents } from 'electron'
import { log } from '../../core/logger'
import { getModelPath, detectModelSize, isModelDownloaded, downloadModel, type ModelSize } from '../assistants/modelManager'
import { getLlamaServerPath, isBinaryReady, downloadBinary } from '../assistants/binaryManager'

export type ManagerState = 'idle' | 'preparing' | 'starting' | 'ready' | 'error'
export type QueuePriority = 'watcher' | 'janitor' | 'default'

export interface CompleteOptions {
  priority?: QueuePriority
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
}

export interface ManagerStatus {
  state: ManagerState
  modelSize: ModelSize
  modelDownloaded: boolean
  binaryReady: boolean
  port: number
  restarts: number
  queueLength: number
  idleUnloaded: boolean
  lastError?: string
}

export interface SetupProgress {
  phase: 'binary' | 'model' | 'starting' | 'ready' | 'error'
  percent: number
  error?: string
}

interface QueueItem {
  priority: QueuePriority
  prompt: string
  maxTokens: number
  temperature: number
  timeoutMs: number
  resolve: (text: string) => void
  reject: (err: Error) => void
  ts: number
}

const DEFAULT_PORT = 18474
const HEALTH_INTERVAL_MS = 10_000
const IDLE_UNLOAD_MS = 5 * 60_000
const STARTUP_TIMEOUT_MS = 60_000
const MAX_QUEUE = 8
const MAX_RESTARTS = 3
const RESTART_BACKOFF_MS = [1000, 3000, 8000]
const PRIORITY_ORDER: Record<QueuePriority, number> = { watcher: 0, default: 1, janitor: 2 }

class LocalModelManager {
  private state: ManagerState = 'idle'
  private process: ChildProcess | null = null
  private port = DEFAULT_PORT
  private modelSize: ModelSize = detectModelSize()
  private ensurePromise: Promise<boolean> | null = null
  private watchdog: NodeJS.Timeout | null = null
  private restarts = 0
  private lastError: string | undefined
  private queue: QueueItem[] = []
  private processing = false
  private stateListeners: Array<(s: ManagerState) => void> = []
  private progressListeners: Array<(p: SetupProgress) => void> = []
  private shuttingDown = false
  private lastActivity = Date.now()
  private idleUnloaded = false

  // ── Public API ────────────────────────────────────────────────────────────

  getState(): ManagerState { return this.state }
  isReady(): boolean { return this.state === 'ready' }
  getPort(): number { return this.port }
  getBaseUrl(): string { return `http://127.0.0.1:${this.port}` }

  getStatus(): ManagerStatus {
    return {
      state: this.state,
      modelSize: this.modelSize,
      modelDownloaded: isModelDownloaded(this.modelSize),
      binaryReady: isBinaryReady(),
      port: this.port,
      restarts: this.restarts,
      queueLength: this.queue.length,
      idleUnloaded: this.idleUnloaded,
      lastError: this.lastError,
    }
  }

  onStateChange(fn: (s: ManagerState) => void): () => void {
    this.stateListeners.push(fn)
    return () => { this.stateListeners = this.stateListeners.filter(f => f !== fn) }
  }

  onProgress(fn: (p: SetupProgress) => void): () => void {
    this.progressListeners.push(fn)
    return () => { this.progressListeners = this.progressListeners.filter(f => f !== fn) }
  }

  setModelSize(size: ModelSize): void {
    if (size !== this.modelSize) {
      this.modelSize = size
      if (this.state === 'ready') void this.restart()
    }
  }

  /** Idempotent, single-flight: download binary+model if needed, start server. */
  ensureReady(): Promise<boolean> {
    if (this.state === 'ready') return Promise.resolve(true)
    if (this.ensurePromise) return this.ensurePromise
    this.ensurePromise = this.doEnsure().finally(() => { this.ensurePromise = null })
    return this.ensurePromise
  }

  /** Queued completion. Auto-ensures readiness; rejects cleanly if unavailable. */
  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    this.lastActivity = Date.now()
    const ready = await this.ensureReady()
    if (!ready) throw new Error(this.lastError ?? 'Local model not ready')
    return this.enqueue(prompt, opts)
  }

  shutdown(): void {
    this.shuttingDown = true
    this.stopWatchdog()
    this.killProcess()
    for (const item of this.queue.splice(0)) item.reject(new Error('Manager shutting down'))
    this.setState('idle')
    this.shuttingDown = false
  }

  // ── Preparation + spawn ───────────────────────────────────────────────────

  private async doEnsure(): Promise<boolean> {
    try {
      this.setState('preparing')
      this.emit({ phase: 'binary', percent: 0 })
      if (!isBinaryReady()) {
        await downloadBinary(p => this.emit({ phase: 'binary', percent: p.percent, error: p.error }))
      }
      this.emit({ phase: 'model', percent: 0 })
      if (!isModelDownloaded(this.modelSize)) {
        await downloadModel(this.modelSize, p => this.emit({ phase: 'model', percent: p.percent, error: p.error }))
      }
      this.emit({ phase: 'starting', percent: 95 })
      const ok = await this.spawnServer()
      if (ok) {
        this.restarts = 0
        this.setState('ready')
        this.startWatchdog()
        this.emit({ phase: 'ready', percent: 100 })
        return true
      }
      this.setState('error')
      this.emit({ phase: 'error', percent: 0, error: this.lastError })
      return false
    } catch (err) {
      this.lastError = (err as Error).message
      log('[LocalModels] ensure failed: %s', this.lastError)
      this.setState('error')
      this.emit({ phase: 'error', percent: 0, error: this.lastError })
      return false
    }
  }

  private findBinary(): string | null {
    if (isBinaryReady()) return getLlamaServerPath()
    const candidates = [
      join(app.getAppPath(), 'resources', 'llama', 'llama-server.exe'),
      join(process.resourcesPath ?? '', 'llama', 'llama-server.exe'),
    ]
    for (const p of candidates) if (existsSync(p)) return p
    return null
  }

  private async spawnServer(): Promise<boolean> {
    const binary = this.findBinary()
    if (!binary) { this.lastError = 'llama-server binary not found'; return false }
    if (!isModelDownloaded(this.modelSize)) { this.lastError = `model ${this.modelSize} not downloaded`; return false }

    this.killProcess()
    const threads = Math.max(2, Math.min(8, cpus().length))
    const args = [
      '--model', getModelPath(this.modelSize),
      '--port', String(this.port),
      '--host', '127.0.0.1',
      '--threads', String(threads),
      '--ctx-size', '4096',
      '--batch-size', '512',
      '--log-disable',
    ]

    try {
      this.process = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      this.process.stderr?.on('data', (d: Buffer) => {
        const line = d.toString().trim()
        if (line) log('[LocalModels] %s', line.slice(0, 200))
      })
      this.process.on('exit', (code) => {
        log('[LocalModels] server exited code=%s', code)
        this.process = null
        this.stopWatchdog()
        if (!this.shuttingDown && this.state === 'ready') void this.handleCrash()
      })
      this.process.on('error', (err) => {
        log('[LocalModels] spawn error: %s', err.message)
        this.process = null
      })
      const up = await this.waitForHealth(STARTUP_TIMEOUT_MS)
      if (!up) { this.lastError = 'server did not become healthy'; this.killProcess(); return false }
      log('[LocalModels] ready port=%d model=%s threads=%d', this.port, this.modelSize, threads)
      return true
    } catch (err) {
      this.lastError = (err as Error).message
      return false
    }
  }

  private async waitForHealth(timeoutMs: number): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`${this.getBaseUrl()}/health`)
        if (res.ok) return true
      } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 500))
    }
    return false
  }

  // ── Watchdog + auto-restart ───────────────────────────────────────────────

  private startWatchdog(): void {
    this.stopWatchdog()
    this.watchdog = setInterval(async () => {
      if (this.state !== 'ready') return
      if (this.checkIdle()) return
      try {
        const res = await fetch(`${this.getBaseUrl()}/health`)
        if (!res.ok) void this.handleCrash()
      } catch {
        void this.handleCrash()
      }
    }, HEALTH_INTERVAL_MS)
  }

  /** Простой > 5 мин без вызовов — выгружаем сервер, RAM свободна; следующий вызов поднимет его сам. */
  private checkIdle(): boolean {
    if (this.queue.length > 0 || this.processing) return false
    if (Date.now() - this.lastActivity < IDLE_UNLOAD_MS) return false
    log('[LocalModels] idle >%d min — unloading server to free RAM', IDLE_UNLOAD_MS / 60_000)
    this.stopWatchdog()
    this.setState('idle')
    this.killProcess()
    this.restarts = 0
    this.idleUnloaded = true
    return true
  }

  private stopWatchdog(): void {
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null }
  }

  private async handleCrash(): Promise<void> {
    if (this.shuttingDown || this.state !== 'ready') return
    this.stopWatchdog()
    this.setState('error')
    if (this.restarts >= MAX_RESTARTS) {
      this.lastError = `server crashed ${this.restarts}× — giving up`
      log('[LocalModels] %s', this.lastError)
      this.emit({ phase: 'error', percent: 0, error: this.lastError })
      return
    }
    const delay = RESTART_BACKOFF_MS[Math.min(this.restarts, RESTART_BACKOFF_MS.length - 1)]
    this.restarts++
    log('[LocalModels] auto-restart #%d in %dms', this.restarts, delay)
    await new Promise(r => setTimeout(r, delay))
    const ok = await this.spawnServer()
    if (ok) {
      this.setState('ready')
      this.startWatchdog()
    } else {
      this.emit({ phase: 'error', percent: 0, error: this.lastError })
    }
  }

  private async restart(): Promise<void> {
    this.stopWatchdog()
    this.killProcess()
    this.setState('starting')
    const ok = await this.spawnServer()
    this.setState(ok ? 'ready' : 'error')
    if (ok) this.startWatchdog()
  }

  private killProcess(): void {
    if (this.process) {
      try { this.process.kill() } catch { /* already dead */ }
      this.process = null
    }
  }

  // ── Request queue ─────────────────────────────────────────────────────────

  private enqueue(prompt: string, opts: CompleteOptions): Promise<string> {
    const priority = opts.priority ?? 'default'
    if (this.queue.length >= MAX_QUEUE) {
      const dropIdx = this.queue.findIndex(q => q.priority === 'janitor')
      if (dropIdx >= 0) this.queue.splice(dropIdx, 1)[0].reject(new Error('Queue overflow'))
      else return Promise.reject(new Error('Queue full'))
    }
    return new Promise((resolve, reject) => {
      this.queue.push({
        priority, prompt,
        maxTokens: opts.maxTokens ?? 100,
        temperature: opts.temperature ?? 0.1,
        timeoutMs: opts.timeoutMs ?? 15_000,
        resolve, reject, ts: Date.now(),
      })
      this.queue.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.ts - b.ts)
      void this.processQueue()
    })
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return
    this.processing = true
    while (this.queue.length > 0) {
      const item = this.queue.shift()!
      try {
        item.resolve(await this.callLlm(item))
      } catch (err) {
        item.reject(err as Error)
      }
    }
    this.processing = false
  }

  private async callLlm(item: QueueItem): Promise<string> {
    this.lastActivity = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), item.timeoutMs)
    try {
      const res = await fetch(`${this.getBaseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: item.prompt }],
          max_tokens: item.maxTokens,
          temperature: item.temperature,
          stream: false,
        }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}`)
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
      return data.choices?.[0]?.message?.content?.trim() ?? ''
    } finally {
      clearTimeout(timer)
    }
  }

  // ── Events ────────────────────────────────────────────────────────────────

  private setState(s: ManagerState): void {
    this.state = s
    if (s === 'ready') { this.lastActivity = Date.now(); this.idleUnloaded = false }
    for (const fn of this.stateListeners) fn(s)
  }

  private emit(p: SetupProgress): void {
    for (const fn of this.progressListeners) fn(p)
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed()) wc.send('assistants:setupProgress', p)
    }
  }
}

export const localModels = new LocalModelManager()