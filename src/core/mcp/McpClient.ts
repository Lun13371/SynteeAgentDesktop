/**
 * McpClient — обёртка над @modelcontextprotocol/sdk Client + транспорт.
 *
 * Поддерживает три транспорта:
 *   - stdio:           spawn локального процесса (command + args + env)
 *   - sse:             подключение к удалённому HTTP-SSE серверу (url + headers)
 *   - streamable-http: новый стандарт HTTP-транспорта (url + headers)
 *
 * Жизненный цикл:
 *   connect()    → создаёт транспорт + Client, handshake, listTools()
 *   disconnect() → закрывает транспорт, убивает процесс (stdio)
 *   callTool()   → вызывает тул по имени с аргументами
 *
 * Обработка ошибок: stderr процесса логируется, краш процесса →
 * McpClient помечается как error, McpManager может переподключить.
 *
 * SDK — ESM-only, но main собирается в CJS через electron-vite.
 * Поэтому используем require() с явным указанием .js subpath
 * (wildcard exports пакета требует .js для cjs-варианта).
 */

import type { Readable } from 'stream'
import type { McpServerConfig, McpToolRuntime, McpConnectionStatus, McpLogLevel, McpLogEntry } from '../../shared/types'
import { log } from '../logger'

// SDK импортируется лениво через require, чтобы:
//  1) не тащить ESM-парсер на статический анализ vite
//  2) работать в CJS-сборке main без ESM-маркеров
type McpSdkClient = {
  connect: (transport: unknown) => Promise<void>
  close: () => Promise<void>
  listTools: () => Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }>
  callTool: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<{ content?: Array<{ type: string; text?: string }> }>
}

interface TransportLike {
  start?: () => Promise<void>
  close?: () => Promise<void>
  onclose?: () => void
  onerror?: (err: Error) => void
  stderr?: Readable | null
}

export class McpClient {
  config: McpServerConfig
  private client: McpSdkClient | null = null
  private transport: TransportLike | null = null
  private _status: McpConnectionStatus = 'disconnected'
  private _error: string | undefined
  private _tools: McpToolRuntime[] = []
  /** Timestamp начала последней попытки подключения (для UI-таймера). */
  private _connectStartedAt: number | undefined
  /** Накопленный stderr процесса — для диагностики ошибок запуска. */
  private _stderrText = ''
  /** Журнал подключения (накопительно, cap MAX_LOGS). */
  private _logs: McpLogEntry[] = []
  /** Timestamp последнего onLogChange-флэша (троттлинг для не-критичных уровней). */
  private _lastLogFlushAt = 0
  /** Pending-флаг: addLog накопил записи, но флэш отложен из-за троттла. */
  private _logFlushPending = false
  /** Callbacks оповещают McpManager об изменениях статуса/тулов/логов. */
  onStatusChange?: (status: McpConnectionStatus, error?: string) => void
  onToolsChange?: (tools: McpToolRuntime[]) => void
  /** Дёргается (с троттлом) когда добавились записи журнала. */
  onLogChange?: () => void

  constructor(config: McpServerConfig) {
    this.config = config
  }

  get status(): McpConnectionStatus { return this._status }
  get error(): string | undefined { return this._error }
  get tools(): McpToolRuntime[] { return this._tools }
  get connectStartedAt(): number | undefined { return this._connectStartedAt }
  get stderrText(): string { return this._stderrText }
  get logs(): McpLogEntry[] { return this._logs }

  /** Макс. записей в журнале (FIFO); старые выкидываются при превышении. */
  private static readonly MAX_LOGS = 300
  /** Мин. интервал между onLogChange-флэшами для info/warn (мс). error/connected — мгновенно. */
  private static readonly LOG_FLUSH_THROTTLE_MS = 250

  /**
   * Добавляет запись в журнал подключения и оповещает UI (через onLogChange).
   * Журнал накопительный (видна история всех попыток) с cap MAX_LOGS.
   * Флэш onLogChange троттлится для info/warn, но срабатывает мгновенно для
   * error и при успешном подключении (это ключевые события для пользователя).
   */
  private addLog(level: McpLogLevel, message: string): void {
    const entry: McpLogEntry = { ts: Date.now(), level, message }
    this._logs.push(entry)
    // Удерживаем cap, выкидывая самые старые.
    if (this._logs.length > McpClient.MAX_LOGS) {
      this._logs = this._logs.slice(-McpClient.MAX_LOGS)
    }
    // Дублируем в файловый лог для отладки вне UI.
    const tag = level === 'error' ? '[MCP log][error]' : level === 'warn' ? '[MCP log][warn]' : '[MCP log]'
    log(tag, this.config.name, ':', message)
    this.maybeFlushLogChange(level)
  }

  /** Троттлинг оповещения UI о новых записях журнала. */
  private maybeFlushLogChange(level: McpLogLevel): void {
    if (!this.onLogChange) return
    // error — всегда мгновенно (пользователю важно сразу видеть провал).
    if (level === 'error') {
      this._lastLogFlushAt = Date.now()
      this._logFlushPending = false
      this.onLogChange()
      return
    }
    const now = Date.now()
    if (now - this._lastLogFlushAt >= McpClient.LOG_FLUSH_THROTTLE_MS) {
      this._lastLogFlushAt = now
      this._logFlushPending = false
      this.onLogChange()
      return
    }
    // Откладываем флэш — но только один pending-таймер, чтобы не плодить.
    if (!this._logFlushPending) {
      this._logFlushPending = true
      setTimeout(() => {
        if (!this._logFlushPending) return
        this._lastLogFlushAt = Date.now()
        this._logFlushPending = false
        this.onLogChange?.()
      }, McpClient.LOG_FLUSH_THROTTLE_MS)
    }
  }

  private setStatus(s: McpConnectionStatus, error?: string) {
    // Race condition fix: когда stdio-процесс падает, transport.onclose и
    // catch-блок connect() соревнуются. Если onclose стреляет ПОСЛЕ catch,
    // он перезаписывает 'error' → 'disconnected' (чищя error-сообщение) —
    // карточка мигает и ошибка исчезает. Не даём понизить статус.
    if (s === 'disconnected' && this._status === 'error') return
    this._status = s
    this._error = error
    if (s !== 'connecting') this._connectStartedAt = undefined
    this.onStatusChange?.(s, error)
  }

  /** Таймаут на одну попытку подключения (handshake + listTools).
   *  Без него зависший/медленный stdio-процесс (например холодный npx,
   *  который сначала скачивает пакет из npm — измерено ~8с даже с кэшем,
   *  первая установка без кэша может быть дольше) блокирует lazy-connect
   *  бесконечно, а вызывающий код (getActiveToolsForChat) ждёт его
   *  синхронно перед КАЖДЫМ chat:send — весь чат замирает. 240с — запас на
   *  холодную установку npm-пакета при первом запуске (npx -y скачивает
   *  пакет целиком, если его нет в кэше — на медленном соединении может
   *  занимать 2-3 минуты). Раньше было 60с — не хватало для некоторых
   *  серверов (Context7, большие пакеты). */
  private static readonly CONNECT_TIMEOUT_MS = 240_000

  /**
   * Подключается к серверу и получает список тулов.
   * Повторный вызов при уже активном подключении — no-op.
   */
  async connect(): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') return
    this._connectStartedAt = Date.now()
    this.setStatus('connecting')
    const transportDesc = this.config.transport === 'stdio'
      ? `stdio: ${this.config.command}${this.config.args?.length ? ' ' + this.config.args.join(' ') : ''}`
      : `${this.config.transport}: ${this.config.url ?? '(нет url)'}`
    this.addLog('info', `Начало подключения (${transportDesc})`)
    try {
      await Promise.race([
        this.doConnect(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Таймаут подключения (${McpClient.CONNECT_TIMEOUT_MS / 1000}с)`)), McpClient.CONNECT_TIMEOUT_MS),
        ),
      ])
      this.setStatus('connected')
      this.onToolsChange?.(this._tools)
      this.addLog('info', `Подключено успешно, тулов: ${this._tools.length}`)
      log('[MCP] connected:', this.config.name, 'tools:', this._tools.length)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('[MCP] connect error:', this.config.name, msg)
      this.addLog('error', `Ошибка подключения: ${msg}`)
      this.setStatus('error', msg)
      // Частичный клейнап
      try { await this.client?.close() } catch { /* ignore */ }
      this.client = null
      this.transport = null
    }
  }

  /** Собственно логика подключения — вынесена, чтобы обернуть в Promise.race с таймаутом. */
  private async doConnect(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('@modelcontextprotocol/sdk/client') as {
      Client: new (info: { name: string; version: string }, opts?: Record<string, unknown>) => McpSdkClient
    }
    const transport = this.buildTransport()
    this.transport = transport
    // clientInfo ОБЯЗАТЕЛЕН — серверы со строгой валидацией (Context7,
    // filesystem) отклоняют initialize- handshake если clientInfo undefined.
    this.client = new Client({ name: 'SynteeHelper', version: '1.0.0' })

    // Захват stderr: если транспорт поддерживает stderr-стрим (stdio),
    // читаем вывод процесса для диагностики ошибок запуска (npx не нашёл
    // пакет, конфликт версий, missing env и т.д.). Без этого единственная
    // ошибка которую видит пользователь — "Connection closed", что бесполезно.
    this._stderrText = ''
    if (transport?.stderr) {
      transport.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8')
        this._stderrText += text
        // Логируем построчно для отладки в консоли main-процесса и в UI-журнал.
        for (const line of text.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          log('[MCP stderr]', this.config.name, ':', trimmed)
          // stderr часто содержит предупреждения/диагностику процесса сервера —
          // показываем как warn (не error, т.к. сервер может работать нормально).
          this.addLog('warn', `stderr: ${trimmed}`)
        }
      })
    }

    // Подписываемся на обрывы транспорта
    if (transport) {
      transport.onclose = () => {
        log('[MCP] transport onclose:', this.config.name)
        this.addLog('warn', 'Транспорт закрыт (сервер отключился)')
        this.setStatus('disconnected')
        this._tools = []
        this.onToolsChange?.([])
      }
      transport.onerror = (err: Error) => {
        log('[MCP] transport onerror:', this.config.name, err.message)
        this.addLog('error', `Ошибка транспорта: ${err.message}`)
        this.setStatus('error', err.message)
      }
    }
    try {
      await this.client.connect(transport)
      const { tools } = await this.client.listTools()
      this._tools = tools.map(t => ({
        serverId: this.config.id,
        serverName: this.config.name,
        name: `mcp__${this.sanitizeName(this.config.name)}__${t.name}`,
        shortName: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      }))
    } catch (err) {
      // Если процесс упал и есть stderr — добавляем его к сообщению об ошибке,
      // чтобы пользователь видел реальную причину (а не "Connection closed").
      const sdkMsg = err instanceof Error ? err.message : String(err)
      const stderr = this._stderrText.trim()
      if (stderr) {
        // Берём последние ~500 символов stderr — там обычно самая полезная часть.
        const tail = stderr.slice(-500)
        throw new Error(`${sdkMsg}\n--- stderr ---\n${tail}`)
      }
      throw err
    }
  }

  /** Отключение и очистка. Безопасно вызывать многократно. */
  async disconnect(): Promise<void> {
    this.addLog('info', 'Отключение (по запросу)')
    try { await this.client?.close() } catch { /* ignore */ }
    this.client = null
    this.transport = null
    this._tools = []
    this.setStatus('disconnected')
    this.onToolsChange?.([])
  }

  /**
   * Вызов тулза. Возвращает текстовый результат (агент получает как output).
   * нетекстовые content-блоки сериализуются в строку.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<{ success: boolean; output: string; error?: string }> {
    if (!this.client || this._status !== 'connected') {
      const msg = `MCP-сервер ${this.config.name} не подключён (статус: ${this._status})`
      this.addLog('warn', `Вызов тула ${toolName} отклонён: сервер не подключён`)
      return { success: false, output: '', error: msg }
    }
    try {
      const result = await this.client.callTool({ name: toolName, arguments: args })
      const content = result.content ?? []
      const textParts = content
        .filter(c => c.type === 'text' && c.text)
        .map(c => c.text as string)
      const otherParts = content
        .filter(c => c.type !== 'text')
        .map(c => `[${c.type}]`)
      const output = [...textParts, ...otherParts].join('\n').slice(0, 8000)
      return { success: true, output: output || '(пустой результат)' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('[MCP] callTool error:', this.config.name, toolName, msg)
      this.addLog('error', `Ошибка вызова тула ${toolName}: ${msg}`)
      return { success: false, output: '', error: msg }
    }
  }

  /** Создаёт транспорт по конфигу. */
  private buildTransport(): TransportLike {
    if (this.config.transport === 'stdio') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js') as {
        StdioClientTransport: new (opts: {
          command: string
          args?: string[]
          env?: Record<string, string>
          stderr?: 'inherit' | 'pipe' | 'overlapped'
          cwd?: string
        }) => TransportLike
      }
      if (!this.config.command) {
        throw new Error('stdio-сервер требует поле command')
      }
      return new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        env: this.config.env ? { ...process.env, ...this.config.env } as Record<string, string> : undefined,
        stderr: 'pipe',
      })
    }
    if (this.config.transport === 'sse') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js') as {
        SSEClientTransport: new (url: URL, opts?: { requestInit?: { headers?: Record<string, string> } }) => TransportLike
      }
      if (!this.config.url) {
        throw new Error('sse-сервер требует поле url')
      }
      return new SSEClientTransport(new URL(this.config.url), {
        requestInit: this.config.headers ? { headers: this.config.headers } : undefined,
      })
    }
    if (this.config.transport === 'streamable-http') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js') as {
        StreamableHTTPClientTransport: new (url: URL, opts?: { requestInit?: { headers?: Record<string, string> } }) => TransportLike
      }
      if (!this.config.url) {
        throw new Error('streamable-http-сервер требует поле url')
      }
      return new StreamableHTTPClientTransport(new URL(this.config.url), {
        requestInit: this.config.headers ? { headers: this.config.headers } : undefined,
      })
    }
    throw new Error(`Неизвестный транспорт: ${this.config.transport}`)
  }

  /** Преобразует имя сервера в безопасный идентификатор для имени тула. */
  private sanitizeName(name: string): string {
    return name.replace(/[^A-Za-z0-9_]/g, '_')
  }
}
