/**
 * Fast Context watcher — thin routing layer over the Rust sidecar.
 *
 * There is exactly one backend: the Rust sidecar. File walking, hashing,
 * symbol extraction, incremental updates and search all happen inside it; this
 * module only routes lifecycle calls, records index history for the UI and
 * forwards progress to the renderer.
 *
 * There is deliberately no TypeScript indexing/search/watch fallback: a missing
 * or crashed sidecar surfaces as a typed SidecarError, so a broken backend is
 * visible instead of silently degrading to a different implementation.
 */
import {
  sidecarStartWatching, sidecarStopWatching, sidecarForegroundBusy,
  sidecarIndex, SidecarError, addSidecarFailureHandler, getSidecarAvailability,
} from './fastContext/sidecarClient'
import {
  addIndexHistoryEvent, pruneIndexHistory, getProjectById,
} from '../db'
import {
  getIndexSettingsFromRecord, DEFAULT_INDEXING_SETTINGS,
  type IndexProgress, type IndexingSettings,
} from './fastContext'
import { log } from '../logger'
import type Store from 'electron-store'

// Module-level store reference — устанавливается через setWatcherStore(store)
// из fastContext.ipc.ts при регистрации IPC. Без store используются дефолты.
let _store: Store | null = null

/** Установить store для чтения настроек индексации (enabled/ignoreDirs/лимиты). */
export function setWatcherStore(store: Store): void {
  _store = store
  addSidecarFailureHandler(error => {
    log('[watcher] Rust sidecar unavailable (%s): %s', getSidecarAvailability(), error.message)
    if (_activeProjectId) _onProgress?.(_activeProjectId, { stage: 'error', detail: error.message })
  })
}

/** Читает текущие настройки индексации из store (с fallback на дефолты). */
function getSettings(): IndexingSettings {
  if (!_store) return DEFAULT_INDEXING_SETTINGS
  try {
    const all = (_store as unknown as { store: Record<string, unknown> }).store
    return getIndexSettingsFromRecord(all)
  } catch {
    return DEFAULT_INDEXING_SETTINGS
  }
}

let _foregroundBusy = false

/**
 * Кооперативный сигнал для sidecar: активный чат не блокирует SQLite и не
 * прерывает транзакции, но low-priority индексация уступает CPU/диск.
 */
export function setForegroundBusy(busy: boolean): void {
  if (_foregroundBusy === busy) return
  _foregroundBusy = busy
  void sidecarForegroundBusy(busy).catch(error =>
    log('[watcher] Rust foregroundBusy failed: %s', error instanceof Error ? error.message : String(error)))
}

export function isForegroundBusy(): boolean { return _foregroundBusy }

// ── Watcher state ────────────────────────────────────────────────────────────
interface WatcherEntry {
  projectId: string
  workdir: string
}

const _watchers = new Map<string, WatcherEntry>()
const _projectWorkdirs = new Map<string, string>()
let _activeProjectId: string | null = null
let _onProgress: ((projectId: string, progress: IndexProgress) => void) | null = null
let _onUpdated: ((projectId: string) => void) | null = null

// Timestamp последней проверки проекта фоном (index/watcher batch).
// В отличие от lastUpdated (= когда менялись файлы), это «когда система
// последний раз смотрела» — показывает живость фона в модалке.
const _lastScanAt = new Map<string, number>()
// Rust watcher emits no unsolicited stdout notifications. Poll its cheap status
// endpoint so renderer/history still receive updates after native indexing.
let _sidecarStatusTimer: ReturnType<typeof setInterval> | null = null
let _sidecarLastBatches = 0
let _sidecarLastFilesChanged = 0

function startSidecarStatusPolling(): void {
  if (_sidecarStatusTimer) return
  _sidecarStatusTimer = setInterval(() => {
    void import('./fastContext/sidecarClient').then(({ sidecarStatus }) => sidecarStatus()).then(status => {
      if (status.batches !== _sidecarLastBatches || status.filesChanged !== _sidecarLastFilesChanged) {
        const changedDelta = Math.max(0, status.filesChanged - _sidecarLastFilesChanged)
        _sidecarLastBatches = status.batches
        _sidecarLastFilesChanged = status.filesChanged
        const projectId = _activeProjectId
        if (projectId) {
          _lastScanAt.set(projectId, Date.now())
          const indexedCount = typeof status.indexedFilesCount === 'number' ? status.indexedFilesCount : undefined
          if (changedDelta > 0) recordHistory(projectId, 'incremental', changedDelta, 0, indexedCount)
          _onUpdated?.(projectId)
          _onProgress?.(projectId, { stage: 'done', detail: `${status.filesChanged} файлов обновлено Rust watcher` })
        }
      }
    }).catch(error => {
      log('[watcher] Rust status poll failed: %s', error instanceof Error ? error.message : String(error))
    })
  }, 1000)
  _sidecarStatusTimer.unref?.()
}

function stopSidecarStatusPolling(): void {
  if (_sidecarStatusTimer) clearInterval(_sidecarStatusTimer)
  _sidecarStatusTimer = null
}

/** Установить колбэк для прогресса индексации (→ renderer через IPC). */
export function setProgressCallback(cb: (projectId: string, progress: IndexProgress) => void): void {
  _onProgress = cb
}

/** Установить колбэк для уведомления об обновлении индекса (→ renderer). */
export function setUpdatedCallback(cb: (projectId: string) => void): void {
  _onUpdated = cb
}

/** Установить активный проект (приоритетная индексация). */
export function setActiveProject(projectId: string | null): void {
  _activeProjectId = projectId
  // Запоминаем последний активный проект — для автостарта watcher'а при
  // следующем запуске приложения (autoStartLastProject), не дожидаясь пока
  // пользователь откроет чат проекта.
  if (projectId && _store) {
    try { _store.set('lastActiveProjectId', projectId) } catch { /* store RO — ок */ }
  }
  // Только активный проект имеет watcher — остальные останавливаем.
  // Это радикально снижает CPU usage в простое (N watchers → 1 watcher).
  for (const pid of Array.from(_watchers.keys())) {
    if (pid !== projectId) {
      void stopWatching(pid)
    }
  }
  // Запускаем watcher для активного проекта, если он не запущен
  if (projectId) {
    const workdir = _projectWorkdirs.get(projectId)
    if (workdir && !_watchers.has(projectId)) {
      startWatching(projectId, workdir)
    }
  }
}

/** Запомнить workdir проекта без старта watcher'а. Нужно чтобы
 *  setActiveProject мог запустить watcher при активации проекта. Лёгкая
 *  операция (только Map-запись), не создаёт FS-handles. */
export function registerProjectWorkdir(projectId: string, workdir: string): void {
  _projectWorkdirs.set(projectId, workdir)
}

/** Автостарт watcher'а последнего активного проекта при запуске приложения —
 *  не дожидаясь, пока пользователь откроет чат проекта. Вызывается из
 *  registerFastContextIPC — к этому моменту registerChatIPC уже
 *  зарегистрировал workdir'ы всех проектов. */
export function autoStartLastProject(): void {
  if (!_store) return
  if (_activeProjectId) return // уже активирован renderer'ом
  let lastId: string | undefined
  try { lastId = _store.get('lastActiveProjectId') as string | undefined } catch { return }
  if (!lastId || !_projectWorkdirs.has(lastId)) return
  try {
    setActiveProject(lastId)
    log('[fastContextWatcher] auto-started last active project: %s', lastId)
  } catch (e) {
    log('[fastContextWatcher] auto-start failed: %s', e instanceof Error ? e.message : String(e))
  }
}

/** Timestamp последней фоновой проверки проекта.
 *  null — в этой сессии ещё не проверялся. */
export function getLastScanAt(projectId: string): number | null {
  return _lastScanAt.get(projectId) ?? null
}

/** Записать событие в историю + prune старых. */
function recordHistory(
  projectId: string,
  eventType: string,
  filesChanged: number,
  durationMs: number,
  filesCountOverride?: number,
): void {
  try {
    addIndexHistoryEvent(projectId, eventType, filesCountOverride ?? 0, filesChanged, durationMs)
    pruneIndexHistory(projectId, 50)
  } catch { /* history опциональна */ }
}

/** Запускает Rust-индексацию и watcher для проекта. Idempotent — повторный
 *  вызов для того же projectId не создаёт второй watcher. */
export function startWatching(projectId: string, workdir: string): void {
  _projectWorkdirs.set(projectId, workdir)
  if (_watchers.has(projectId)) return

  const settings = getSettings()
  if (!settings.enabled) {
    log('[fastContextWatcher] indexing disabled in settings — skipping %s', workdir)
    return
  }

  _watchers.set(projectId, { projectId, workdir })
  startSidecarStatusPolling()
  const startedAt = Date.now()
  void sidecarIndex(projectId, workdir, {
    maxFiles: settings.maxFilesPerProject,
    maxFileSizeKb: settings.maxFileSizeKb,
    ignoreDirs: settings.ignoreDirs,
  }).then(result => {
    if (result.hadErrors === true || (result.complete === false && !result.hitCap)) {
      throw new SidecarError('index_unavailable', 'Rust initial index reported read or traversal errors')
    }
    recordHistory(projectId, 'full', result.filesChanged ?? 0, Date.now() - startedAt, result.filesFound)
    return sidecarStartWatching(projectId, workdir, {
      maxFiles: settings.maxFilesPerProject,
      maxFileSizeKb: settings.maxFileSizeKb,
      ignoreDirs: settings.ignoreDirs,
    })
  }).then(() => {
    _lastScanAt.set(projectId, Date.now())
    _onUpdated?.(projectId)
    _onProgress?.(projectId, { stage: 'done', detail: 'Rust watcher запущен' })
  }).catch(error => {
    const err = error instanceof Error ? error : new Error(String(error))
    _watchers.delete(projectId)
    log('[watcher] Rust startWatching failed: %s', err.message)
    _onProgress?.(projectId, { stage: 'error', detail: err.message })
  })
}

/** Останавливает watcher для проекта. */
export async function stopWatching(projectId: string): Promise<void> {
  const entry = _watchers.get(projectId)
  if (!entry) return
  try {
    await sidecarStopWatching()
  } catch (error) {
    log('[watcher] Rust stopWatching failed: %s', error instanceof Error ? error.message : String(error))
  }
  _watchers.delete(projectId)
  if (_watchers.size === 0) stopSidecarStatusPolling()
}

/** Останавливает все watchers (при выходе из приложения). */
export async function stopAllWatchers(): Promise<void> {
  const ids = Array.from(_watchers.keys())
  await Promise.all(ids.map(stopWatching))
  stopSidecarStatusPolling()
}

/** Проверка — запущен ли watcher для проекта. */
export function isWatching(projectId: string): boolean {
  return _watchers.has(projectId)
}

/**
 * Принудительный реиндекс проекта (вызывается из IPC fastcontext:reindex).
 * Всегда full + с progress events. Ошибки пробрасываются в renderer.
 */
export async function forceReindex(projectId: string): Promise<void> {
  const workdir = _watchers.get(projectId)?.workdir
    ?? _projectWorkdirs.get(projectId)
    ?? getProjectById(projectId)?.workdir
  if (!workdir) throw new SidecarError('unavailable', `Workdir проекта не найден (projectId=${projectId})`)
  _projectWorkdirs.set(projectId, workdir)

  const settings = getSettings()
  const startedAt = Date.now()
  const result = await sidecarIndex(projectId, workdir, {
    maxFiles: settings.maxFilesPerProject,
    maxFileSizeKb: settings.maxFileSizeKb,
    ignoreDirs: settings.ignoreDirs,
  })
  if (result.hadErrors === true || (result.complete === false && !result.hitCap)) {
    throw new SidecarError('index_unavailable', 'Rust reindex reported read or traversal errors')
  }
  recordHistory(projectId, 'full', result.filesChanged ?? 0, Date.now() - startedAt, result.filesFound)
  _lastScanAt.set(projectId, Date.now())
  _onUpdated?.(projectId)
  const capNote = result.hitCap
    ? `, частичный индекс (${result.filesFound ?? settings.maxFilesPerProject}/${settings.maxFilesPerProject})`
    : ''
  _onProgress?.(projectId, { stage: 'done', detail: `${result.filesChanged ?? 0} файлов${capNote}` })
}
