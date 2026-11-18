/**
 * UpdateChecker — опрашивает GitHub Releases и управляет состоянием обновления.
 *
 * Схема:
 *   1. Раз в 30 минут (и через 10 с после старта) проверяем фид.
 *   2. Нашли версию новее — сразу начинаем качать её в фоне, показывая прогресс.
 *   3. Файл проверен по SHA256 → фаза `ready`, кнопка в модалке становится
 *      активной.
 *   4. `quitAndInstall()` запускает установщик и закрывает приложение; NSIS
 *      ставит обновление и сам открывает новую версию.
 *
 * Скачивание никогда не блокирует интерфейс: загрузка идёт чанками, прогресс
 * уезжает в renderer через subscribeUpdates.
 */
import { app } from 'electron'
import Store from 'electron-store'
import type { InstallState, QuitAndInstallResult, UpdateManifest, UpdateState } from '../../shared/types'
import { currentPlatform, fetchReleaseFeed, findUpdate } from './releaseFeed'
import { applyUpdate, canSelfUpdate, downloadUpdate, selfUpdateBlockedReason, spawnInstaller } from './InstallerUpdater'

const POLL_INTERVAL_MS = 30 * 60 * 1000 // 30 минут
const FIRST_CHECK_DELAY_MS = 10_000
const PACKAGE_UPDATE_MESSAGE = 'Установите новую версию пакета Syntee Helper через менеджер пакетов.'

const IDLE_INSTALL: InstallState = { phase: 'idle', received: 0, total: 0, error: null }

let state: UpdateState = {
  status: 'idle',
  available: null,
  dismissed: [],
  lastCheckedAt: 0,
  error: null,
  install: { ...IDLE_INSTALL },
}

let store: Store<Record<string, unknown>> | null = null
let listeners: Array<(s: UpdateState) => void> = []
let pollTimer: NodeJS.Timeout | null = null

/** Скачанный и проверенный файл обновления (переживает повторные проверки). */
let readyPath: string | null = null
let readyVersion: string | null = null
let downloadInFlight: Promise<void> | null = null

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getStore(): Store<Record<string, unknown>> {
  if (!store) {
    store = new Store<Record<string, unknown>>({ name: 'updates' })
    const saved = store.get('dismissedUpdates')
    if (Array.isArray(saved)) state.dismissed = saved as string[]
  }
  return store
}

function persistDismissed(): void {
  getStore().set('dismissedUpdates', state.dismissed)
}

function notify(): void {
  for (const fn of listeners) {
    try {
      fn(state)
    } catch {
      /* listener errors are non-fatal */
    }
  }
}

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  notify()
}

function setInstall(patch: Partial<InstallState>): void {
  setState({ install: { ...state.install, ...patch } })
}

export function getUpdateState(): UpdateState {
  return state
}

export function subscribeUpdates(fn: (s: UpdateState) => void): () => void {
  listeners.push(fn)
  return () => {
    listeners = listeners.filter((l) => l !== fn)
  }
}

/**
 * Качает обновление в фоне. Ошибки не всплывают наружу — они уезжают в
 * состояние, чтобы UI мог показать причину и предложить повторить.
 */
function startBackgroundDownload(manifest: UpdateManifest): void {
  if (!canSelfUpdate()) return
  if (readyVersion === manifest.version && readyPath) return
  if (downloadInFlight) return

  downloadInFlight = (async () => {
    setInstall({ phase: 'downloading', received: 0, total: manifest.zip_size, error: null })
    try {
      const path = await downloadUpdate(manifest, (received, total) => {
        setInstall({ phase: 'downloading', received, total })
      })
      readyPath = path
      readyVersion = manifest.version
      setInstall({ phase: 'ready', received: manifest.zip_size, total: manifest.zip_size, error: null })
    } catch (error) {
      readyPath = null
      readyVersion = null
      setInstall({ phase: 'error', received: 0, total: 0, error: errorMessage(error) })
    } finally {
      downloadInFlight = null
    }
  })()
}

/**
 * Проверяет фид. Обновляет состояние и, если нашлась новая версия, запускает
 * фоновое скачивание. Безопасно вызывать вручную (кнопка «Проверить»).
 */
export async function checkForUpdates(): Promise<UpdateState> {
  const platform = currentPlatform()
  if (!platform) {
    setState({ status: 'error', available: null, error: PACKAGE_UPDATE_MESSAGE })
    return state
  }

  setState({ status: 'checking', error: null })
  try {
    getStore()
    const releases = await fetchReleaseFeed()
    const manifest = findUpdate(releases, app.getVersion(), platform)

    if (!manifest) {
      readyPath = null
      readyVersion = null
      setState({
        status: 'no-update',
        available: null,
        lastCheckedAt: Date.now(),
        install: { ...IDLE_INSTALL },
      })
      return state
    }

    const dismissed = state.dismissed.includes(manifest.version)
    setState({
      status: dismissed ? 'no-update' : 'available',
      available: manifest,
      lastCheckedAt: Date.now(),
      error: null,
    })

    if (dismissed) return state

    // ── Уведомление в оверлее ──
    try {
      const { getNotificationManager } = require('../managers/NotificationManager')
      getNotificationManager()?.push({
        type: 'updates',
        title: 'Доступно обновление',
        body: `Версия ${manifest.version} — скачивается в фоне`,
        priority: 'info',
        actions: [{ id: 'open', label: 'Открыть' }],
      })
    } catch {
      /* non-fatal */
    }

    startBackgroundDownload(manifest)
    return state
  } catch (error) {
    setState({
      status: 'error',
      error: errorMessage(error),
      lastCheckedAt: Date.now(),
    })
    return state
  }
}

/** Скрывает бейдж обновления до следующего релиза. */
export function dismissUpdate(version: string): void {
  if (!state.dismissed.includes(version)) {
    state.dismissed = [...state.dismissed, version]
    persistDismissed()
  }
  setState({ status: 'no-update' })
}

/**
 * Применяет обновление: ставит уже скачанный файл (или докачивает), запускает
 * установщик и закрывает приложение. При ошибке приложение продолжает работу
 * и возвращает { ok: false, error } — пользователь может повторить.
 */
export async function quitAndInstall(): Promise<QuitAndInstallResult> {
  const manifest = state.available
  if (!manifest) return { ok: false, error: 'Сначала проверьте наличие обновления' }
  if (!canSelfUpdate()) return { ok: false, error: selfUpdateBlockedReason() }

  try {
    let path = readyVersion === manifest.version ? readyPath : null

    if (!path) {
      setInstall({ phase: 'downloading', received: 0, total: manifest.zip_size, error: null })
      path = await downloadUpdate(manifest, (received, total) => {
        setInstall({ phase: 'downloading', received, total })
      })
      readyPath = path
      readyVersion = manifest.version
    }

    setInstall({ phase: 'installing', received: manifest.zip_size, total: manifest.zip_size, error: null })
    await applyUpdate(manifest, path)
    return { ok: true }
  } catch (error) {
    setInstall({ phase: 'error', error: errorMessage(error) })
    return { ok: false, error: errorMessage(error) }
  }
}

/**
 * Тихая установка при выходе из приложения: если обновление уже скачано и
 * проверено, установщик запускается без диалога.
 *
 * Только Windows: на Linux подмена папки требует, чтобы процесс уже
 * завершился, поэтому там обновление ставится явной командой.
 *
 * Процесс не завершаем — выход и так идёт, а NSIS дождётся освобождения файлов.
 * Если версию пропустили кнопкой «Пропустить», при выходе её не ставим.
 */
export function installPendingOnQuit(): boolean {
  const manifest = state.available
  if (process.platform !== 'win32') return false
  if (!manifest || !readyPath || readyVersion !== manifest.version) return false
  if (state.status !== 'available') return false
  if (state.dismissed.includes(manifest.version)) return false
  if (!canSelfUpdate()) return false
  try {
    spawnInstaller(readyPath)
    return true
  } catch {
    return false
  }
}

/** Запускает периодическую проверку. Вызывается после app.whenReady. */
export function startUpdatePolling(): void {
  if (!currentPlatform()) return
  setTimeout(() => {
    checkForUpdates().catch(() => {})
  }, FIRST_CHECK_DELAY_MS)
  pollTimer = setInterval(() => {
    checkForUpdates().catch(() => {})
  }, POLL_INTERVAL_MS)
}

export function stopUpdatePolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

export type { UpdateManifest, UpdateState }
