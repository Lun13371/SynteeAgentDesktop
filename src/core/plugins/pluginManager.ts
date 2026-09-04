/**
 * PluginManager — синглтон в main-процессе.
 *
 * Отвечает за:
 *   - сканирование папок плагинов (глобальные + проектные) и валидацию
 *   - per-plugin состояние (enabled + scope) в electron-store (pluginsState)
 *   - жизненный цикл процессов: start / stop / reload (utilityProcess)
 *   - агрегацию тулов активных плагинов для конкретного чата
 *   - вызов тулов по имени (plugin__{pluginId}__{toolName})
 *   - обработку hostRequest-ов плагинов (storage / clipboard / net / notify)
 *   - push-события в renderer (plugins:changed, plugins:logs)
 *
 * Модель состояний:
 *   - плагин без записи в pluginsState — по умолчанию ВЫключен (opt-in)
 *   - включение = запуск процесса; выключение = graceful stop
 *   - крах процесса → статус 'error', повторная попытка при следующем
 *     включении/reload или при обращении (getActiveToolsForChat не
 *     перезапускает упавшие — как MCP cooldown, но проще: только вручную)
 *
 * Инкогнито: getActiveToolsForChat возвращает [] (приватность).
 */

import Store from 'electron-store'
import { BrowserWindow, app, clipboard, dialog, net as electronNet, Notification } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from 'fs'
import { join, dirname } from 'path'
import { scanPluginsDir } from './pluginLoader'
import { PluginProcess } from './pluginProcess'
import { PluginStorage } from './pluginStorage'
import { IPC_EVENTS } from '../../shared/constants'
import { getAllChats } from '../db/chats'
import { getMessages } from '../db/messages'
import { getAllProjects } from '../db/projects'
import { searchMemories, saveMemory } from '../memory/MemoryEngine'
import type {
  Plugin,
  PluginState,
  PluginRuntime,
  PluginToolRuntime,
  PluginLogEntry,
  PluginPromptInfo,
  PluginCommandRuntime,
  PluginUiContribution,
  PluginThemeInfo,
  ExtensionScope,
} from '../../shared/types'
import type { SlashCommand } from '../../shared/slashCommands'

/** Cap журнала плагина (кольцевой буфер для UI). */
const LOG_CAP = 200
/** Максимальный размер ответа net.fetch (1 МБ). */
const NET_FETCH_MAX_BYTES = 1_048_576
/** Максимальный размер файла для fs.readFile (5 МБ). */
const FS_READ_MAX_BYTES = 5_242_880
/** Дебаунс fs.watch перед hot-reload (мс). */
const WATCH_DEBOUNCE_MS = 800

interface RunningPlugin {
  proc: PluginProcess
  tools: Map<string, PluginToolRuntime> // shortName → tool
  commands: Map<string, PluginCommandRuntime> // name → command
  ui: PluginUiContribution[]
  logs: PluginLogEntry[]
  /** События, на которые плагин подписан (для short-circuit хуков). */
  subscribedEvents: Set<string>
}

export class PluginManager {
  private store: Store
  private storage: PluginStorage
  private win: BrowserWindow | null = null

  /** pluginId → запущенный процесс + агрегаты. */
  private running = new Map<string, RunningPlugin>()
  /** Последний ошибочный статус по pluginId (для UI, когда процесс умер). */
  private errors = new Map<string, string>()
  /** Кэш последнего скана (для getAll без перечитывания диска). */
  private lastScan: Plugin[] = []
  /** fs.watch-еры: путь папки → watcher + debounce. Для hot-reload. */
  private watchers = new Map<string, { watcher: FSWatcher; timer: NodeJS.Timeout | null }>()

  constructor(store: Store) {
    this.store = store
    this.storage = new PluginStorage(app.getPath('userData'))
    // Создаём папку глобальных плагинов сразу — чтобы кнопка «Открыть папку
    // плагинов» и установка из папки работали даже при нулевом количестве
    // плагинов (иначе shell.openPath показывает «Не удается найти путь»).
    if (!existsSync(this.globalPluginsDir)) {
      try { mkdirSync(this.globalPluginsDir, { recursive: true }) } catch { /* ignore */ }
    }
  }

  setWindow(win: BrowserWindow | null): void {
    this.win = win
  }

  get globalPluginsDir(): string {
    return join(app.getPath('userData'), 'plugins')
  }

  projectPluginsDir(workdir: string): string {
    return join(workdir, '.syntee', 'plugins')
  }

  // ── Скан и состояние ───────────────────────────────────────────────────

  /** Сканирует глобальные + проектные папки. */
  scan(projectWorkdir?: string, projectId?: string): Plugin[] {
    const globalPlugins = scanPluginsDir(this.globalPluginsDir, 'global')
    const projectPlugins = projectWorkdir
      ? scanPluginsDir(this.projectPluginsDir(projectWorkdir), 'project', projectId)
      : []
    // Дедуп по id (глобальный приоритетнее).
    const seen = new Set(globalPlugins.map(p => p.id))
    this.lastScan = [...globalPlugins, ...projectPlugins.filter(p => !seen.has(p.id))]
    // Hot-reload watcher: глобальная папка — всегда; проектная — при скане.
    this.ensureWatcher(this.globalPluginsDir)
    if (projectWorkdir) this.ensureWatcher(this.projectPluginsDir(projectWorkdir))
    return this.lastScan
  }

  // ── Hot-reload (fs.watch) ──────────────────────────────────────────────

  /** Регистрирует рекурсивный watcher на папку плагинов. При изменении
   *  файлов — дебаунс → hot-reload затронутого запущенного плагина.
   *  Разработка плагина: сохранил файл → плагин перезапустился сам. */
  private ensureWatcher(dir: string): void {
    if (this.watchers.has(dir) || !existsSync(dir)) return
    try {
      const watcher = watch(dir, { recursive: true }, (_event, filename) => {
        const rel = String(filename ?? '')
        // Игнорируем временные файлы редакторов/сборщиков.
        if (/(^|[\\/])~|\.(tmp|crdownload|lock)$/.test(rel)) return
        const entry = this.watchers.get(dir)
        if (entry?.timer) clearTimeout(entry.timer)
        const timer = setTimeout(() => {
          const e = this.watchers.get(dir)
          if (e) e.timer = null
          this.handleFsChange(rel)
        }, WATCH_DEBOUNCE_MS)
        const existing = this.watchers.get(dir)
        if (existing) existing.timer = timer
      })
      this.watchers.set(dir, { watcher, timer: null })
    } catch {
      // recursive watch может не поддерживаться на некоторых платформах —
      // hot-reload просто отключается, остальное работает.
    }
  }

  /** Изменение в папке плагинов: определяем pluginId и перезагружаем
   *  запущенный плагин. Не запущенные трогаем только push-событием. */
  private handleFsChange(relPath: string): void {
    const pluginId = relPath.split(/[\\/]/)[0]
    if (!pluginId) return
    const run = this.running.get(pluginId)
    if (run) {
      console.log(`[plugins] hot-reload: ${pluginId} (${relPath})`)
      this.reload(pluginId).catch(e => {
        console.warn(`[plugins] hot-reload failed: ${pluginId}:`, (e as Error).message)
      })
    } else {
      // Не запущен — но список/манифест могли измениться: пуш в renderer.
      this.lastScan = []
      this.emitChanged()
    }
  }

  /** Остановить все watcher-ы (при выходе). */
  stopWatchers(): void {
    for (const [, entry] of this.watchers) {
      if (entry.timer) clearTimeout(entry.timer)
      try { entry.watcher.close() } catch { /* ignore */ }
    }
    this.watchers.clear()
  }

  /** Состояние плагина (по умолчанию выключен — явный opt-in). */
  getState(pluginId: string): PluginState {
    const stateMap = (this.store.get('pluginsState') as Record<string, PluginState> | undefined) ?? {}
    return stateMap[pluginId] ?? { enabled: false, scope: { type: 'global' } }
  }

  setState(pluginId: string, state: PluginState): void {
    const stateMap = (this.store.get('pluginsState') as Record<string, PluginState> | undefined) ?? {}
    stateMap[pluginId] = state
    this.store.set('pluginsState', stateMap)
  }

  private scopeApplies(scope: ExtensionScope, projectId?: string): boolean {
    if (scope.type === 'global') return true
    if (!projectId || !scope.projectIds?.length) return false
    return scope.projectIds.includes(projectId)
  }

  /** Все плагины с состоянием + runtime-статусом — для UI (popover). */
  getAllWithState(opts: { projectWorkdir?: string; projectId?: string } = {}): PluginRuntime[] {
    const plugins = this.scan(opts.projectWorkdir, opts.projectId)
    return plugins.map(p => {
      const run = this.running.get(p.id)
      return {
        ...p,
        state: this.getState(p.id),
        status: run ? 'running' : (this.errors.get(p.id) ? 'error' : 'stopped'),
        error: this.errors.get(p.id),
        tools: run ? [...run.tools.values()] : [],
        commands: run ? [...run.commands.values()] : [],
        ui: run ? run.ui : [],
        configValues: this.getConfigValues(p.id, p.manifest.config),
        logs: run ? run.logs : [],
      }
    })
  }

  // ── Жизненный цикл процессов ───────────────────────────────────────────

  /** Запускает процесс плагина (по id из последнего скана). */
  async start(pluginId: string): Promise<void> {
    if (this.running.has(pluginId)) return
    const plugin = this.lastScan.find(p => p.id === pluginId)
      ?? this.scan().find(p => p.id === pluginId)
    if (!plugin) throw new Error(`Плагин не найден: ${pluginId}`)

    const run: RunningPlugin = {
      proc: null as unknown as RunningPlugin['proc'],
      tools: new Map(),
      commands: new Map(),
      ui: [],
      logs: [],
      subscribedEvents: new Set(),
    }
    const proc = new PluginProcess(plugin.id, plugin.dir, plugin.manifest.permissions ?? [], {
      onToolRegistered: tool => {
        run.tools.set(tool.shortName, tool)
        this.emitChanged()
      },
      onCommandRegistered: command => {
        run.commands.set(command.name, command)
        this.emitChanged()
      },
      onUiRegistered: contribution => {
        // Дедуп по panelId (right/modal) или label+type (sidebar).
        run.ui = run.ui.filter(u => {
          if (contribution.panelId) return u.panelId !== contribution.panelId
          return !(u.label === contribution.label && u.type === contribution.type)
        })
        run.ui.push(contribution)
        this.emitChanged()
      },
      onUiPostMessage: data => {
        this.win?.webContents.send(IPC_EVENTS.PLUGINS_UI_MESSAGE, { pluginId, data })
      },
      onEventsSubscribed: events => {
        run.subscribedEvents = new Set(events)
      },
      onLog: entry => {
        run.logs.push(entry)
        if (run.logs.length > LOG_CAP) run.logs.splice(0, run.logs.length - LOG_CAP)
        this.win?.webContents.send(IPC_EVENTS.PLUGINS_LOGS, { pluginId, logs: run.logs })
      },
      onExit: code => {
        // Процесс умер (краш или stop уже обработан — stop удаляет из running).
        if (this.running.get(pluginId)?.proc === proc) {
          this.running.delete(pluginId)
          if (code !== 0) {
            this.errors.set(pluginId, `Процесс плагина завершился (code ${code})`)
          }
          this.emitChanged()
        }
      },
      onHostRequest: (method, params) => this.handleHostRequest(pluginId, method, params),
    })
    run.proc = proc
    this.errors.delete(pluginId)
    try {
      await proc.start()
      this.running.set(pluginId, run)
      this.pushLog(pluginId, run, 'info', `Плагин запущен (${plugin.manifest.name} v${plugin.manifest.version})`)
    } catch (e) {
      this.errors.set(pluginId, (e as Error).message)
      this.emitChanged()
      throw e
    }
    this.emitChanged()
  }

  /** Останавливает процесс плагина. */
  async stop(pluginId: string): Promise<void> {
    const run = this.running.get(pluginId)
    if (!run) return
    this.running.delete(pluginId)
    await run.proc.stop()
    this.emitChanged()
  }

  /** Hot reload: stop + start. */
  async reload(pluginId: string): Promise<void> {
    await this.stop(pluginId)
    this.errors.delete(pluginId)
    this.lastScan = [] // форсируем перескан (манифест мог измениться)
    await this.start(pluginId)
  }

  /** Включение/выключение из UI. Consent: плагин с permissions включается
   *  только после подтверждения прав пользователем (state.consented). */
  async setEnabled(pluginId: string, enabled: boolean, projectWorkdir?: string, projectId?: string): Promise<void> {
    const state = this.getState(pluginId)
    if (enabled) {
      this.scan(projectWorkdir, projectId)
      const plugin = this.lastScan.find(p => p.id === pluginId)
      const perms = plugin?.manifest.permissions ?? []
      if (perms.length > 0 && !state.consented) {
        throw new Error('Требуется подтверждение прав плагина (consent)')
      }
    }
    this.setState(pluginId, { ...state, enabled })
    if (enabled) {
      // Пересканируем чтобы найти плагин (start использует lastScan).
      this.scan(projectWorkdir, projectId)
      await this.start(pluginId)
    } else {
      await this.stop(pluginId)
    }
  }

  /** Подтверждение прав (consent-диалог в UI). */
  setConsented(pluginId: string, consented: boolean): void {
    const state = this.getState(pluginId)
    this.setState(pluginId, { ...state, consented })
  }

  setScope(pluginId: string, scope: ExtensionScope): void {
    const state = this.getState(pluginId)
    this.setState(pluginId, { ...state, scope })
  }

  /** Остановить все процессы (при выходе из приложения). */
  async shutdownAll(): Promise<void> {
    this.stopWatchers()
    await Promise.allSettled([...this.running.keys()].map(id => this.stop(id)))
    this.storage.flushAll()
  }

  // ── Команды ────────────────────────────────────────────────────────────

  /**
   * Слэш-команды активных плагинов для UI (автокомплит ChatInput).
   * Возвращает SlashCommand-подобные объекты с маркером plugin —
   * ChatPage перехватывает их ДО агента и вызывает executeCommand.
   */
  getCommandsForUI(opts: { projectWorkdir?: string; projectId?: string } = {}): SlashCommand[] {
    const plugins = this.scan(opts.projectWorkdir, opts.projectId)
    const out: SlashCommand[] = []
    for (const plugin of plugins) {
      const state = this.getState(plugin.id)
      if (!state.enabled) continue
      if (!this.scopeApplies(state.scope, opts.projectId)) continue
      const run = this.running.get(plugin.id)
      if (!run) continue
      for (const cmd of run.commands.values()) {
        out.push({
          name: cmd.name,
          label: `/${cmd.name}`,
          description: `${cmd.description} · ${plugin.manifest.name}`,
          icon: cmd.icon || 'puzzle',
          systemPrompt: () => '',
          source: 'user',
          custom: true,
          plugin: { pluginId: plugin.id, name: cmd.name },
        })
      }
    }
    return out
  }

  /** Вызов слэш-команды плагина. */
  async executeCommand(pluginId: string, commandName: string, args: string): Promise<{ ok: boolean; output?: string; error?: string }> {
    const run = this.running.get(pluginId)
    if (!run) return { ok: false, error: `Плагин не запущен: ${pluginId}` }
    return run.proc.callCommand(commandName, args)
  }

  // ── Хуки ───────────────────────────────────────────────────────────────

  /** Рассылает событие chat:message всем запущенным плагинам.
   *  Fire-and-forget — НИКОГДА не блокирует отправку сообщения в чате. */
  emitChatMessage(chatId: string, content: string): void {
    for (const [pluginId, run] of this.running) {
      try {
        run.proc.sendEvent('chat:message', { chatId, content })
      } catch (e) {
        console.warn(`[plugins] emitChatMessage → ${pluginId} failed:`, (e as Error).message)
      }
    }
  }

  /** Хук chat:before-send — плагины могут модифицировать или отклонить
   *  сообщение. Опрашиваются ТОЛЬКО плагины с подписчиками (short-circuit),
   *  таймаут каждого — HOOK_TIMEOUT_MS (не тормозим чат). */
  async beforeChatSend(chatId: string, content: string): Promise<{ allowed: boolean; content: string; reason?: string }> {
    let result = content
    for (const [pluginId, run] of this.running) {
      if (!run.subscribedEvents.has('chat:before-send')) continue
      try {
        const r = await run.proc.callHook('chat:before-send', { chatId, content: result })
        if (r.action === 'reject') {
          return { allowed: false, content: result, reason: r.reason || `Отклонено плагином ${pluginId}` }
        }
        if (r.action === 'modify' && typeof r.content === 'string') {
          result = r.content
        }
      } catch (e) {
        console.warn(`[plugins] beforeChatSend → ${pluginId} failed:`, (e as Error).message)
      }
    }
    return { allowed: true, content: result }
  }

  /** Событие tool:call — вызов любого тула агентом (fire-and-forget). */
  emitToolCall(toolName: string, args: Record<string, unknown>): void {
    for (const run of this.running.values()) {
      try {
        run.proc.sendEvent('tool:call', { toolName, args })
      } catch { /* dead — ок */ }
    }
  }

  /** Смена темы: кэш для ui.getTheme + рассылка события theme:changed. */
  setTheme(theme: string, accentColor: string): void {
    const dark = !LIGHT_THEMES.has(theme)
    for (const [, run] of this.running) {
      try {
        run.proc.sendEvent('theme:changed', { theme, accentColor, dark })
      } catch { /* dead — ок */ }
    }
  }

  /** Текущая тема (для ui.getTheme из плагина). */
  getThemeInfo(): PluginThemeInfo {
    const theme = String(this.store.get('theme') ?? 'dark')
    const accentColor = String(this.store.get('accentColor') ?? '#22d3ee')
    return { theme, accentColor, dark: !LIGHT_THEMES.has(theme) }
  }

  // ── UI-мост (iframe-панели) ────────────────────────────────────────────

  /** Сообщение из iframe-панели плагина (renderer → plugin process). */
  sendUiMessage(pluginId: string, data: unknown): void {
    this.running.get(pluginId)?.proc.sendUiMessage(data)
  }

  /** RPC-вызов из iframe-панели (synteeBridge.call → ui.handle). */
  async uiCall(pluginId: string, method: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const run = this.running.get(pluginId)
    if (!run) return { ok: false, error: `Плагин не запущен: ${pluginId}` }
    return run.proc.uiCall(method, args)
  }

  /** Плагин просит открыть/закрыть свою панель (right-таб или modal). */
  panelAction(pluginId: string, action: 'open' | 'close', panelId: string): void {
    this.win?.webContents.send(IPC_EVENTS.PLUGINS_PANEL_ACTION, { pluginId, action, panelId })
  }

  /** Бейдж на табе панели плагина (null — убрать). */
  setPanelBadge(pluginId: string, panelId: string, badge: number | null): void {
    this.win?.webContents.send(IPC_EVENTS.PLUGINS_BADGE, { pluginId, panelId, badge })
  }

  /** Тост от плагина. */
  toast(text: string, kind: 'info' | 'success' | 'error' = 'info'): void {
    this.win?.webContents.send(IPC_EVENTS.PLUGINS_TOAST, { text, kind })
  }

  /** Действие плагина в чате (renderer знает текущий chatId). */
  chatAction(action: 'send' | 'reply', text: string, silent = false): void {
    this.win?.webContents.send(IPC_EVENTS.PLUGINS_CHAT_ACTION, { action, text, silent })
  }

  /** Находит папку плагина по id (для syntee-plugin:// протокола). */
  findPluginDir(pluginId: string): string | null {
    const found = this.lastScan.find(p => p.id === pluginId)
      ?? this.scan().find(p => p.id === pluginId)
    return found?.dir ?? null
  }

  /** UI-файл плагина (манифест ui) — для iframe-панели. */
  getPluginUiEntry(pluginId: string): string | null {
    const found = this.lastScan.find(p => p.id === pluginId)
      ?? this.scan().find(p => p.id === pluginId)
    return found?.manifest.ui ?? null
  }

  // ── Настройки (config) ─────────────────────────────────────────────────

  /** Значения настроек плагина: дефолты манифеста + сохранённые значения. */
  getConfigValues(pluginId: string, manifestConfig?: Array<{ key: string; default?: unknown }>): Record<string, unknown> {
    const saved = (this.store.get('pluginsConfig') as Record<string, Record<string, unknown>> | undefined)?.[pluginId] ?? {}
    const out: Record<string, unknown> = {}
    for (const field of manifestConfig ?? []) {
      out[field.key] = saved[field.key] !== undefined ? saved[field.key] : (field.default ?? '')
    }
    // Сохранённые ключи вне схемы — тоже возвращаем (на случай изменения схемы).
    for (const [k, v] of Object.entries(saved)) {
      if (!(k in out)) out[k] = v
    }
    return out
  }

  /** Сохраняет значения настроек (merge с существующими). */
  setConfigValues(pluginId: string, values: Record<string, unknown>): void {
    const all = (this.store.get('pluginsConfig') as Record<string, Record<string, unknown>> | undefined) ?? {}
    all[pluginId] = { ...(all[pluginId] ?? {}), ...values }
    this.store.set('pluginsConfig', all)
  }

  // ── Тулы для агента ────────────────────────────────────────────────────

  /**
   * Активные тулы плагинов для конкретного чата (enabled + scope + running).
   * Инкогнито → []. Синхронно, никогда не ждёт запуска процессов.
   */
  getActiveToolsForChat(opts: {
    projectWorkdir?: string
    projectId?: string
    isIncognito?: boolean
  }): PluginToolRuntime[] {
    if (opts.isIncognito) return []
    const plugins = this.scan(opts.projectWorkdir, opts.projectId)
    const out: PluginToolRuntime[] = []
    for (const plugin of plugins) {
      const state = this.getState(plugin.id)
      if (!state.enabled) continue
      if (!this.scopeApplies(state.scope, opts.projectId)) continue
      const run = this.running.get(plugin.id)
      if (!run) continue // не запущен — тулы недоступны в этом запросе
      out.push(...run.tools.values())
    }
    return out
  }

  /** Активные плагины для system prompt (краткая инфа + имена тулов). */
  getActivePluginsForChat(opts: {
    projectWorkdir?: string
    projectId?: string
    isIncognito?: boolean
  }): PluginPromptInfo[] {
    if (opts.isIncognito) return []
    const plugins = this.scan(opts.projectWorkdir, opts.projectId)
    const out: PluginPromptInfo[] = []
    for (const plugin of plugins) {
      const state = this.getState(plugin.id)
      if (!state.enabled) continue
      if (!this.scopeApplies(state.scope, opts.projectId)) continue
      const run = this.running.get(plugin.id)
      out.push({
        id: plugin.id,
        name: plugin.manifest.name,
        promptDescription: plugin.manifest.promptDescription,
        tools: run ? [...run.tools.keys()] : [],
      })
    }
    return out
  }

  /** Вызов тула по полному имени plugin__{pluginId}__{toolName}. */
  async callToolByName(
    fullToolName: string,
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    const parsed = parsePluginToolName(fullToolName)
    if (!parsed) return { success: false, output: '', error: `Некорректное имя тула плагина: ${fullToolName}` }
    const run = this.running.get(parsed.pluginId)
    if (!run) return { success: false, output: '', error: `Плагин не запущен: ${parsed.pluginId}` }
    const r = await run.proc.callTool(parsed.toolName, args)
    return {
      success: r.ok,
      output: r.output ?? '',
      error: r.error,
    }
  }

  // ── Host-API для плагинов ──────────────────────────────────────────────

  private async handleHostRequest(
    pluginId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    try {
      switch (method) {
        case 'storage.get':
          return { ok: true, result: this.storage.get(pluginId, String(params.key ?? '')) }
        case 'storage.set':
          this.storage.set(pluginId, String(params.key ?? ''), params.value)
          return { ok: true }
        case 'storage.delete':
          this.storage.delete(pluginId, String(params.key ?? ''))
          return { ok: true }
        case 'clipboard.readText':
          return { ok: true, result: clipboard.readText() }
        case 'clipboard.writeText':
          clipboard.writeText(String(params.text ?? ''))
          return { ok: true }
        case 'notification.show': {
          const title = String(params.title ?? 'Плагин')
          const body = String(params.body ?? '')
          if (Notification.isSupported()) {
            new Notification({ title, body }).show()
          }
          return { ok: true }
        }
        case 'net.fetch': {
          const url = String(params.url ?? '')
          if (!/^https?:\/\//.test(url)) {
            return { ok: false, error: 'net.fetch: только http/https' }
          }
          const init = (params.init ?? {}) as { method?: string; headers?: Record<string, string>; body?: string }
          const resp = await electronNet.fetch(url, {
            method: init.method ?? 'GET',
            headers: init.headers,
            body: init.body,
          })
          const headers: Record<string, string> = {}
          resp.headers.forEach((v, k) => { headers[k] = v })
          let bodyText = ''
          if (resp.body) {
            const buf = await resp.arrayBuffer()
            const bytes = buf.byteLength > NET_FETCH_MAX_BYTES
              ? buf.slice(0, NET_FETCH_MAX_BYTES)
              : buf
            bodyText = new TextDecoder().decode(bytes)
            if (buf.byteLength > NET_FETCH_MAX_BYTES) bodyText += '\n…(обрезано до 1 МБ)'
          }
          return { ok: true, result: { status: resp.status, headers, body: bodyText } }
        }
        case 'fs.readFile': {
          const p = String(params.path ?? '')
          if (!p) return { ok: false, error: 'fs.readFile: path обязателен' }
          const st = statSync(p)
          if (!st.isFile()) return { ok: false, error: 'fs.readFile: не файл' }
          if (st.size > FS_READ_MAX_BYTES) {
            return { ok: false, error: `fs.readFile: файл больше ${FS_READ_MAX_BYTES} байт` }
          }
          return { ok: true, result: readFileSync(p, 'utf-8') }
        }
        case 'fs.writeFile': {
          const p = String(params.path ?? '')
          if (!p) return { ok: false, error: 'fs.writeFile: path обязателен' }
          // Песочница записи: только внутри папки плагина (path traversal закрыт).
          const pluginDir = this.findPluginDir(pluginId)
          if (!pluginDir) return { ok: false, error: 'fs.writeFile: папка плагина не найдена' }
          const resolved = join(p)
          if (!resolved.startsWith(pluginDir)) {
            return { ok: false, error: 'fs.writeFile: запись разрешена только внутри папки плагина' }
          }
          mkdirSync(dirname(resolved), { recursive: true })
          const { writeFileSync } = await import('fs')
          writeFileSync(resolved, String(params.content ?? ''))
          return { ok: true }
        }
        case 'fs.listDir': {
          const p = String(params.path ?? '')
          if (!p) return { ok: false, error: 'fs.listDir: path обязателен' }
          if (!existsSync(p)) return { ok: false, error: 'fs.listDir: путь не найден' }
          return { ok: true, result: readdirSync(p) }
        }
        case 'config.get': {
          const key = String(params.key ?? '')
          const plugin = this.lastScan.find(pl => pl.id === pluginId)
          const values = this.getConfigValues(pluginId, plugin?.manifest.config)
          return { ok: true, result: values[key] }
        }
        case 'config.getAll': {
          const plugin = this.lastScan.find(pl => pl.id === pluginId)
          return { ok: true, result: this.getConfigValues(pluginId, plugin?.manifest.config) }
        }
        case 'ui.openPanel':
          this.panelAction(pluginId, 'open', String(params.panelId ?? ''))
          return { ok: true }
        case 'ui.closePanel':
          this.panelAction(pluginId, 'close', String(params.panelId ?? ''))
          return { ok: true }
        case 'ui.setBadge': {
          const badge = params.badge
          this.setPanelBadge(pluginId, String(params.panelId ?? ''), badge === null || badge === undefined ? null : Number(badge))
          return { ok: true }
        }
        case 'ui.getTheme':
          return { ok: true, result: this.getThemeInfo() }
        case 'chat.send':
          this.chatAction('send', String(params.text ?? ''), params.silent === true)
          return { ok: true }
        case 'chat.reply':
          this.chatAction('reply', String(params.text ?? ''))
          return { ok: true }
        case 'chats.list': {
          const chats = getAllChats().map(c => ({
            id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt,
          }))
          return { ok: true, result: chats }
        }
        case 'chats.get': {
          const chatId = String(params.chatId ?? '')
          if (!chatId) return { ok: false, error: 'chats.get: chatId обязателен' }
          const chat = getAllChats().find(c => c.id === chatId)
          if (!chat) return { ok: true, result: null }
          const messages = getMessages(chatId).map(m => ({
            id: m.id, role: m.role, content: m.content, createdAt: m.createdAt,
          }))
          return { ok: true, result: { chat, messages } }
        }
        case 'projects.list': {
          const projects = getAllProjects().map(p => ({ id: p.id, name: p.name, workdir: p.workdir }))
          return { ok: true, result: projects }
        }
        case 'memory.search':
          return { ok: true, result: searchMemories(String(params.query ?? '')) }
        case 'memory.save': {
          const key = String(params.key ?? '')
          if (!key) return { ok: false, error: 'memory.save: key обязателен' }
          saveMemory({ key, value: String(params.value ?? ''), category: 'facts', confidence: 0.6, source: `plugin:${pluginId}` })
          return { ok: true }
        }
        case 'window.toast':
          this.toast(String(params.text ?? ''), (params.kind as 'info' | 'success' | 'error') ?? 'info')
          return { ok: true }
        case 'window.dialog': {
          const buttons = (params.buttons as string[] | undefined) ?? ['OK']
          const res = await dialog.showMessageBox(this.win!, {
            type: 'info',
            title: String(params.title ?? 'Плагин'),
            message: String(params.body ?? ''),
            buttons,
            defaultId: 0,
            cancelId: buttons.length - 1,
          })
          return { ok: true, result: res.response }
        }
        default:
          return { ok: false, error: `Неизвестный hostRequest: ${method}` }
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  // ── Push в renderer ────────────────────────────────────────────────────

  private emitChanged(): void {
    this.win?.webContents.send(IPC_EVENTS.PLUGINS_CHANGED, {})
  }

  private pushLog(pluginId: string, run: RunningPlugin, level: PluginLogEntry['level'], message: string): void {
    run.logs.push({ ts: Date.now(), level, message })
    if (run.logs.length > LOG_CAP) run.logs.splice(0, run.logs.length - LOG_CAP)
    this.win?.webContents.send(IPC_EVENTS.PLUGINS_LOGS, { pluginId, logs: run.logs })
  }
}

/** Светлые темы (для PluginThemeInfo.dark). */
const LIGHT_THEMES = new Set(['light', 'paper', 'latte', 'sepia', 'dawn', 'mist', 'solarized'])

/** Парсит plugin__{pluginId}__{toolName}. */
export function parsePluginToolName(toolName: string): { pluginId: string; toolName: string } | null {
  if (!toolName.startsWith('plugin__')) return null
  const rest = toolName.slice(8)
  const sep = rest.indexOf('__')
  if (sep === -1) return null
  return { pluginId: rest.slice(0, sep), toolName: rest.slice(sep + 2) }
}

// ── Синглтон ─────────────────────────────────────────────────────────────

let pluginManagerInstance: PluginManager | null = null

export function initPluginManager(store: Store): PluginManager {
  pluginManagerInstance = new PluginManager(store)
  return pluginManagerInstance
}

export function getPluginManager(): PluginManager {
  if (!pluginManagerInstance) {
    throw new Error('PluginManager не инициализирован. Вызови initPluginManager() в main.')
  }
  return pluginManagerInstance
}
