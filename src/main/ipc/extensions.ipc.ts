/**
 * Extensions IPC — активация проекта для авто-детекта MCP/skills.
 *
 * Renderer шлёт 'extensions:setActiveProject' при переключении проекта;
 * детектор (extensionsDetector) сканирует .mcp.json / .syntee/skills/
 * активного проекта и подключает найденное.
 */
import { ipcMain, type BrowserWindow } from 'electron'
import { setActiveExtensionsProject, initExtensionsDetector } from '../../core/extensionsDetector'
import { getProjectById } from '../../core/db'

let _initialized = false

export function registerExtensionsIPC(getWindow: () => BrowserWindow | null): void {
  if (_initialized) return
  _initialized = true

  initExtensionsDetector(getWindow)

  ipcMain.handle('extensions:setActiveProject', (_e, projectId: string | null) => {
    let workdir: string | undefined
    if (projectId) {
      workdir = getProjectById(projectId)?.workdir
    }
    setActiveExtensionsProject(projectId ?? null, workdir)
  })
}