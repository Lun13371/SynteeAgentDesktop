/**
 * IPC handlers для MCP (Model Context Protocol).
 *
 * Каналы:
 *   mcp:getAll         — все серверы с runtime (для popover)
 *   mcp:save           — сохранить глобальный сервер (CRUD)
 *   mcp:delete         — удалить глобальный сервер
 *   mcp:connect        — подключить сервер (lazy/явное)
 *   mcp:disconnect     — отключить
 *   mcp:reconnect      — переподключить
 *   mcp:setServerState — обновить enabled/scope сервера
 *   mcp:setToolState   — обновить per-tool enabled/requireApproval
 *
 * Push events (webContents.send, не handle):
 *   mcp:status         — { serverId, status, error? }
 *   mcp:tools:updated  — { serverId, tools[] }
 *
 * McpManager — синглтон, инициализируется в main/index.ts через initMcpManager.
 * setWindow вызывается там же для push-событий.
 */
import { ipcMain, BrowserWindow } from 'electron'
import Store from 'electron-store'
import { getMcpManager } from '../../core/mcp/McpManager'
import { getProjectById, getChatWorkdirContext, getAllProjects } from '../../core/db'
import type { McpServerConfig, McpToolState, ExtensionScope } from '../../shared/types'

export function registerMcpIPC(store: Store, getWindow: () => BrowserWindow | null): void {
  // Обновляем окно в менеджере при каждом вызове (оно может пересоздаваться).
  const mgr = () => {
    const m = getMcpManager()
    m.setWindow(getWindow())
    return m
  }

  ipcMain.handle('mcp:getAll', (_e, params?: { projectId?: string; chatId?: string }) => {
    let projectWorkdir: string | undefined
    let projectId = params?.projectId
    // Если projectId не передан, но есть chatId — резолвим проект из чата.
    // Это надёжнее чем зависеть от activeProjectId в renderer-сторе.
    if (!projectId && params?.chatId) {
      try {
        const ctx = getChatWorkdirContext(params.chatId)
        if (ctx.workdir) {
          const found = getAllProjects().find(p => p.workdir === ctx.workdir)
          projectId = found?.id
        }
      } catch { /* ignore */ }
    }
    if (projectId) {
      const proj = getProjectById(projectId)
      projectWorkdir = proj?.workdir
    }
    return mgr().getAllServers({ projectWorkdir, projectId })
  })

  ipcMain.handle('mcp:save', (_e, config: McpServerConfig) => {
    mgr().saveGlobalServer(config)
    return { ok: true }
  })

  ipcMain.handle('mcp:delete', (_e, id: string) => {
    mgr().deleteGlobalServer(id)
    return { ok: true }
  })

  ipcMain.handle('mcp:connect', async (_e, serverId: string) => {
    await mgr().connect(serverId)
    return { ok: true }
  })

  ipcMain.handle('mcp:disconnect', async (_e, serverId: string) => {
    await mgr().disconnect(serverId)
    return { ok: true }
  })

  ipcMain.handle('mcp:reconnect', async (_e, serverId: string) => {
    await mgr().reconnect(serverId)
    return { ok: true }
  })

  ipcMain.handle('mcp:setServerState', (_e, params: {
    serverId: string
    projectId?: string
    enabled?: boolean
    scope?: ExtensionScope
  }) => {
    // Для проектного MCP обязательно передаём projectId, иначе его состояние
    // ошибочно прочитается/запишется как глобальное.
    const project = params.projectId ? getProjectById(params.projectId) : undefined
    const all = mgr().getAllServers({ projectWorkdir: project?.workdir, projectId: params.projectId })
    const config = all.find(c => c.id === params.serverId)
    if (!config) return { ok: false, error: 'Сервер не найден' }
    if (params.enabled !== undefined) mgr().setServerEnabled(config, params.enabled)
    if (params.scope !== undefined) mgr().setServerScope(config, params.scope)
    return { ok: true }
  })

  ipcMain.handle('mcp:setServersEnabled', (_e, params: {
    serverIds: string[]
    projectId?: string
    enabled: boolean
  }) => {
    const project = params.projectId ? getProjectById(params.projectId) : undefined
    const manager = mgr()
    const all = manager.getAllServers({ projectWorkdir: project?.workdir, projectId: params.projectId })
    const targets = all.filter(server => params.serverIds.includes(server.id))
    for (const server of targets) manager.setServerEnabled(server, params.enabled)
    return { ok: true, updated: targets.length }
  })

  ipcMain.handle('mcp:setToolState', (_e, params: {
    serverId: string
    projectId?: string
    toolFullName: string
    state: McpToolState
  }) => {
    const project = params.projectId ? getProjectById(params.projectId) : undefined
    const all = mgr().getAllServers({ projectWorkdir: project?.workdir, projectId: params.projectId })
    const config = all.find(c => c.id === params.serverId)
    if (!config) return { ok: false, error: 'Сервер не найден' }
    mgr().setToolState(config, params.toolFullName, params.state)
    return { ok: true }
  })

  ipcMain.handle('mcp:setServerToolApproval', (_e, params: {
    serverId: string
    projectId?: string
    toolFullNames: string[]
    requireApproval: boolean
  }) => {
    const project = params.projectId ? getProjectById(params.projectId) : undefined
    const all = mgr().getAllServers({ projectWorkdir: project?.workdir, projectId: params.projectId })
    const config = all.find(c => c.id === params.serverId)
    if (!config) return { ok: false, error: 'Сервер не найден' }
    mgr().setServerToolApproval(config, params.toolFullNames, params.requireApproval)
    return { ok: true }
  })

  // Прямая установка MCP-сервера из маркетплейса — без агента.
  // Пишет конфиг в mcp.json и запускает подключение в фоне.
  ipcMain.handle('mcp:installDirect', (_e, params: {
    name: string
    transport: 'stdio' | 'sse' | 'streamable-http'
    command?: string
    args?: string[]
    env?: Record<string, string>
    url?: string
    headers?: Record<string, string>
    scope: 'global' | { workdir: string }
  }) => {
    return mgr().installDirect(params, params.scope)
  })

  // Обновление конфига существующего сервера (env, args) с реконнектом.
  // Используется GUI-формой редактирования в McpServerCard.
  ipcMain.handle('mcp:updateServer', (_e, params: {
    serverId: string
    env?: Record<string, string>
    args?: string[]
  }) => {
    const all = mgr().getAllServers({})
    const config = all.find(c => c.id === params.serverId)
    if (!config) return { ok: false, error: 'Сервер не найден' }
    // Перезаписываем конфиг с обновлёнными env/args
    const updated = {
      ...config,
      env: params.env,
      args: params.args ?? config.args,
    }
    if (config.source === 'global') {
      mgr().saveGlobalServer(updated)
    }
    // Реконнект с новым конфигом
    mgr().reconnect(params.serverId).catch(() => {})
    return { ok: true }
  })

  // store не используется напрямую (менеджер держит ссылку), но оставлен
  // для консистентности сигнатуры с другими register*IPC.
  void store
}
