/**
 * Простой файловый логгер для дебага.
 * Пишет в C:\Projects\SynteeHelper\logs\debug.log
 *
 * ВАЖНО: этот модуль импортируется и главным процессом, и worker_threads
 * (ai-worker.ts → AIClient.ts → logger). Транкация лога при старте должна
 * выполняться ТОЛЬКО в главном потоке — иначе каждый новый Worker будет
 * затирать лог при каждом chat:send.
 */
import * as fs from 'fs'
import * as path from 'path'
import { isMainThread } from 'worker_threads'

const logDir = path.join('C:\\Projects\\SynteeHelper', 'logs')
const logFile = path.join(logDir, 'debug.log')

if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })

// Очищаем лог при старте приложения — только в главном потоке.
// Worker-потоки наследуют уже открытый файл и только дописывают в него.
if (isMainThread) {
  fs.writeFileSync(logFile, `=== SynteeHelper Debug Log — ${new Date().toISOString()} ===\n`)
}

export function log(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args.map(a =>
    typeof a === 'string' ? a : JSON.stringify(a)
  ).join(' ')}\n`
  fs.appendFileSync(logFile, line)
}
