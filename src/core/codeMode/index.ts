import { getQuickJS, type QuickJSDeferredPromise, type QuickJSHandle } from 'quickjs-emscripten'
import ts from 'typescript'

export interface CodeToolResult { success: boolean; output: string; error?: string; [key: string]: unknown }
export interface CodeTraceEntry {
  /** Стабильный id записи. Живой трейс приходит дважды — сначала со
   *  status:'running' (вызов начался), потом финальный статус. Renderer
   *  апсертит запись по id, поэтому строки не дублируются. */
  id?: string
  name: string
  args: unknown
  result: string
  status: 'success' | 'failure' | 'running'
  /** unified diff для правок/записи файлов — в ленте вызова он и есть «вывод». */
  diff?: string
}
export interface ArtifactStore {
  save(chatId: string, value: unknown): string
  load(chatId: string, id: string): unknown | undefined
  list(chatId: string): Array<{ id: string; size: number; createdAt: number }>
  delete(chatId: string, id: string): boolean
}
export interface ExecuteCodeOptions {
  code: string
  chatId?: string
  signal?: AbortSignal
  callTool: (name: string, args: unknown, signal?: AbortSignal) => Promise<CodeToolResult> | CodeToolResult
  onTrace?: (entry: CodeTraceEntry) => unknown
  artifacts?: ArtifactStore
  timeoutMs?: number
  /** Wall-clock budget outside MCP requests. */
  wallTimeoutMs?: number
  /** Extra wall time available while an MCP request is outstanding. */
  mcpWaitBudgetMs?: number
  sanitizeTrace?: (value: unknown) => unknown
}
export interface ExecuteCodeResult extends CodeToolResult { trace?: CodeTraceEntry[] }

export const CODE_MODE_LIMITS = Object.freeze({ codeChars: 40_000, outputChars: 40_000, bridgeJsonChars: 100_000, toolCalls: 120, parallelCalls: 8, timeoutMs: 30_000, wallTimeoutMs: 120_000, memoryBytes: 48 * 1024 * 1024, traceEntries: 60 })
const MCP_WAIT_BUDGET_MS = 4 * 60 * 60 * 1000
const FORBIDDEN = new Set(['execute_code', 'executeCode', 'code_mode', 'codeMode'])
const errText = (e: unknown): string => e instanceof Error ? e.message : String(e)

export class EphemeralArtifactStore implements ArtifactStore {
  private records = new Map<string, { chatId: string; value: string; size: number; createdAt: number; expiresAt: number }>()
  private readonly options: { ttlMs?: number; perChatBytes?: number; globalBytes?: number; maxItems?: number }
  constructor(options: { ttlMs?: number; perChatBytes?: number; globalBytes?: number; maxItems?: number } = {}) { this.options = options }
  private cleanup(now = Date.now()): void { for (const [id, row] of this.records) if (row.expiresAt <= now) this.records.delete(id) }
  private used(chatId?: string): number { let n = 0; for (const r of this.records.values()) if (!chatId || r.chatId === chatId) n += r.size; return n }
  save(chatId: string, value: unknown): string {
    if (!chatId) throw new Error('Artifacts require a chatId')
    this.cleanup()
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('Artifact must be JSON serializable')
    const size = Buffer.byteLength(encoded, 'utf8')
    const per = this.options.perChatBytes ?? 5 * 1024 * 1024, global = this.options.globalBytes ?? 50 * 1024 * 1024
    if (size > per || this.used(chatId) + size > per || this.used() + size > global) throw new Error('Artifact quota exceeded')
    const max = this.options.maxItems ?? 1000
    if (this.records.size >= max) { const oldest = [...this.records.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]; if (oldest) this.records.delete(oldest[0]) }
    const id = `art_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`
    const ttl = this.options.ttlMs ?? 60 * 60 * 1000
    this.records.set(id, { chatId, value: encoded, size, createdAt: Date.now(), expiresAt: Date.now() + ttl })
    return id
  }
  load(chatId: string, id: string): unknown | undefined { this.cleanup(); const r = this.records.get(id); if (!r || r.chatId !== chatId) return undefined; return JSON.parse(r.value) }
  list(chatId: string): Array<{ id: string; size: number; createdAt: number }> { this.cleanup(); return [...this.records].filter(([, r]) => r.chatId === chatId).map(([id, r]) => ({ id, size: r.size, createdAt: r.createdAt })) }
  delete(chatId: string, id: string): boolean { this.cleanup(); const r = this.records.get(id); return !!r && r.chatId === chatId && this.records.delete(id) }
}

function jsonBounded(value: unknown, limit = CODE_MODE_LIMITS.bridgeJsonChars): string {
  const s = JSON.stringify(value)
  if (s === undefined) throw new Error('Value is not JSON serializable')
  if (Buffer.byteLength(s, 'utf8') > limit) throw new Error('Bridge JSON size limit exceeded')
  return s
}
// Guest bridge serializes arguments before crossing the WASM boundary.

export async function executeCode(options: ExecuteCodeOptions): Promise<ExecuteCodeResult> {
  const { code } = options
  const externalSignal = options.signal
  const trace: CodeTraceEntry[] = []
  const fail = (error: string): ExecuteCodeResult => ({ success: false, output: '', error, ...(trace.length ? { trace } : {}) })
  if (typeof code !== 'string' || code.length > CODE_MODE_LIMITS.codeChars) return fail('Code exceeds 40,000 character limit')
  if (externalSignal?.aborted) return fail('Execution aborted')
  const transpiled = ts.transpileModule(`async function __user_main__(){\n${code}\n}\n__user_main__()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None, strict: true, noEmitOnError: true },
    reportDiagnostics: true
  })
  const fatal = (transpiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error)
  if (fatal.length) return fail(`TypeScript compile error: ${fatal.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ')}`)
  const module = await getQuickJS()
  if (externalSignal?.aborted) return fail('Execution aborted')
  const now = () => performance.now()
  const startedAt = now()
  const guestBudgetMs = Math.max(1, options.timeoutMs ?? CODE_MODE_LIMITS.timeoutMs)
  const baseWallBudgetMs = Math.max(1, options.wallTimeoutMs ?? CODE_MODE_LIMITS.wallTimeoutMs)
  const maxMcpWaitMs = options.mcpWaitBudgetMs ?? MCP_WAIT_BUDGET_MS
  const executionController = new AbortController()
  let wake: (() => void) | undefined
  const forwardAbort = (): void => { executionController.abort(); wake?.() }
  externalSignal?.addEventListener('abort', forwardAbort, { once: true })
  const signal = executionController.signal
  const maxCalls = CODE_MODE_LIMITS.toolCalls
  let calls = 0, inFlight = 0
  let active = true
  let guestDeadline = Infinity
  let guestTimeLeft = guestBudgetMs
  let mcpWaitMs = 0
  let mcpSince = 0
  let mcpInFlight = 0
  let bridgeError: string | undefined
  const wallTimeLeft = (time: number): number => startedAt + baseWallBudgetMs
    + Math.min(maxMcpWaitMs, mcpWaitMs + (mcpInFlight ? time - mcpSince : 0)) - time
  const executionError = (): string | undefined => {
    if (externalSignal?.aborted) return 'Execution aborted'
    const time = now()
    if (wallTimeLeft(time) <= 0) return 'Execution exceeded its wall-clock limit'
    if (time >= guestDeadline || guestTimeLeft <= 0) return 'Execution timed out'
    return undefined
  }
  const runGuest = <T>(run: () => T): T => {
    const start = now()
    guestDeadline = start + guestTimeLeft
    try { return run() }
    finally { guestTimeLeft -= now() - start; guestDeadline = Infinity }
  }
  const deferreds = new Set<QuickJSDeferredPromise>()
  // emitTrace — только отдать запись наверх (UI), не трогая итоговый массив;
  // pushTrace — добавить в итоговый trace и сразу же отдать наверх.
  const emitTrace = (entry: CodeTraceEntry): void => {
    try { options.onTrace?.(entry) } catch { /* instrumentation must not break execution */ }
  }
  const pushTrace = (entry: CodeTraceEntry): void => {
    if (trace.length < CODE_MODE_LIMITS.traceEntries) trace.push(entry)
    emitTrace(entry)
  }
  const runtime = module.newRuntime()
  runtime.setMemoryLimit(CODE_MODE_LIMITS.memoryBytes)
  runtime.setMaxStackSize(512 * 1024)
  runtime.setInterruptHandler(() => !!executionError())
  const ctx = runtime.newContext()
  let promise: QuickJSHandle | undefined
  try {
    const bridge = ctx.newFunction('__bridge', (nameHandle, argsHandle) => {
      const name = ctx.getString(nameHandle)
      let args: unknown
      try { args = JSON.parse(ctx.getString(argsHandle)) } catch { return ctx.newString(JSON.stringify({ success: false, output: '', error: 'Invalid bridge arguments' })) }
      let error: string | undefined
      try { jsonBounded(args) } catch (e) { error = errText(e) }
      if (!error && FORBIDDEN.has(name)) error = 'Recursive Code Mode execution is denied'
      const artifactOp = name.startsWith('__artifact_')
      if (!error && artifactOp && !options.chatId) error = 'Artifacts require a chatId'
      if (!error && artifactOp && !options.artifacts) error = 'Artifact store is not configured'
      if (!error && !artifactOp && (calls >= maxCalls)) error = 'Tool call limit exceeded'
      if (!error && inFlight >= CODE_MODE_LIMITS.parallelCalls) error = 'Parallel tool call limit exceeded'
      if (error) return ctx.newString(JSON.stringify({ success: false, output: '', error }))
      if (!artifactOp) calls++
      inFlight++
      const deferred = ctx.newPromise()
      deferreds.add(deferred)
      // Живой трейс: запись появляется в карточке СРАЗУ — до ответа тула
      // (status 'running'), и обновляется на месте по завершении. Раньше
      // вложенные вызовы становились видны только после конца скрипта.
      const traceEntry: CodeTraceEntry = {
        id: `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        name,
        args: options.sanitizeTrace ? options.sanitizeTrace(args) : args,
        result: '',
        status: 'running',
      }
      pushTrace(traceEntry)
      const settle = (value: CodeToolResult, status: 'success' | 'failure'): void => {
        if (!active) return
        const bounded = { success: !!value.success, output: String(value.output ?? '').slice(0, CODE_MODE_LIMITS.outputChars), ...(value.error ? { error: String(value.error).slice(0, CODE_MODE_LIMITS.outputChars) } : {}) }
        // Preserve failure details in the UI trace. Many tools return an empty
        // output plus an error field; recording only output made those calls
        // look like successful calls with no content.
        const traceResult = bounded.output || bounded.error || ''
        // Дифф правил не входит в текстовый output тула, но именно он — вывод
        // edit_file/write_file. Прокидываем в трейс, иначе карточка правки
        // внутри скрипта оставалась пустой (только плашка файла).
        const traceDiff = typeof value.diff === 'string' && value.diff ? value.diff.slice(0, 8_000) : undefined
        traceEntry.result = traceResult.slice(0, 1000)
        traceEntry.status = status
        if (traceDiff) traceEntry.diff = traceDiff
        emitTrace(traceEntry)
        const text = JSON.stringify(bounded)
        const response = Buffer.byteLength(text, 'utf8') > CODE_MODE_LIMITS.bridgeJsonChars
          ? JSON.stringify({ success: false, output: '', error: 'Tool result exceeds bridge size limit' }) : text
        ctx.newString(response).consume(deferred.resolve)
      }
      const isMcp = name.startsWith('mcp__')
      if (isMcp && mcpInFlight++ === 0) mcpSince = now()
      const task = Promise.resolve().then(async () => {
        if (!active || signal.aborted) return
        let result: CodeToolResult
        if (artifactOp) {
          const store = options.artifacts!
          const payload = args as { id?: string }
          if (name === '__artifact_save') result = { success: true, output: store.save(options.chatId!, args) }
          else if (name === '__artifact_load') { const value = store.load(options.chatId!, payload.id ?? ''); result = value === undefined ? { success: false, output: '', error: 'Artifact not found' } : { success: true, output: JSON.stringify(value) } }
          else if (name === '__artifact_list') result = { success: true, output: JSON.stringify(store.list(options.chatId!)) }
          else { const removed = store.delete(options.chatId!, payload.id ?? ''); result = { success: removed, output: String(removed) } }
        } else {
          result = await options.callTool(name, args, signal)
        }
        settle(result, result?.success ? 'success' : 'failure')
      })
      void task.catch(e => settle({ success: false, output: '', error: errText(e) }, 'failure')).finally(() => {
        if (isMcp && --mcpInFlight === 0) mcpWaitMs += now() - mcpSince
        inFlight--
        if (deferreds.delete(deferred)) deferred.dispose()
        wake?.()
      }).catch(error => {
        bridgeError = errText(error)
        wake?.()
      })
      return deferred.handle
    })
    ctx.setProp(ctx.global, '__bridge', bridge)
    bridge.dispose()
    const bootstrap = `
      const bridge = (name, args) => Promise.resolve(__bridge(name, JSON.stringify(args ?? null))).then(JSON.parse);
      globalThis.tools = new Proxy(Object.create(null), { get: (_, name) => name === 'call' ? (n,a) => bridge(String(n), a) : (a) => bridge(String(name), a) });
      globalThis.artifacts = Object.freeze({
        save: async (value) => { const r = await bridge('__artifact_save', value); if (!r.success) throw Error(r.error); return r.output; },
        load: async (id) => { const r = await bridge('__artifact_load', {id}); if (!r.success) throw Error(r.error); return JSON.parse(r.output); },
        list: async () => { const r = await bridge('__artifact_list', null); if (!r.success) throw Error(r.error); return JSON.parse(r.output); },
        delete: async (id) => { const r = await bridge('__artifact_delete', {id}); if (!r.success) throw Error(r.error); return r.output === 'true'; }
      });
      globalThis.console = Object.freeze({ log: (...args) => globalThis.__logs.push(args.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')) });
      globalThis.__logs = [];
      globalThis.global = undefined; globalThis.process = undefined; globalThis.require = undefined; globalThis.module = undefined; globalThis.Buffer = undefined; globalThis.fetch = undefined; globalThis.XMLHttpRequest = undefined; globalThis.WebSocket = undefined;
    `
    const init = ctx.evalCode(bootstrap)
    if (init.error) { const text = ctx.dump(init.error); init.error.dispose(); return fail(String(text)) }
    init.value.dispose()
    const result = runGuest(() => ctx.evalCode(transpiled.outputText, 'code-mode.ts'))
    if (result.error) { const text = ctx.dump(result.error); result.error.dispose(); return fail(executionError() ?? String(text)) }
    promise = result.value
    while (true) {
      const executionFailure = executionError() ?? bridgeError
      if (executionFailure) return fail(executionFailure)
      const state = ctx.getPromiseState(promise)
      if (state.type === 'fulfilled') {
        const output = ctx.dump(state.value)
        if (state.value !== promise) state.value.dispose()
        const logsHandle = ctx.getProp(ctx.global, '__logs')
        const logs = ctx.dump(logsHandle); logsHandle.dispose()
        const text = [Array.isArray(logs) ? logs.join('\n') : '', output === undefined ? '' : typeof output === 'string' ? output : JSON.stringify(output)].filter(Boolean).join('\n')
        return { success: true, output: text.slice(0, CODE_MODE_LIMITS.outputChars), ...(trace.length ? { trace } : {}) }
      }
      if (state.type === 'rejected') { const message = ctx.dump(state.error); state.error.dispose(); return fail(errText(message)) }
      const jobs = runGuest(() => runtime.executePendingJobs())
      if (jobs.error) { const message = ctx.dump(jobs.error); jobs.error.dispose(); return fail(executionError() ?? errText(message)) }
      if (jobs.value) continue
      // Wake on a tool result, Stop, or the deadline. No polling while a server works.
      const time = now()
      const waitMs = wallTimeLeft(time) + (mcpInFlight > 0 ? Math.max(0, maxMcpWaitMs - mcpWaitMs - (time - mcpSince)) : 0)
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => wake?.(), Math.max(1, waitMs))
        wake = () => { clearTimeout(timer); wake = undefined; resolve() }
      })
    }
  } catch (e) {
    return fail(executionError() ?? errText(e))
  } finally {
    active = false
    // Незавершённые вызовы (Stop, ошибка скрипта, дедлайн) не должны навсегда
    // остаться «выполняется» в карточке — закрываем их как прерванные.
    for (const entry of trace) {
      if (entry.status !== 'running') continue
      entry.status = 'failure'
      if (!entry.result) entry.result = 'Вызов не завершён'
      emitTrace(entry)
    }
    executionController.abort()
    externalSignal?.removeEventListener('abort', forwardAbort)
    promise?.dispose()
    for (const d of deferreds) { try { d.dispose() } catch { /* pending promises are reclaimed with the isolated runtime */ } }
    deferreds.clear()
    try { ctx.dispose() } catch { /* WASM teardown must not mask execution result */ }
    try { runtime.dispose() } catch { /* abort may leave inaccessible guest jobs; module is isolated */ }
  }
}
