/**
 * Fast Context IPC — статус индекса, реиндекс, очистка, live progress.
 *
 * Каналы:
 *   fastcontext:getStatus  — { fileCount, lastUpdated, watcherActive, indexingInProgress, history, recentFiles, topFiles }
 *   fastcontext:reindex    — запускает full reindex, прогресс через fastcontext:progress event
 *   fastcontext:clearIndex — очищает индекс проекта
 *   fastcontext:progress   — push event: { stage, detail, filesProcessed, filesTotal }
 *   fastcontext:updated    — push event: индекс обновлён (watcher сработал)
 */
import { ipcMain, type BrowserWindow } from 'electron'
import type Store from 'electron-store'
import { IPC_EVENTS } from '../../shared/constants'
import {
  getFastContextIndexCount, getFastContextLastUpdated,
  getIndexHistory, getRecentFastContextFiles, getTopFastContextFiles,
  clearFastContextIndex, addIndexHistoryEvent, pruneIndexHistory,
} from '../../core/db/database'
import {
  setProgressCallback, setUpdatedCallback, setActiveProject,
  isWatching, isIndexing, forceReindex,
} from '../../core/context/fastContextWatcher'

let _initialized = false

export function registerFastContextIPC(store: Store, getWindow: () => BrowserWindow | null): void {
  // Idempotent — регистрируем только один раз
  if (_initialized) return
  _initialized = true

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

  // Отслеживаем активный проект для priority indexing.
  // Renderer шлёт 'fastcontext:setActive' когда пользователь переключает проект.
  ipcMain.handle('fastcontext:setActive', (_e, projectId: string | null) => {
    setActiveProject(projectId)
  })

  // Полный статус индекса для модалки
  ipcMain.handle('fastcontext:getStatus', (_e, projectId: string) => {
    const fileCount = getFastContextIndexCount(projectId)
    const lastUpdated = getFastContextLastUpdated(projectId)
    const watcherActive = isWatching(projectId)
    const indexing = isIndexing(projectId)
    const history = getIndexHistory(projectId, 50)
    const recentFiles = getRecentFastContextFiles(projectId, 10)
    const topFiles = getTopFastContextFiles(projectId, 10)
    return { fileCount, lastUpdated, watcherActive, indexingInProgress: indexing, history, recentFiles, topFiles }
  })

  // Принудительный реиндекс
  ipcMain.handle('fastcontext:reindex', async (_e, projectId: string) => {
    await forceReindex(projectId)
    return { ok: true }
  })

  // Очистка индекса
  ipcMain.handle('fastcontext:clearIndex', (_e, projectId: string) => {
    clearFastContextIndex(projectId)
    addIndexHistoryEvent(projectId, 'clear', 0, 0, 0)
    pruneIndexHistory(projectId, 50)
    return { ok: true }
  })
}
