/**
 * McpManager — синглтон в main-процессе.
 *
 * Отвечает за:
 *   - жизненный цикл McpClient-ов (lazy connect, disconnect, reconnect)
 *   - агрегацию тулов активных серверов для конкретного чата
 *   - вызов тулов по имени (mcp__server__tool) с маршрутизацией в нужный клиент
 *   - per-tool состояние (enabled/requireApproval) из store
 *   - push-уведомления в renderer при изменении статуса/тулов
 *
 * Подключение серверов:
 *   - Глобальные включённые серверы прогреваются (warmupGlobalServers) один
 *     раз при старте приложения — в фоне, не блокируя запуск. Так первое
 *     chat:send в любом чате не тратит время на holodный старт stdio-процесса
 *     (например npx резолвит пакет несколько секунд).
 *   - Проектные серверы (из .mcp.json) подключаются лениво при первом
 *     обращении агента к чату этого проекта (getActiveToolsForChat →
 *     ensureConnected), либо по явному запросу из UI.
 *
 * Инкогнито: getActiveToolsForChat возвращает [] (внешние серверы отключены).
 */

import Store from 'electron-store'
import { BrowserWindow } from 'electron'
import { McpClient } from './McpClient'
import {
  loadAllServers,
  getProjectToolStates,
  getGlobalToolStates,
  defaultToolState,
  saveGlobalServerToFile,
  deleteGlobalServerFromFile,
  saveProjectServerToFile,
} from './mcpConfig'
import { IPC_EVENTS } from '../../shared/constants'
import type {
  McpServerConfig,
  McpServerRuntime,
  McpToolRuntime,
  McpToolState,
  McpConnectionStatus,
  ExtensionScope,
} from '../../shared/types'
import { log } from '../logger'

export class McpManager {
  /** Не переподключаемся к упавшему серверу чаще, чем раз в это время
   *  (см. ensureConnected) — защита от повторных зависаний на каждый chat:send. */
  private static readonly RECONNECT_COOLDOWN_MS = 60_000

  private store: Store
  /** serverId → McpClient. */
  private clients = new Map<string, McpClient>()
  /** serverId → timestamp последней попытки подключения (для cooldown). */
  private lastConnectAttempt = new Map<string, number>()
  /** win for push events. */
  private win: BrowserWindow | null = null
  /** Кэш последних загруженных конфигов (для getAll без перечитывания). */
  private lastConfigs: McpServerConfig[] = []

  constructor(store: Store) {
    this.store = store
  }

  setWindow(win: BrowserWindow | null): void {
    this.win = win
  }

  /**
   * Прогревает (подключает) все включённые глобальные MCP-серверы сразу
   * при старте приложения — в фоне, параллельно, не блокируя запуск main-процесса.
   * Вызывается один раз из main/index.ts после initMcpManager.
   *
   * Без этого первое сообщение в ЛЮБОМ чате синхронно ждало холодного старта
   * stdio-процесса (npx резолвит пакет несколько секунд при первом запуске)
   * прямо внутри chat:send — весь UI казался "зависшим".
   */
  warmupGlobalServers(): void {
    const configs = loadAllServers(this.store).filter(c => c.source === 'global')
    for (const config of configs) {
      if (!this.getServerEnabled(config)) continue
      this.ensureConnected(config).catch(e => {
        log('[MCP] warmup connect failed:', config.name, (e as Error).message)
      })
    }
  }

  /** Загружает все конфиги серверов (глобальные + проектные). */
  private loadConfigs(projectWorkdir?: string, projectId?: string): McpServerConfig[] {
    this.lastConfigs = loadAllServers(this.store, projectWorkdir, projectId)
    return this.lastConfigs
  }

  /**
   * Возвращает все серверы с runtime-состоянием (для UI popover).
   * Перечитывает .mcp.json с диска каждый выз (дешево).
   */
  getAllServers(opts: { projectWorkdir?: string; projectId?: string } = {}): McpServerRuntime[] {
    const configs = this.loadConfigs(opts.projectWorkdir, opts.projectId)
    return configs.map(c => {
      const client = this.clients.get(c.id)
      const tools = client?.tools ?? []
      const toolStates = this.getToolStatesForServer(c)
      return {
        ...c,
        enabled: this.getServerEnabled(c),
        scope: this.getServerScope(c),
        status: client?.status ?? 'disconnected',
        error: client?.error,
        tools,
        toolStates,
        connectStartedAt: client?.connectStartedAt,
        logs: client?.logs ?? [],
      }
    })
  }

  /** enabled сервера (глобальный тумблер). */
  private getServerEnabled(config: McpServerConfig): boolean {
    if (config.source === 'project' && config.projectId) {
      const state = (this.store.get('mcpProjectState') as Record<string, { enabled?: boolean }> | undefined) ?? {}
      // По умолчанию проектные включены (явное opt-out)
      return state[config.projectId]?.[config.name]?.enabled ?? true
    }
    // Глобальные: по умолчанию включены (явное opt-out через mcpGlobalState)
    const globalState = (this.store.get('mcpGlobalState') as Record<string, { enabled?: boolean }> | undefined) ?? {}
    return globalState[config.name]?.enabled ?? true
  }

  /** scope сервера. */
  private getServerScope(config: McpServerConfig): ExtensionScope {
    if (config.source === 'project' && config.projectId) {
      const state = (this.store.get('mcpProjectState') as Record<string, { scope?: ExtensionScope }> | undefined) ?? {}
      return state[config.projectId]?.[config.name]?.scope ?? { type: 'projects', projectIds: [config.projectId] }
    }
    const globalState = (this.store.get('mcpGlobalState') as Record<string, { scope?: ExtensionScope }> | undefined) ?? {}
    return globalState[config.name]?.scope ?? { type: 'global' }
  }

  /** Per-tool состояние сервера (по полному имени тула). */
  private getToolStatesForServer(config: McpServerConfig): Record<string, McpToolState> {
    if (config.source === 'project' && config.projectId) {
      return getProjectToolStates(this.store, config.projectId, config.name)
    }
    return getGlobalToolStates(this.store, config.name)
  }

  /** Сохраняет per-tool состояние для сервера. */
  setToolState(config: McpServerConfig, toolFullName: string, state: McpToolState): void {
    if (config.source === 'project' && config.projectId) {
      const all = (this.store.get('mcpProjectState') as Record<string, Record<string, { toolStates?: Record<string, McpToolState>; scope?: ExtensionScope; enabled?: boolean }>> | undefined) ?? {}
      if (!all[config.projectId]) all[config.projectId] = {}
      if (!all[config.projectId][config.name]) all[config.projectId][config.name] = {}
      if (!all[config.projectId][config.name].toolStates) all[config.projectId][config.name].toolStates = {}
      all[config.projectId][config.name].toolStates![toolFullName] = state
      this.store.set('mcpProjectState', all)
    } else {
      const all = (this.store.get('mcpGlobalState') as Record<string, { enabled?: boolean; scope?: ExtensionScope; toolStates?: Record<string, McpToolState> }> | undefined) ?? {}
      if (!all[config.name]) all[config.name] = {}
      if (!all[config.name].toolStates) all[config.name].toolStates = {}
      all[config.name].toolStates![toolFullName] = state
      this.store.set('mcpGlobalState', all)
    }
  }

  /** Сохраняет enabled для сервера. */
  setServerEnabled(config: McpServerConfig, enabled: boolean): void {
    if (config.source === 'project' && config.projectId) {
      const all = (this.store.get('mcpProjectState') as Record<string, Record<string, { enabled?: boolean; scope?: ExtensionScope; toolStates?: Record<string, McpToolState> }>> | undefined) ?? {}
      if (!all[config.projectId]) all[config.projectId] = {}
      if (!all[config.projectId][config.name]) all[config.projectId][config.name] = {}
      all[config.projectId][config.name].enabled = enabled
      this.store.set('mcpProjectState', all)
    } else {
      const all = (this.store.get('mcpGlobalState') as Record<string, { enabled?: boolean; scope?: ExtensionScope; toolStates?: Record<string, McpToolState> }> | undefined) ?? {}
      if (!all[config.name]) all[config.name] = {}
      all[config.name].enabled = enabled
      this.store.set('mcpGlobalState', all)
    }
    if (!enabled) {
      // Выключили — отключаем клиент сразу (симметрия с включением).
      this.clients.get(config.id)?.disconnect().then(() => {
        this.clients.delete(config.id)
        this.emitStatus(config.id, 'disconnected')
      })
    } else {
      // Включили — запускаем подключение в фоне (fire-and-forget), чтобы
      // статус/логи обновились сразу, а не при следующем chat:send.Cooldown не
      // сработает: при выключении клиент удалён из this.clients, поэтому
      // ensureConnected создаст новый и подключится без задержки.
      this.ensureConnected(config).catch(e => {
        log('[MCP] enable connect failed:', config.name, (e as Error).message)
      })
    }
  }

  /** Сохраняет scope для сервера. */
  setServerScope(config: McpServerConfig, scope: ExtensionScope): void {
    if (config.source === 'project' && config.projectId) {
      const all = (this.store.get('mcpProjectState') as Record<string, Record<string, { scope?: ExtensionScope; enabled?: boolean; toolStates?: Record<string, McpToolState> }>> | undefined) ?? {}
      if (!all[config.projectId]) all[config.projectId] = {}
      if (!all[config.projectId][config.name]) all[config.projectId][config.name] = {}
      all[config.projectId][config.name].scope = scope
      this.store.set('mcpProjectState', all)
    } else {
      const all = (this.store.get('mcpGlobalState') as Record<string, { enabled?: boolean; scope?: ExtensionScope; toolStates?: Record<string, McpToolState> }> | undefined) ?? {}
      if (!all[config.name]) all[config.name] = {}
      all[config.name].scope = scope
      this.store.set('mcpGlobalState', all)
    }
  }

  // ── CRUD глобальных серверов (файл ~/.syntee/mcp.json) ─────────────────────

  saveGlobalServer(config: McpServerConfig): void {
    saveGlobalServerToFile({ ...config, source: 'global' })
  }

  /** Удаляет глобальный сервер. Принимает id (`global:{name}`) или имя. */
  deleteGlobalServer(id: string): void {
    const name = id.startsWith('global:') ? id.slice('global:'.length) : id
    deleteGlobalServerFromFile(name)
    this.clients.get(id)?.disconnect().then(() => this.clients.delete(id))
    // Чистим runtime-состояние
    const all = (this.store.get('mcpGlobalState') as Record<string, unknown> | undefined) ?? {}
    delete all[name]
    this.store.set('mcpGlobalState', all)
  }

  // ── Подключение ───────────────────────────────────────────────────────────

  /** Явное подключение (из UI). */
  async connect(serverId: string): Promise<void> {
    const config = this.lastConfigs.find(c => c.id === serverId)
    if (!config) return
    await this.ensureConnected(config)
  }

  /** Переподключение: отключить + подключить. Явный вызов из UI — игнорирует cooldown. */
  async reconnect(serverId: string): Promise<void> {
    const existing = this.clients.get(serverId)
    if (existing) {
      await existing.disconnect()
      this.clients.delete(serverId)
    }
    this.lastConnectAttempt.delete(serverId)
    const config = this.lastConfigs.find(c => c.id === serverId)
    if (config) await this.ensureConnected(config)
  }

  /** Отключение. */
  async disconnect(serverId: string): Promise<void> {
    const client = this.clients.get(serverId)
    if (client) {
      await client.disconnect()
      this.clients.delete(serverId)
    }
  }

  /** Lazy-подключение: создаёт клиент если нет, подключает. */
  private async ensureConnected(config: McpServerConfig): Promise<McpClient | null> {
    let client = this.clients.get(config.id)
    if (client && client.status === 'connected') return client
    // Cooldown после неудачной попытки: без него сломанный/недоступный
    // сервер (например npx резолвит несуществующий флаг несколько секунд
    // и падает) переподключался бы заново при КАЖДОМ chat:send — это
    // синхронно блокировало весь чат на время попытки (до 15с таймаута
    // McpClient) при каждом отправленном сообщении.
    if (client && client.status === 'error') {
      const lastAttempt = this.lastConnectAttempt.get(config.id) ?? 0
      if (Date.now() - lastAttempt < McpManager.RECONNECT_COOLDOWN_MS) {
        return null
      }
    }
    if (!client) {
      client = new McpClient(config)
      client.onStatusChange = (status, error) => {
        this.emitStatus(config.id, status, error)
      }
      client.onToolsChange = () => {
        this.emitToolsUpdated(config.id)
      }
      client.onLogChange = () => {
        this.emitLogs(config.id)
      }
      this.clients.set(config.id, client)
    }
    this.lastConnectAttempt.set(config.id, Date.now())
    await client.connect()
    return client
  }

  // ── Агрегация тулов для чата ──────────────────────────────────────────────

  /**
   * Возвращает активные тулы MCP для конкретного чата — для передачи агенту.
   * Учитывает: enabled сервера, scope, incognito, per-tool enabled.
   *
   * НИКОГДА не блокирует и не ждёт подключения — это вызывается синхронно
   * внутри chat:send ПЕРЕД тем, как IPC-хендлер возвращает результат
   * в renderer, а renderer показывает user-сообщение и открывает live-стрим
   * только ПОСЛЕ resolve этого промиса (см. ChatPage.handleSend). Раньше
   * здесь был `await this.ensureConnected(config)` для каждого сервера —
   * если сервер не был подключён (холодный старт npx, зависший процесс),
   * ВСЁ сообщение зависало на десятки секунд: пользователь не видел ни
   * своё сообщение, ни индикатор набора, ни возможность отменить —
   * выглядело как "приложение сломалось".
   *
   * Теперь: уже подключённые серверы используются мгновенно; неподключённые
   * просто пропускаются в ЭТОМ запросе (их тулы недоступны прямо сейчас),
   * а подключение запускается в фоне (fire-and-forget) — к следующему
   * сообщению сервер уже может быть готов.
   */
  getActiveToolsForChat(opts: {
    projectWorkdir?: string
    projectId?: string
    isIncognito?: boolean
  }): McpToolRuntime[] {
    if (opts.isIncognito) return []
    const configs = this.loadConfigs(opts.projectWorkdir, opts.projectId)
    const out: McpToolRuntime[] = []
    for (const config of configs) {
      if (!this.getServerEnabled(config)) continue
      const scope = this.getServerScope(config)
      const applies = this.scopeApplies(scope, opts.projectId)
      log('[MCP] getActiveToolsForChat:', config.name, 'scope:', JSON.stringify(scope), 'projectId:', opts.projectId ?? '(none)', 'applies:', applies)
      if (!applies) continue
      const client = this.clients.get(config.id)
      if (client && client.status === 'connected') {
        const toolStates = this.getToolStatesForServer(config)
        for (const tool of client.tools) {
          const state = toolStates[tool.name] ?? defaultToolState()
          if (state.enabled) out.push(tool)
        }
      } else {
        // Не подключён (или ещё коннектится/упал) — не ждём. Запускаем/
        // продолжаем подключение в фоне для будущих сообщений.
        this.ensureConnected(config).catch(() => { /* лог уже пишется внутри */ })
      }
    }
    return out
  }

  /** Проверяет, нужно ли подтверждение для тулза MCP. */
  requiresApproval(config: McpServerConfig, toolFullName: string): boolean {
    const states = this.getToolStatesForServer(config)
    const state = states[toolFullName] ?? defaultToolState()
    return state.requireApproval
  }

  /**
   * Возвращает id активных MCP-серверов для конкретного чата — для бейджа.
   * Фильтрует по enabled + scope + статусу (connected/connecting).
   * Симметрично getActiveSkillsForChat в skillManager.
   */
  getActiveServerIdsForChat(opts: {
    projectWorkdir?: string
    projectId?: string
    isIncognito?: boolean
  }): string[] {
    if (opts.isIncognito) return []
    const configs = this.loadConfigs(opts.projectWorkdir, opts.projectId)
    const out: string[] = []
    for (const config of configs) {
      if (!this.getServerEnabled(config)) continue
      if (!this.scopeApplies(this.getServerScope(config), opts.projectId)) continue
      const client = this.clients.get(config.id)
      if (client && (client.status === 'connected' || client.status === 'connecting')) {
        out.push(config.id)
      }
    }
    return out
  }

  /**
   * Вызов тулза по имени. Маршрутизация: mcp__serverName__toolName → клиент.
   * serverName извлекается из имени (после mcp__).
   */
  async callToolByName(
    fullToolName: string,
    args: Record<string, unknown>,
    opts: { projectWorkdir?: string; projectId?: string },
  ): Promise<{ success: boolean; output: string; error?: string }> {
    // Парсим mcp__serverName__toolName. ServerName после sanitize может
    // содержать подчёркивания (напр. `dolphin-browser` → `dolphin_browser`),
    // поэтому regex `[^_]+` обламывается — используем indexOf('__') как
    // extractMcpServerName в Agent.ts. Сервер = до ПЕРВОГО `__`, тул = после.
    if (!fullToolName.startsWith('mcp__')) {
      return { success: false, output: '', error: `Некорректное имя MCP-тула: ${fullToolName}` }
    }
    const rest = fullToolName.slice(5) // убираем 'mcp__'
    const firstSep = rest.indexOf('__')
    if (firstSep === -1) {
      return { success: false, output: '', error: `Некорректное имя MCP-тула: ${fullToolName}` }
    }
    const serverNameRaw = rest.slice(0, firstSep)
    const toolShortName = rest.slice(firstSep + 2)
    const configs = this.loadConfigs(opts.projectWorkdir, opts.projectId)
    // Находим сервер по sanitized-имени (как формирует McpClient).
    const sanitize = (n: string) => n.replace(/[^A-Za-z0-9_]/g, '_')
    const config = configs.find(c => sanitize(c.name) === serverNameRaw)
    if (!config) {
      return { success: false, output: '', error: `MCP-сервер не найден для тула ${fullToolName}` }
    }
    const client = await this.ensureConnected(config)
    if (!client || client.status !== 'connected') {
      return { success: false, output: '', error: `MCP-сервер ${config.name} не подключён` }
    }
    return client.callTool(toolShortName, args)
  }

  /**
   * Применимо ли расширение к данному чату по scope.
   * - global → всегда да
   * - projects → да если projectId в списке projectIds
   * Public — используется buildExtensionsReport в chat.ipc.ts.
   */
  isScopeApplicable(scope: ExtensionScope, projectId?: string): boolean {
    return this.scopeApplies(scope, projectId)
  }

  private scopeApplies(scope: ExtensionScope, projectId?: string): boolean {
    if (scope.type === 'global') return true
    if (!projectId || !scope.projectIds?.length) return false
    return scope.projectIds.includes(projectId)
  }

  // ── Push events в renderer ────────────────────────────────────────────────

  /**
   * Прямая установка MCP-сервера из маркетплейса — БЕЗ агента.
   * Пишет конфиг в ~/.syntee/mcp.json (global) или {workdir}/.mcp.json (project),
   * затем запускает подключение в фоне (fire-and-forget).
   *
   * Возвращает { ok, serverName, error? }. UI после вызова делает reloadMcp()
   * и сервер появляется в списке со статусом 'connecting', а push-событие
   * mcp:status обновит его до 'connected' или 'error'.
   *
   * @param params — конфиг сервера (name, transport, command/args/env или url/headers)
   * @param scope  — 'global' или { workdir } для проектной установки
   */
  installDirect(
    params: {
      name: string
      transport: 'stdio' | 'sse' | 'streamable-http'
      command?: string
      args?: string[]
      env?: Record<string, string>
      url?: string
      headers?: Record<string, string>
    },
    scope: 'global' | { workdir: string },
  ): { ok: boolean; serverName: string; error?: string } {
    const serverName = params.name.trim()
    if (!serverName) return { ok: false, serverName: '', error: 'Имя сервера обязательно' }

    const config: McpServerConfig = {
      id: scope === 'global' ? `global:${serverName}` : `project:${serverName}`,
      name: serverName,
      transport: params.transport,
      command: params.command,
      args: params.args,
      env: params.env,
      url: params.url,
      headers: params.headers,
      enabled: true,
      scope: scope === 'global' ? { type: 'global' } : { type: 'projects', projectIds: [] },
      source: scope === 'global' ? 'global' : 'project',
    }

    try {
      if (scope === 'global') {
        saveGlobalServerToFile(config)
      } else {
        saveProjectServerToFile(config, scope.workdir)
      }
    } catch (e) {
      return { ok: false, serverName, error: `Не удалось записать конфиг: ${(e as Error).message}` }
    }

    // Инвалидируем кэш конфигов чтобы новый сервер подхватился
    this.lastConfigs = loadAllServers(this.store, scope === 'global' ? undefined : scope.workdir)

    // Запускаем подключение в фоне — не блокируем IPC-ответ.
    const targetConfig = this.lastConfigs.find(c => c.name === serverName && c.source === config.source)
    if (targetConfig) {
      this.ensureConnected(targetConfig).catch(e => {
        log('[MCP] installDirect connect failed:', serverName, (e as Error).message)
      })
    }

    return { ok: true, serverName }
  }

  private emitStatus(serverId: string, status: McpConnectionStatus, error?: string): void {
    const client = this.clients.get(serverId)
    log('[MCP] emitStatus:', serverId, status, error ?? '')
    this.win?.webContents.send(IPC_EVENTS.MCP_STATUS, {
      serverId,
      status,
      error,
      connectStartedAt: client?.connectStartedAt,
      // Логи шлём вместе со статусом — при смене статуса (особенно error/connected)
      // UI получает актуальный журнал сразу, без отдельного mcp:logs-круга.
      logs: client?.logs ?? [],
    })
  }

  private emitToolsUpdated(serverId: string): void {
    const client = this.clients.get(serverId)
    this.win?.webContents.send(IPC_EVENTS.MCP_TOOLS_UPDATED, {
      serverId,
      tools: client?.tools ?? [],
    })
  }

  /** Push обновления журнала подключения (вызывается McpClient.onLogChange с троттлом). */
  private emitLogs(serverId: string): void {
    const client = this.clients.get(serverId)
    if (!client) return
    this.win?.webContents.send(IPC_EVENTS.MCP_LOGS, {
      serverId,
      logs: client.logs,
    })
  }
}

// ── Синглтон ────────────────────────────────────────────────────────────────

let mcpManagerInstance: McpManager | null = null

export function initMcpManager(store: Store): McpManager {
  mcpManagerInstance = new McpManager(store)
  return mcpManagerInstance
}

export function getMcpManager(): McpManager {
  if (!mcpManagerInstance) {
    throw new Error('McpManager не инициализирован. Вызови initMcpManager() в main.')
  }
  return mcpManagerInstance
}
