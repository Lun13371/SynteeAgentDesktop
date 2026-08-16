import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { runMigrations } from './migrations'

let db: Database.Database

export function getDB(): Database.Database {
  if (!db) throw new Error('DB not initialized')
  return db
}

/**
 * Инициализирует подключение к базе данных SQLite.
 *
 * Путь к файлу БД: `<userData>/syntee.db`, где `userData` — каталог данных
 * пользователя Electron (app.getPath('userData')). Каталог создаётся при
 * необходимости через mkdirSync с флагом recursive.
 *
 * Включает две SQLite-прагмы:
 *  - `journal_mode = WAL` — режим Write-Ahead Logging для повышения
 *    производительности конкурентного доступа и устойчивости к сбоям.
 *  - `foreign_keys = ON` — включает проверку внешних ключей.
 *
 * После открытия соединения запускает миграции (runMigrations).
 */
export function initDB(): void {
  const userData = app.getPath('userData')
  mkdirSync(userData, { recursive: true })
  const dbPath = join(userData, 'syntee.db')

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  runMigrations(db)
}
