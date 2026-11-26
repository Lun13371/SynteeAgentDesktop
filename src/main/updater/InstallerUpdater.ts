/**
 * InstallerUpdater — скачивает обновление в фоне и применяет его.
 *
 * Windows: NSIS-установщик запускается молча (`--updated /S --force-run`),
 * приложение закрывается перед этим и открывается заново после установки.
 *
 * Linux: переносимый `.tar.zst` распаковывается в `<installDir>.new`, затем
 * отдельный sh-скрипт дожидается выхода процесса, подменяет папку и
 * перезапускает приложение. Если папка установки недоступна на запись
 * (пакет из pacman в /opt или /usr) — самообновление запрещено, UI просит
 * обновиться через менеджер пакетов.
 *
 * Целостность: перед установкой SHA256 файла сверяется с `digest` ассета,
 * который отдал GitHub. Несовпадение — файл удаляется, установка отменяется.
 */
import { app } from 'electron'
import { createHash } from 'crypto'
import { createReadStream, createWriteStream, accessSync, constants, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { spawn } from 'child_process'
import { once } from 'events'
import { pipeline } from 'stream/promises'
import type { UpdateManifest } from '../../shared/types'

const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000

/** Куда складываются скачанные обновления (переживает перезапуск). */
export function updateCacheDir(): string {
  return join(app.getPath('temp'), 'syntee-update')
}

/** Папка установки приложения (рядом с resources/). null в dev-режиме. */
export function installDir(): string | null {
  if (!app.isPackaged) return null
  return dirname(process.resourcesPath)
}

function isWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK)
    accessSync(dirname(dir), constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Может ли приложение обновить себя само. На Linux это зависит от того, куда
 * оно установлено: пакет из pacman лежит в /opt или /usr и требует root.
 */
export function canSelfUpdate(): boolean {
  if (process.platform === 'win32') return true
  if (process.platform !== 'linux') return false
  const dir = installDir()
  return !!dir && isWritable(dir)
}

/** Причина, по которой самообновление недоступно (для UI). */
export function selfUpdateBlockedReason(): string {
  if (process.platform === 'linux') {
    return 'Обновление установлено пакетным менеджером. Обновите через pacman или скачайте новую версию со страницы релизов.'
  }
  return 'Автоматическое обновление недоступно на этой платформе.'
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

export type ProgressFn = (received: number, total: number) => void

/**
 * Скачивает ассет релиза в кэш и проверяет SHA256.
 * Возвращает путь к готовому файлу; при любой ошибке — бросает исключение
 * и не оставляет после себя недокачанных файлов.
 */
export async function downloadUpdate(manifest: UpdateManifest, onProgress: ProgressFn): Promise<string> {
  const dir = updateCacheDir()
  mkdirSync(dir, { recursive: true })

  const fileName = basename(new URL(manifest.zip_url).pathname) || `syntee-update-${manifest.version}`
  const target = join(dir, fileName)
  const partial = `${target}.part`
  rmSync(partial, { force: true })

  const response = await fetch(manifest.zip_url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  })
  if (!response.ok || !response.body) {
    throw new Error(`Не удалось скачать обновление: HTTP ${response.status}`)
  }

  const total = Number(response.headers.get('content-length')) || manifest.zip_size
  const sink = createWriteStream(partial)
  const reader = response.body.getReader()
  let received = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (!sink.write(Buffer.from(value))) await once(sink, 'drain')
      onProgress(received, total)
    }
  } catch (error) {
    reader.cancel().catch(() => {})
    sink.destroy()
    rmSync(partial, { force: true })
    throw error
  }

  await new Promise<void>((resolve, reject) => {
    sink.end((error?: Error | null) => (error ? reject(error) : resolve()))
  })

  const actual = await sha256File(partial)
  if (actual.toLowerCase() !== manifest.sha256.toLowerCase()) {
    rmSync(partial, { force: true })
    throw new Error('Контрольная сумма не совпала — файл повреждён, установка отменена')
  }

  rmSync(target, { force: true })
  renameSync(partial, target)
  return target
}

/** Запускает NSIS-установщик молча и завершает приложение. */
function applyWindowsInstaller(installerPath: string): void {
  spawnInstaller(installerPath)
  app.exit(0)
}

/**
 * Запускает установщик, не завершая приложение. Используется при выходе:
 * процесс и так закрывается, а NSIS сам дождётся освобождения файлов.
 */
export function spawnInstaller(installerPath: string): void {
  const child = spawn(installerPath, ['--updated', '/S', '--force-run'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

/** Скрипт подмены папки: ждёт выхода приложения, меняет каталоги, запускает новое. */
const SWAP_SCRIPT = `#!/bin/sh
set -e
PID="$1"; OLD="$2"; NEW="$3"; EXE="$4"
while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done
rm -rf "$OLD.bak"
mv "$OLD" "$OLD.bak"
mv "$NEW" "$OLD"
nohup "$OLD/$EXE" >/dev/null 2>&1 &
sleep 1
rm -rf "$OLD.bak"
`

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`${command} завершился с кодом ${code}`))
    })
  })
}

/** Распаковывает архив рядом с установкой и запускает скрипт подмены. */
async function applyLinuxArchive(archivePath: string, dir: string): Promise<void> {
  const staging = `${dir}.new`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  await run('tar', ['--zstd', '-xf', archivePath, '-C', staging])

  const script = join(app.getPath('temp'), `syntee-swap-${Date.now()}.sh`)
  writeFileSync(script, SWAP_SCRIPT, { mode: 0o755 })

  const child = spawn('/bin/sh', [script, String(process.pid), dir, staging, basename(process.execPath)], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  app.exit(0)
}

/**
 * Применяет уже скачанный файл. Завершает процесс приложения — после вызова
 * ничего не выполняется.
 */
export async function applyUpdate(manifest: UpdateManifest, filePath: string): Promise<void> {
  if (manifest.delivery === 'installer') {
    applyWindowsInstaller(filePath)
    return
  }
  const dir = installDir()
  if (!dir) throw new Error('Не удалось определить папку установки приложения')
  await applyLinuxArchive(filePath, dir)
}
