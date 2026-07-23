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
import { getProjectById, getChatWorkdirContext, getAllProjects } from '../../core/db/database'
import type { McpServerConfig, McpToolState, ExtensionScope } from '../../shared/types'

export function registerMcpIPC(store: Store, getWindow: () => BrowserWindow | null): void {
  // Обновляем окно в менеджере при каждом вызове (оно может пересоздаваться).
  const mgr = () => {
    const m = getMcpManager()
    m.setWindow(getWindow())
    return m
  }

  ipcMain.handle('mcp:getAll', (_e, params?: { projectId?: string }) => {
    let projectWorkdir: string | undefined
    if (params?.projectId) {
      const proj = getProjectById(params.projectId)
      projectWorkdir = proj?.workdir
    }
    return mgr().getAllServers({ projectWorkdir, projectId: params?.projectId })
  })

  // Активные MCP-серверы для конкретного чата (для бейджа над инпутом).
  // Фильтрует по enabled + scope + статусу — симметрично skills:getActive.
  ipcMain.handle('mcp:getActiveForChat', (_e, params: { chatId: string; isIncognito?: boolean }) => {
    let projectWorkdir: string | undefined
    let projectId: string | undefined
    try {
      const ctx = getChatWorkdirContext(params.chatId)
      if (ctx.workdir) {
        projectWorkdir = ctx.workdir
        const found = getAllProjects().find(p => p.workdir === ctx.workdir)
        projectId = found?.id
      }
    } catch { /* чат без проекта — projectWorkdir/projectId останутся undefined */ }
    return mgr().getActiveServerIdsForChat({
      projectWorkdir,
      projectId,
      isIncognito: params.isIncognito,
    })
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
    enabled?: boolean
    scope?: ExtensionScope
  }) => {
    // Нужно найти конфиг сервера по id среди последних загруженных.
    // Берём все серверы (без project, чтобы покрыть глобальные).
    const all = mgr().getAllServers({})
    const config = all.find(c => c.id === params.serverId)
    if (!config) return { ok: false, error: 'Сервер не найден' }
    if (params.enabled !== undefined) mgr().setServerEnabled(config, params.enabled)
    if (params.scope !== undefined) mgr().setServerScope(config, params.scope)
    return { ok: true }
  })

  ipcMain.handle('mcp:setToolState', (_e, params: {
    serverId: string
    toolFullName: string
    state: McpToolState
  }) => {
    const all = mgr().getAllServers({})
    const config = all.find(c => c.id === params.serverId)
    if (!config) return { ok: false, error: 'Сервер не найден' }
    mgr().setToolState(config, params.toolFullName, params.state)
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
