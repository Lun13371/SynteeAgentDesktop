/**
 * projectMap IPC — граф кода проекта для renderer (модалка/баннер/настройки).
 * Прогресс сборки шлётся во все окна событием 'projectMap:progress'
 * (паттерн assistants:setupProgress).
 */
import { ipcMain, webContents } from 'electron'
import { projectMapManager } from '../../core/projectMap/mapBuilder'
import * as store from '../../core/projectMap/mapStore'
import { getAllProjects } from '../../core/db'
import type { GetGraphOptions, CodeMapProgress, ProjectMapProjectStats } from '../../shared/projectMap'

let _initialized = false

export function registerProjectMapIPC(): void {
  if (_initialized) return
  _initialized = true

  projectMapManager.setProgressCallback((p: CodeMapProgress) => {
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed()) wc.send('projectMap:progress', p)
    }
  })

  ipcMain.handle('projectMap:getGraph', (_, projectId: string, opts?: GetGraphOptions) => {
    return store.getGraph(projectId, opts ?? {})
  })

  ipcMain.handle('projectMap:getFileGraph', (_, projectId: string, filePath: string) => {
    return store.getFileGraph(projectId, filePath)
  })

  ipcMain.handle('projectMap:getStatus', (_, projectId: string) => {
    return store.getStatus(projectId)
  })

  ipcMain.handle('projectMap:getStats', (_, projectId: string) => {
    const status = store.getStatus(projectId)
    return {
      ...status,
      files: store.listFiles(projectId).length,
    }
  })

  ipcMain.handle('projectMap:findNodes', (_, projectId: string, query: string, limit?: number) => {
    return store.findNodes(projectId, query, limit ?? 30)
  })

  ipcMain.handle('projectMap:getNeighbors', (_, projectId: string, nodeId: string) => {
    return {
      node: store.getNode(projectId, nodeId),
      callers: store.getCallers(projectId, nodeId),
      callees: store.getCallees(projectId, nodeId),
    }
  })

  ipcMain.handle('projectMap:getFileDeps', (_, projectId: string, filePath: string) => {
    return {
      imports: store.getFileEdges(projectId, filePath, 'out'),
      importedBy: store.getFileEdges(projectId, filePath, 'in'),
    }
  })

  ipcMain.handle('projectMap:listStats', (): ProjectMapProjectStats[] => {
    return getAllProjects().map(p => ({
      ...store.getStatus(p.id),
      name: p.name,
      workdir: p.workdir,
    }))
  })

  ipcMain.handle('projectMap:getAutoInfo', () => projectMapManager.autoInfo())

  ipcMain.handle('projectMap:rebuild', (_, projectId: string) => {
    projectMapManager.rebuildProject(projectId)
    return true
  })

  ipcMain.handle('projectMap:ensure', (_, projectId: string) => {
    projectMapManager.ensureProject(projectId)
    return true
  })

  ipcMain.handle('projectMap:setActiveProject', (_, projectId: string | null) => {
    projectMapManager.setActiveProject(projectId)
    return true
  })

  // Фоновая индексация всех проектов (активный — первым). Стартует после
  // инициализации БД; тяжёлый парсинг — в sidecar, main не блокируется.
  projectMapManager.start()
}