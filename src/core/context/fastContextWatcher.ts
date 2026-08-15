/**
 * Fast Context Watcher — следит за изменениями файлов проекта и обновляет
 * tree-sitter индекс в фоне (chokidar). Запускается в main-процессе.
 *
 * Один watcher на проект (по projectId). При изменении файла — debounce 500ms,
 * затем incremental re-index через buildOrUpdateIndex(changedPaths=[...]).
 *
 * Priority: активный проект индексируется с BATCH_SIZE=8 (быстро),
 * фоновые проекты — BATCH_SIZE=2 (щадя CPU). Прогресс и завершение
 * пушатся в renderer через onProgress/onDone колбэки.
 *
 * История обновлений записывается в fast_context_index_history (последние 50).
 */
import chokidar, { type FSWatcher } from 'chokidar'
import { basename, relative } from 'path'
import { buildOrUpdateIndex, getIndexSettingsFromRecord, DEFAULT_INDEXING_SETTINGS, type IndexProgress, type IndexingSettings } from './fastContext'
import {
  addIndexHistoryEvent, pruneIndexHistory, getFastContextIndexCount,
} from '../db'
import { incrementalUpdateFastContext } from '../memory/graphBuilder'
import { log } from '../logger'
import type Store from 'electron-store'

// Module-level store reference — устанавливается через setWatcherStore(store)
// из fastContext.ipc.ts при регистрации IPC. Без store используются дефолты.
let _store: Store | null = null

/** Установить store для чтения настроек индексации (enabled/debounce/ignoreDirs). */
export function setWatcherStore(store: Store): void {
  _store = store
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

interface WatcherEntry {
  projectId: string
  workdir: string
  watcher: FSWatcher
  debounceTimer: NodeJS.Timeout | null
  pendingPaths: Set<string>
}

const _watchers = new Map<string, WatcherEntry>()
const _projectWorkdirs = new Map<string, string>()
let _activeProjectId: string | null = null
let _onProgress: ((projectId: string, progress: IndexProgress) => void) | null = null
let _onUpdated: ((projectId: string) => void) | null = null
const _indexingProjects = new Set<string>()

// ── Глобальная очередь индексации ────────────────────────────────────────────
// Только один проект индексируется за раз — не спамим CPU при старте с N проектов.
// Активный проект — приоритет, фоновые идут последовательно после него.
const _indexQueue: Array<{ projectId: string; workdir: string; changedPaths: string[] | undefined; isFull: boolean }> = []
let _queueRunning = false

async function processQueue(): Promise<void> {
  if (_queueRunning) return
  _queueRunning = true
  try {
    while (_indexQueue.length > 0) {
      // Приоритет: активный проект первым
      const activeIdx = _activeProjectId
        ? _indexQueue.findIndex(j => j.projectId === _activeProjectId)
        : -1
      const job = activeIdx >= 0
        ? _indexQueue.splice(activeIdx, 1)[0]
        : _indexQueue.shift()!
      await runIndexDirect(job.projectId, job.workdir, job.changedPaths, job.isFull)
      // Пауза между проектами — даём CPU остыть
      await new Promise<void>(r => setTimeout(r, 200))
    }
  } finally {
    _queueRunning = false
  }
}

function enqueueIndex(projectId: string, workdir: string, changedPaths: string[] | undefined, isFull: boolean): void {
  _indexQueue.push({ projectId, workdir, changedPaths, isFull })
  void processQueue()
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
  // Только активный проект имеет persistent watcher — остальные останавливаем.
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

/** Идёт ли индексация для проекта прямо сейчас. */
export function isIndexing(projectId: string): boolean {
  return _indexingProjects.has(projectId)
}

// Игнорируемые директории по умолчанию — переопределяются настройками.
const IGNORED_DIRS_DEFAULT = [
  'node_modules', 'dist', 'out', '.git', '__pycache__', '.venv', 'build',
  '.next', 'coverage', '.cache', '.turbo', '.parcel-cache', 'target',
  '.gradle', '.idea', '.vscode', '.hermes', '.mimocode', '.playwright-mcp',
  '.planning', 'logs', 'tmp', 'tmp_out', '.opencode',
]

const IGNORED_EXTS = [
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm',
  '.zip', '.gz', '.tar', '.rar', '.7z', '.bz2',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.exe', '.dll', '.so', '.dylib', '.wasm', '.lib',
  '.obj', '.bin', '.dat', '.db', '.sqlite', '.db-shm', '.db-wal',
  '.o', '.a', '.class', '.jar', '.war',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.lock', '.log',
]

function buildIgnoredMatcher(workdir: string, ignoreDirs: string[] = IGNORED_DIRS_DEFAULT): (path: string, stats?: { isFile?: () => boolean; isDirectory?: () => boolean }) => boolean {
  const ignoreSet = new Set(ignoreDirs)
  return (path: string, stats?: { isFile?: () => boolean; isDirectory?: () => boolean }) => {
    const rel = relative(workdir, path).split('\\').join('/')
    for (const d of ignoreSet) {
      if (rel === d || rel.startsWith(d + '/')) return true
    }
    if (stats?.isFile?.()) {
      const base = basename(path).toLowerCase()
      for (const ext of IGNORED_EXTS) {
        if (base.endsWith(ext)) return true
      }
      if (base.startsWith('.') && base !== '.env' && base !== '.gitignore') return true
    }
    return false
  }
}

/** Записать событие в историю + prune старых. */
function recordHistory(projectId: string, eventType: string, filesChanged: number, durationMs: number): void {
  try {
    const filesCount = getFastContextIndexCount(projectId)
    addIndexHistoryEvent(projectId, eventType, filesCount, filesChanged, durationMs)
    pruneIndexHistory(projectId, 50)
  } catch { /* history опциональна */ }
}

/** Запускает watcher для проекта. Idempotent — повторный вызов для того же projectId не создаёт второй watcher.
 *  Если в настройках indexingSettings.enabled=false — watcher не запускается. */
export function startWatching(projectId: string, workdir: string): void {
  _projectWorkdirs.set(projectId, workdir)
  if (_watchers.has(projectId)) return

  const settings = getSettings()
  // Мастер-переключатель: если индексация отключена в настройках — не стартуем watcher.
  if (!settings.enabled) {
    console.log(`[fastContextWatcher] indexing disabled in settings — skipping ${workdir}`)
    return
  }

  const ignored = buildIgnoredMatcher(workdir, settings.ignoreDirs)
  let watcher: FSWatcher

  try {
    watcher = chokidar.watch(workdir, {
      ignored,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 1000 },
      depth: 8,
      usePolling: false,
      interval: 10000,
      binaryInterval: 10000,
    })
  } catch (e) {
    console.warn(`[fastContextWatcher] failed to start for ${workdir}:`, e)
    return
  }

  const entry: WatcherEntry = {
    projectId,
    workdir,
    watcher,
    debounceTimer: null,
    pendingPaths: new Set(),
  }
  _watchers.set(projectId, entry)

  // Pre-warm: только если индекс пустой (первый запуск проекта) И настройка включена.
  // Если индекс уже есть в БД — не делаем full scan, watcher ловит изменения.
  // Это убирает CPU spike при старте приложения с N проектов.
  if (settings.prewarmOnStart) {
    const existingCount = getFastContextIndexCount(projectId)
    if (existingCount === 0) {
      enqueueIndex(projectId, workdir, undefined, true)
    }
  }

  const scheduleUpdate = (filePath: string): void => {
    entry.pendingPaths.add(filePath)
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    entry.debounceTimer = setTimeout(() => {
      const paths = Array.from(entry.pendingPaths)
      entry.pendingPaths.clear()
      entry.debounceTimer = null
      if (paths.length === 0) return
      enqueueIndex(projectId, workdir, paths, false)
    }, settings.watcherDebounceMs)
  }

  watcher.on('add', (p) => scheduleUpdate(p))
  watcher.on('change', (p) => scheduleUpdate(p))
  watcher.on('unlink', (p) => {
    scheduleUpdate(p)
  })

  watcher.on('error', (e) => {
    console.warn(`[fastContextWatcher] error for ${workdir}:`, e)
  })
}

/**
 * Запускает buildOrUpdateIndex с progress callback и записью истории.
 * Активный проект получает полный приоритет (progress events отправляются),
 * фоновые — silent. Вызывается только из processQueue (по одному за раз).
 */
async function runIndexDirect(
  projectId: string,
  workdir: string,
  changedPaths: string[] | undefined,
  isFull: boolean,
): Promise<void> {
  const startedAt = Date.now()
  const isActive = projectId === _activeProjectId
  _indexingProjects.add(projectId)

  const onProgress = isActive
    ? (p: IndexProgress) => { _onProgress?.(projectId, p) }
    : undefined

  try {
    // skipEmbeddings=true: pre-warm не грузит ONNX runtime (который жрёт CPU).
    // Embeddings генерируются только при первом get_fast_context вызове.
    const isPrewarm = isFull && !changedPaths
    const settings = getSettings()
    const filesChanged = await buildOrUpdateIndex(
      projectId, workdir, changedPaths, onProgress,
      { skipEmbeddings: isPrewarm && projectId !== _activeProjectId, settings },
    )
    const durationMs = Date.now() - startedAt
    const eventType = isFull ? 'full' : 'incremental'
    recordHistory(projectId, eventType, filesChanged, durationMs)

    // Sync knowledge graph file/symbol nodes after reindex — keeps
    // file relationships (imports, calls) fresh. Only if files changed.
    if (filesChanged > 0) {
      try {
        const r = incrementalUpdateFastContext(projectId)
        log('[watcher] graph sync: nodes=%d edges=%d removed=%d', r.nodes, r.edges, r.removed)
      } catch (e) {
        log('[watcher] graph sync failed: %s', (e as Error).message)
      }
    }

    _onUpdated?.(projectId)
    if (isActive) {
      _onProgress?.(projectId, { stage: 'done', detail: `${filesChanged} файлов, ${durationMs}ms` })
    }
  } catch (e) {
    console.warn(`[fastContextWatcher] index update failed for ${workdir}:`, e)
  } finally {
    _indexingProjects.delete(projectId)
  }
}

/** Останавливает watcher для проекта. */
export async function stopWatching(projectId: string): Promise<void> {
  const entry = _watchers.get(projectId)
  if (!entry) return
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
  try {
    await entry.watcher.close()
  } catch { /* ignore */ }
  _watchers.delete(projectId)
}

/** Останавливает все watchers (при выходе из приложения). */
export async function stopAllWatchers(): Promise<void> {
  const ids = Array.from(_watchers.keys())
  await Promise.all(ids.map(stopWatching))
}

/** Проверка — запущен ли watcher для проекта. */
export function isWatching(projectId: string): boolean {
  return _watchers.has(projectId)
}

/**
 * Принудительный реиндекс проекта (вызывается из IPC fastcontext:reindex).
 * Всегда full + с progress events. Ждёт очереди.
 */
export async function forceReindex(projectId: string): Promise<void> {
  const entry = _watchers.get(projectId)
  const workdir = entry?.workdir
  if (!workdir) return
  // Ставим в очередь и ждём завершения
  return new Promise<void>((resolve) => {
    const origUpdated = _onUpdated
    const wrapper = (pid: string) => {
      if (pid === projectId) {
        _onUpdated = origUpdated
        resolve()
      }
    }
    _onUpdated = wrapper
    enqueueIndex(projectId, workdir, undefined, true)
  })
}
