/**
 * Fast Context IPC — статус индекса, реиндекс, очистка, live progress.
 *
 * Все данные индекса принадлежат Rust sidecar (`fast_context_sidecar_index`);
 * main только читает их для UI. Отдельного TypeScript-бэкенда больше нет.
 *
 * Каналы:
 *   fastcontext:getStatus  — { fileCount, lastUpdated, watcherActive, history, recentFiles, topFiles, backend, sidecar }
 *   fastcontext:reindex    — запускает full reindex, прогресс через fastcontext:progress event
 *   fastcontext:clearIndex — очищает индекс проекта
 *   fastcontext:progress   — push event: { stage, detail, filesProcessed, filesTotal }
 *   fastcontext:updated    — push event: индекс обновлён (watcher сработал)
 */
import { ipcMain, type BrowserWindow } from 'electron'
import type Store from 'electron-store'
import { IPC_EVENTS } from '../../shared/constants'
import {
  getIndexHistory, addIndexHistoryEvent, pruneIndexHistory,
  getSidecarIndexCount, getSidecarLastUpdated, getRecentSidecarFiles, getTopSidecarFiles,
} from '../../core/db'
import {
  setProgressCallback, setUpdatedCallback, setActiveProject,
  isWatching, forceReindex, setWatcherStore,
  autoStartLastProject, getLastScanAt,
} from '../../core/context/fastContextWatcher'
import { setActiveExtensionsProject, initExtensionsDetector } from '../../core/extensionsDetector'
import { getProjectById } from '../../core/db'
import { log } from '../../core/logger'
import { sidecarStatus, sidecarClear, getSidecarProcesses } from '../../core/context/fastContext/sidecarClient'

let _initialized = false

export function registerFastContextIPC(store: Store, getWindow: () => BrowserWindow | null): void {
  // Idempotent — регистрируем только один раз
  if (_initialized) return
  _initialized = true

  // Передаём store в watcher — он читает indexingSettings (enabled/ignoreDirs/лимиты).
  setWatcherStore(store)

  // Инициализируем extensions-детектор (для авто-подключения MCP и авто-включения
  // skills при появлении/изменении .mcp.json / .syntee/skills/ активного проекта).
  initExtensionsDetector(getWindow)

  // Автостарт watcher'а последнего активного проекта — индексация начинается
  // сама, в фоне, не дожидаясь пока пользователь откроет чат.
  // registerChatIPC (регистрирует workdir'ы) уже отработал к этому моменту.
  autoStartLastProject()

  // Push callbacks из watcher'а → renderer
  setProgressCallback((projectId, progress) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_EVENTS.FASTCONTEXT_PROGRESS, { projectId, ...progress })
    }
  })

  setUpdatedCallback((projectId) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_EVENTS.FASTCONTEXT_UPDATED, { projectId })
    }
  })

  // Отслеживаем активный проект для priority indexing + extensions watcher.
  // Renderer шлёт 'fastcontext:setActive' когда пользователь переключает проект.
  ipcMain.handle('fastcontext:setActive', (_e, projectId: string | null) => {
    setActiveProject(projectId)
    // Параллельно переключаем extensions-watcher на тот же проект.
    let workdir: string | undefined
    if (projectId) {
      const proj = getProjectById(projectId)
      workdir = proj?.workdir
    }
    setActiveExtensionsProject(projectId ?? null, workdir)
  })

  // Полный статус индекса для модалки
  ipcMain.handle('fastcontext:getStatus', async (_e, projectId: string) => {
    const processes = getSidecarProcesses()
    const lastScanAt = getLastScanAt(projectId)
    const history = getIndexHistory(projectId, 50)
    const watcherActive = isWatching(projectId)
    try {
      const rust = await sidecarStatus()
      const rustFileCount = typeof rust.indexedFilesCount === 'number'
        ? rust.indexedFilesCount
        : getSidecarIndexCount(projectId)
      return {
        fileCount: rustFileCount,
        lastUpdated: getSidecarLastUpdated(projectId),
        watcherActive: rust.active,
        indexingInProgress: false,
        queued: false,
        lastScanAt,
        history,
        recentFiles: getRecentSidecarFiles(projectId, 10),
        topFiles: getTopSidecarFiles(projectId, 10),
        backend: 'rust',
        sidecar: rust,
        sidecarProcesses: processes.holders.length,
        sidecarDuplicate: processes.duplicate,
        sidecarHolders: processes.holders,
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      log(`[fastContext:getStatus] Rust sidecar unavailable: ${message}`)
      return {
        fileCount: 0, lastUpdated: null, watcherActive, indexingInProgress: false,
        queued: false, lastScanAt, history, recentFiles: [], topFiles: [],
        backend: 'rust', unavailable: true, error: message,
        sidecarProcesses: processes.holders.length, sidecarDuplicate: processes.duplicate,
        sidecarHolders: processes.holders,
      }
    }
  })

  // Принудительный реиндекс.
  // Ошибки НЕ глотаем: forceReindex кидает (workdir не найден, sidecar упал) —
  // renderer показывает их в модалке вместо тихого «ничего не произошло».
  ipcMain.handle('fastcontext:reindex', async (_e, projectId: string) => {
    try {
      await forceReindex(projectId)
      return { ok: true, backend: 'rust' }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      log(`[fastContext:reindex] failed for ${projectId}: ${message}`)
      return { ok: false, error: message, backend: 'rust' }
    }
  })

  // Очистка индекса
  ipcMain.handle('fastcontext:clearIndex', async (_e, projectId: string) => {
    try {
      await sidecarClear(projectId)
      addIndexHistoryEvent(projectId, 'clear', 0, 0, 0)
      pruneIndexHistory(projectId, 50)
      return { ok: true, backend: 'rust' }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      log(`[fastContext:clearIndex] Rust sidecar unavailable: ${message}`)
      return { ok: false, error: message, backend: 'rust', unavailable: true }
    }
  })
}
