/**
 * Простой файловый логгер для дебага.
 * Пишет в C:\Projects\SynteeHelper\logs\debug.log
 */
import * as fs from 'fs'
import * as path from 'path'

const logDir = path.join('C:\\Projects\\SynteeHelper', 'logs')
const logFile = path.join(logDir, 'debug.log')

if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })

// Очищаем при старте
fs.writeFileSync(logFile, `=== SynteeHelper Debug Log — ${new Date().toISOString()} ===\n`)

export function log(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args.map(a =>
    typeof a === 'string' ? a : JSON.stringify(a)
  ).join(' ')}\n`
  fs.appendFileSync(logFile, line)
}
