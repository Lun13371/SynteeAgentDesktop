/**
 * pluginProcess — обёртка над utilityProcess одного плагина.
 *
 * Отвечает за:
 *   - spawn изолированного процесса (out/main/plugin-host.js)
 *   - RPC запрос/ответ с requestId и таймаутами
 *   - приём событий (registerTool, log, hostRequest) и колбэки в менеджер
 *   - graceful shutdown (deactivate → kill)
 *
 * Краш процесса плагина НЕ роняет приложение: onExit сообщает менеджеру,
 * тот помечает статус 'error'.
 */

import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'path'
import type {
  PluginMsgPluginToHost,
  PluginMsgHostToPlugin,
  PluginMsgInit,
  PluginMsgCallTool,
  PluginMsgCallCommand,
  PluginMsgShutdown,
  PluginMsgUiCall,
  PluginMsgHook,
} from './pluginProtocol'
import type {
  PluginLogEntry,
  PluginToolRuntime,
  PluginCommandRuntime,
  PluginUiContribution,
} from '../../shared/types'

/** Таймаут RPC-вызова в процесс плагина (init/callTool/callCommand/shutdown). */
const RPC_TIMEOUT_MS = 60_000
/** Таймаут на ожидание hostRequest-ответа плагину (fetch и т.п.). */
const HOST_REQUEST_TIMEOUT_MS = 60_000
/** Таймаут хука chat:before-send — не должен тормозить отправку сообщения. */
export const HOOK_TIMEOUT_MS = 2_000

interface Waiter {
  resolve: (v: { ok: boolean; output?: string; error?: string; result?: unknown }) => void
  timer: NodeJS.Timeout
}

export interface PluginProcessCallbacks {
  /** Тул зарегистрирован плагином. */
  onToolRegistered: (tool: PluginToolRuntime) => void
  /** Слэш-команда зарегистрирована плагином. */
  onCommandRegistered: (command: PluginCommandRuntime) => void
  /** UI-вклад зарегистрирован плагином. */
  onUiRegistered: (contribution: PluginUiContribution) => void
  /** Плагин отправил сообщение в свои iframe-панели. */
  onUiPostMessage: (data: unknown) => void
  /** Плагин подписался на события (список всех событий с хендлерами). */
  onEventsSubscribed: (events: string[]) => void
  /** Запись журнала. */
  onLog: (entry: PluginLogEntry) => void
  /** Процесс завершился (сам или по kill). */
  onExit: (code: number) => void
  /** Запрос плагина к host-API. Возвращает { ok, result?, error? }. */
  onHostRequest: (method: string, params: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>
}

export class PluginProcess {
  private child: UtilityProcess | null = null
  private waiters = new Map<string, Waiter>()
  private nextId = 0
  private exited = false

  constructor(
    private readonly pluginId: string,
    private readonly pluginDir: string,
    private readonly permissions: string[],
    private readonly callbacks: PluginProcessCallbacks,
  ) {}

  private get hostPath(): string {
    // Отдельная точка входа main-бандла (см. electron.vite.config.ts).
    return join(__dirname, 'plugin-host.js')
  }

  private rpcId(prefix: string): string {
    return `${prefix}-${++this.nextId}-${Date.now()}`
  }

  /** Спавнит процесс и активирует плагин. Бросает при ошибке активации. */
  async start(): Promise<void> {
    const child = utilityProcess.fork(this.hostPath, [], {
      serviceName: `plugin-${this.pluginId}`,
      stdio: 'pipe',
    })
    this.child = child

    child.on('message', (msg) => this.handleMessage(msg as PluginMsgPluginToHost))
    child.on('exit', (code) => {
      if (this.exited) return
      this.exited = true
      // Резолвим всех ждущих ошибкой.
      for (const [, w] of this.waiters) {
        clearTimeout(w.timer)
        w.resolve({ ok: false, error: `Процесс плагина завершился (code ${code})` })
      }
      this.waiters.clear()
      this.callbacks.onExit(code ?? 0)
    })

    const initResult = await this.request('init', {
      type: 'init',
      pluginDir: this.pluginDir,
      permissions: this.permissions,
      env: {
        platform: process.platform,
        appVersion: process.versions.electron,
        locale: process.env.LANG ?? 'en',
      },
    })
    if (!initResult.ok) {
      // initResult содержит error? — типизировано как { ok: false; error?: string }
      const err = (initResult as { error?: string }).error || 'Активация плагина не удалась'
      this.kill()
      throw new Error(err)
    }
  }

  /** Вызывает тул плагина. */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<{ ok: boolean; output?: string; error?: string }> {
    if (!this.child || this.exited) {
      return { ok: false, error: 'Процесс плагина не запущен' }
    }
    return this.request('callTool', { type: 'callTool', toolName, args })
  }

  /** Вызывает слэш-команду плагина. */
  async callCommand(commandName: string, args: string): Promise<{ ok: boolean; output?: string; error?: string }> {
    if (!this.child || this.exited) {
      return { ok: false, error: 'Процесс плагина не запущен' }
    }
    return this.request('callCommand', { type: 'callCommand', commandName, args })
  }

  /** Отправляет событие хоста (fire-and-forget). */
  sendEvent(event: string, payload: Record<string, unknown>): void {
    if (!this.child || this.exited) return
    try { this.child.postMessage({ type: 'event', event, payload }) } catch { /* dead */ }
  }

  /** Пересылает сообщение из iframe-панели в плагин (fire-and-forget). */
  sendUiMessage(data: unknown): void {
    if (!this.child || this.exited) return
    try { this.child.postMessage({ type: 'uiMessage', data }) } catch { /* dead */ }
  }

  /** RPC-вызов из iframe-панели (synteeBridge.call → ui.handle). */
  async uiCall(method: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    if (!this.child || this.exited) {
      return { ok: false, error: 'Процесс плагина не запущен' }
    }
    return this.request('uiCall', { type: 'uiCall', method, args })
  }

  /** Хук с ответом (chat:before-send). Возвращает { action, content? }. */
  async callHook(event: string, payload: Record<string, unknown>): Promise<{ action: 'allow' | 'modify' | 'reject'; content?: string; reason?: string }> {
    if (!this.child || this.exited) {
      return { action: 'allow' }
    }
    const r = await this.request('hook', { type: 'hook', event, payload }, HOOK_TIMEOUT_MS)
    const res = r as { ok?: boolean; result?: { action?: string; content?: string; error?: string }; error?: string }
    const out = res.result as { action?: 'allow' | 'modify' | 'reject'; content?: string; error?: string } | undefined
    if (out && (out.action === 'modify' || out.action === 'reject')) {
      return { action: out.action, content: out.content, reason: out.error }
    }
    return { action: 'allow' }
  }

  /** Graceful shutdown: deactivate() в плагине → kill. */
  async stop(): Promise<void> {
    if (!this.child || this.exited) return
    try {
      await this.request('shutdown', { type: 'shutdown' }, 5_000)
    } catch {
      /* плагин не ответил — просто киляем ниже */
    }
    this.kill()
  }

  /** Жёсткое завершение. */
  kill(): void {
    if (this.exited || !this.child) {
      this.exited = true
      return
    }
    this.exited = true
    try { this.child.kill() } catch { /* already dead */ }
  }

  get isRunning(): boolean {
    return !!this.child && !this.exited
  }

  // ── Внутреннее ──────────────────────────────────────────────────────────

  private request(
    kind: 'init' | 'callTool' | 'callCommand' | 'shutdown' | 'uiCall' | 'hook',
    msg: Omit<PluginMsgInit, 'requestId'> | Omit<PluginMsgCallTool, 'requestId'> | Omit<PluginMsgCallCommand, 'requestId'> | Omit<PluginMsgShutdown, 'requestId'> | Omit<PluginMsgUiCall, 'requestId'> | Omit<PluginMsgHook, 'requestId'>,
    timeoutMs = RPC_TIMEOUT_MS,
  ): Promise<{ ok: boolean; output?: string; error?: string; result?: unknown }> {
    return new Promise((resolve, reject) => {
      if (!this.child) {
        reject(new Error('Процесс плагина не запущен'))
        return
      }
      const requestId = this.rpcId(kind)
      const timer = setTimeout(() => {
        this.waiters.delete(requestId)
        if (kind === 'shutdown' || kind === 'hook') {
          // shutdown/hook не должны вешать вызывающего — резолвим «мягко».
          resolve(kind === 'hook'
            ? { ok: true, result: { action: 'allow' } }
            : { ok: false, error: 'timeout' })
        } else {
          reject(new Error(`Таймаут RPC (${kind}) для плагина ${this.pluginId}`))
        }
      }, timeoutMs)
      this.waiters.set(requestId, {
        resolve: (v) => resolve(v),
        timer,
      })
      this.child!.postMessage({ ...msg, requestId } as PluginMsgHostToPlugin)
    })
  }

  private handleMessage(msg: PluginMsgPluginToHost): void {
    switch (msg.type) {
      case 'initResult':
      case 'callToolResult':
      case 'callCommandResult': {
        const w = this.waiters.get(msg.requestId)
        if (w) {
          clearTimeout(w.timer)
          this.waiters.delete(msg.requestId)
          if (msg.type === 'initResult') {
            w.resolve({ ok: msg.ok, error: msg.error })
          } else {
            w.resolve({ ok: msg.ok, output: msg.output, error: msg.error })
          }
        }
        break
      }
      case 'shutdownResult': {
        const w = this.waiters.get(msg.requestId)
        if (w) {
          clearTimeout(w.timer)
          this.waiters.delete(msg.requestId)
          w.resolve({ ok: true })
        }
        break
      }
      case 'registerTool': {
        this.callbacks.onToolRegistered({
          pluginId: this.pluginId,
          name: `plugin__${this.pluginId}__${msg.name}`,
          shortName: msg.name,
          description: msg.description,
          inputSchema: msg.inputSchema ?? { type: 'object', properties: {} },
        })
        break
      }
      case 'registerCommand': {
        this.callbacks.onCommandRegistered({
          pluginId: this.pluginId,
          name: msg.name,
          description: msg.description,
          icon: msg.icon,
        })
        break
      }
      case 'registerUi': {
        this.callbacks.onUiRegistered({
          pluginId: this.pluginId,
          slot: msg.slot ?? 'sidebar',
          type: msg.uiType ?? 'button',
          label: msg.label,
          icon: msg.icon,
          command: msg.command,
          panelId: msg.panelId,
          entry: msg.entry,
        })
        break
      }
      case 'subscribeEvents': {
        this.callbacks.onEventsSubscribed(msg.events ?? [])
        break
      }
      case 'uiCallResult': {
        const w = this.waiters.get(msg.requestId)
        if (w) {
          clearTimeout(w.timer)
          this.waiters.delete(msg.requestId)
          w.resolve({ ok: msg.ok, result: msg.result, error: msg.error })
        }
        break
      }
      case 'hookResult': {
        const w = this.waiters.get(msg.requestId)
        if (w) {
          clearTimeout(w.timer)
          this.waiters.delete(msg.requestId)
          w.resolve({
            ok: msg.ok,
            result: { action: msg.action ?? 'allow', content: msg.content, error: msg.error },
            error: msg.error,
          })
        }
        break
      }
      case 'uiPostMessage': {
        this.callbacks.onUiPostMessage(msg.data)
        break
      }
      case 'log': {
        this.callbacks.onLog({
          ts: Date.now(),
          level: msg.level,
          message: msg.message,
        })
        break
      }
      case 'hostRequest': {
        // Таймаут-страховка: плагин ждёт ответа; если обработчик завис —
        // отвечаем ошибкой, чтобы промис в плагине не висел вечно.
        const timer = setTimeout(() => {
          this.child?.postMessage({
            type: 'hostResponse',
            requestId: msg.requestId,
            ok: false,
            error: `Таймаут hostRequest: ${msg.method}`,
          } satisfies PluginMsgHostToPlugin)
        }, HOST_REQUEST_TIMEOUT_MS)
        this.callbacks.onHostRequest(msg.method, msg.params)
          .then(resp => {
            clearTimeout(timer)
            this.child?.postMessage({
              type: 'hostResponse',
              requestId: msg.requestId,
              ok: resp.ok,
              result: resp.result,
              error: resp.error,
            } satisfies PluginMsgHostToPlugin)
          })
          .catch(e => {
            clearTimeout(timer)
            this.child?.postMessage({
              type: 'hostResponse',
              requestId: msg.requestId,
              ok: false,
              error: (e as Error).message,
            } satisfies PluginMsgHostToPlugin)
          })
        break
      }
    }
  }
}
