/**
 * IPC для встроенной системы обновлений.
 *
 * Renderer умеет:
 *   - проверить обновления вручную (кнопка «Проверить» в настройках)
 *   - получить снимок состояния (бейдж, манифест, прогресс скачивания)
 *   - подписаться на изменения состояния в реальном времени
 *   - получить историю версий (вкладка Changelog — из GitHub Releases)
 *   - скрыть обновление до следующего релиза
 *   - применить обновление (скачать при необходимости → запустить установщик)
 *
 * Логика опроса и загрузки — в src/main/updater/UpdateChecker.ts.
 */
import { app, ipcMain, type BrowserWindow } from 'electron'
import type { ChangelogEntry, QuitAndInstallResult, UpdateState } from '../../shared/types'
import {
  checkForUpdates,
  dismissUpdate,
  getUpdateState,
  quitAndInstall,
  subscribeUpdates,
} from '../updater/UpdateChecker'
import { fetchReleaseFeed } from '../updater/releaseFeed'

export function registerUpdatesIPC(getMainWindow: () => BrowserWindow | null): void {
  // Manual check — returns the new state so the renderer can react inline.
  ipcMain.handle('updates:check', async (): Promise<UpdateState> => {
    return checkForUpdates()
  })

  // Snapshot of current state (badge, manifest, download progress).
  ipcMain.handle('updates:getStatus', (): UpdateState => {
    return getUpdateState()
  })

  // История версий для вкладки Changelog. Источник — тело релизов GitHub,
  // поэтому отдельный HTTP-запрос из renderer не нужен.
  ipcMain.handle(
    'updates:getHistory',
    async (_e, params?: { channel?: string; limit?: number }): Promise<ChangelogEntry[]> => {
      const limit = Math.max(0, Math.min(params?.limit ?? 50, 100))
      const current = app.getVersion()
      const seen = new Set<string>()
      const entries: ChangelogEntry[] = []
      for (const release of await fetchReleaseFeed()) {
        if (seen.has(release.version)) continue
        seen.add(release.version)
        entries.push({
          version: release.version,
          changelog: release.changelog,
          released_at: release.released_at,
          force: false,
          is_current: release.version === current,
        })
      }
      return entries.slice(0, limit)
    },
  )

  // Скрыть обновление до следующего релиза.
  ipcMain.handle('updates:dismiss', async (_e, version: string): Promise<UpdateState> => {
    dismissUpdate(version)
    return getUpdateState()
  })

  // Применить обновление. Возвращает { ok: false, error }, если установщик
  // запустить не удалось — приложение в этом случае продолжает работу.
  ipcMain.handle('updates:quitAndInstall', async (): Promise<QuitAndInstallResult> => {
    return quitAndInstall()
  })

  // Push state changes to the main window. The renderer listens via
  // window.syntee.updates.onStateChanged(cb) exposed in the preload.
  subscribeUpdates((state: UpdateState) => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('updates:state-changed', state)
    }
  })
}
