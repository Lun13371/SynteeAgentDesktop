/**
 * Простой файловый логгер для дебага.
 * Пишет в logs/debug.log в каталоге данных приложения или рабочем каталоге отладки.
 *
 * ВАЖНО: этот модуль импортируется и главным процессом, и worker_threads
 * (ai-worker.ts → AIClient.ts → logger). Транкация лога при старте должна
 * выполняться ТОЛЬКО в главном потоке — иначе каждый новый Worker будет
 * затирать лог при каждом chat:send.
 *
 * Буферизация: строки копятся в памяти и сбрасываются async каждые 1с
 * или при 100 строках. Это убирает sync I/O на каждый log() вызов.
 */
import * as fs from 'fs'
import * as path from 'path'
import { homedir } from 'os'
import { isMainThread } from 'worker_threads'

const xdgConfigHome = process.env.XDG_CONFIG_HOME ?? ''
const configHome = path.isAbsolute(xdgConfigHome) ? xdgConfigHome : path.join(homedir(), '.config')
const defaultDataDir = process.platform === 'win32'
  ? 'C:\\Projects\\SynteeHelper'
  : path.join(configHome, 'SynteeHelper')
const logDir = path.join(process.env.SYNTEE_USER_DATA_DIR || defaultDataDir, 'logs')
const logFile = path.join(logDir, 'debug.log')

let loggingEnabled = true
try {
  fs.mkdirSync(logDir, { recursive: true })
  if (isMainThread) {
    fs.writeFileSync(logFile, `=== SynteeHelper Debug Log — ${new Date().toISOString()} ===\n`)
  }
} catch (error) {
  loggingEnabled = false
  console.warn('[logger] Не удалось открыть файл журнала:', error)
}

let _buffer: string[] = []
let _flushTimer: NodeJS.Timeout | null = null
const FLUSH_INTERVAL_MS = 1000
const FLUSH_THRESHOLD = 100

function flushBuffer(): void {
  if (_buffer.length === 0) return
  const data = _buffer.join('')
  _buffer = []
  fs.appendFile(logFile, data, () => { /* best-effort */ })
}

function flushBufferSync(): void {
  if (_buffer.length === 0) return
  const data = _buffer.join('')
  _buffer = []
  try { fs.appendFileSync(logFile, data) } catch { /* ignore */ }
}

function scheduleFlush(): void {
  if (_flushTimer) return
  _flushTimer = setTimeout(() => {
    _flushTimer = null
    flushBuffer()
  }, FLUSH_INTERVAL_MS)
}

process.on('exit', flushBufferSync)

export function log(...args: unknown[]): void {
  if (!loggingEnabled) return
  const line = `[${new Date().toISOString()}] ${args.map(a =>
    typeof a === 'string' ? a : JSON.stringify(a)
  ).join(' ')}\n`
  _buffer.push(line)
  if (_buffer.length >= FLUSH_THRESHOLD) {
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null }
    flushBuffer()
  } else {
    scheduleFlush()
  }
}
