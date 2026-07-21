/**
 * AI Worker Thread — весь AI/Agent код здесь.
 * При worker.terminate() все соединения рвутся мгновенно OS-ом.
 * Сохранение происходит в main thread через сообщение 'done'.
 */
import { parentPort, workerData } from 'worker_threads'
import { AIClient } from '../core/ai/AIClient'
import { Agent } from '../core/agent/Agent'
import { classifyTool } from '../core/agent/commandSafety'
import { writeFile, editFile, multiEditFile } from '../core/tools/index'
import { buildPlanningInjection } from '../core/prompts/buildSystemPrompt'
import { estimateTokens, getModelContextWindow, TOOL_SCHEMAS_OVERHEAD } from '../core/context/contextManager'
import { recordSessionCost, buildSnapshotFromReal } from '../core/tokens/usageTracker'
import { initModelCatalog } from '../core/tokens/modelCatalog'
import { getToolSchemas } from '../core/tools/index'

const storeData: Record<string, unknown> = workerData.storeData
const planningMode: boolean = !!(workerData as Record<string, unknown>).planningMode
const workerMode: 'code' | 'work' = ((workerData as Record<string, unknown>).mode as 'code' | 'work') ?? 'code'

// Инициализируем каталог моделей из кэш-файла (записанного main-процессом)
const catalogCachePath = (workerData as Record<string, unknown>).catalogCachePath as string | undefined
if (catalogCachePath) {
  try { initModelCatalog(catalogCachePath) } catch { /* ok — работаем без каталога */ }
}

// Кэш статусов суб-агентов — обновляется через agent_status_update от main
const agentStatusCache = new Map<string, { status: string; stepsCount: number; currentStep?: string }>()

// Единый реестр одноразовых reply-handlers (replyId → resolver)
const replyHandlers = new Map<string, (msg: Record<string, unknown>) => void>()

// Флаг — агент уже запущен (стартовое сообщение обработано)
let agentStarted = false

// set() мутирует локальную копию storeData — иначе API key round-robin
// (AIClient.getClientForRole -> getNextApiKey -> store.set('providers', ...))
// был no-op, и агент всегда брал один и тот же ключ провайдера на каждом
// шаге, даже если пользователь настроил несколько ключей для балансировки.
// Изменение не переживает воркер (не пишется в electron-store в main), но
// хотя бы работает корректно внутри одного запуска агента.
const fakeStore = {
  get: (key: string, def?: unknown) => (storeData[key] !== undefined ? storeData[key] : def),
  set: (key: string, val: unknown) => { storeData[key] = val },
} as never

const aiClient = new AIClient(fakeStore)

function send(msg: Record<string, unknown>) {
  parentPort?.postMessage(msg)
}

// ЕДИНЫЙ handler — все входящие сообщения через один on('message')
parentPort?.on('message', async (msg: Record<string, unknown>) => {
  // --- Reply от main (spawn_agent_reply, get_agent_status_reply) ---
  if (msg.replyId) {
    const handler = replyHandlers.get(msg.replyId as string)
    if (handler) {
      replyHandlers.delete(msg.replyId as string)
      handler(msg)
    }
    return
  }

  // --- Обновление статуса суб-агента ---
  if (msg.type === 'agent_status_update' && msg.agentId) {
    agentStatusCache.set(msg.agentId as string, msg.statusData as never)
    return
  }

  // --- Стартовое сообщение — запуск агента (только один раз) ---
  if (agentStarted) return
  agentStarted = true

  const {
    chatId, msgId, content, history,
    systemPrompt, enableTools, incognito,
    agentSettings,
    toolSchemas,
    modelId: resolvedModelId,
    providerId: resolvedProviderId,
  } = msg as {
    chatId: string
    msgId: string
    content: string
    history: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }>
    systemPrompt: string
    enableTools: boolean
    incognito: boolean
    toolSchemas?: unknown[]
    modelId?: string
    providerId?: string
    agentSettings: {
      enableTools: boolean
      maxSteps: number
      approvalMode: string
      toolOutputMode: string
      enableThinking: boolean
      autoMemoryInterval?: number
      readFileCache?: boolean
      maxRepeatedToolCalls?: number
      maxRepeatedErrors?: number
    }
  }

  let fullText = ''
  let thinkingText = ''
  let thinkingStartMs = 0
  let thinkingMs: number | undefined
  const collectedSteps: unknown[] = []

  // Итерации для сохранения в БД — {label?, textBefore, thinking?, thinkingMs?, steps[]}
  const collectedIters: Array<{ label?: string; textBefore: string; thinking?: string; thinkingMs?: number; steps: unknown[] }> = []
  let currentIterTextBefore = ''
  let currentIterSteps: unknown[] = []
  let pendingTextAfter = ''  // текст после последнего тулчейна

  // Thinking для текущей итерации — прикрепляется к итерации при flush
  let currentIterThinking = ''
  let currentIterThinkingMs: number | undefined

  // Pending thinking — накопленное reasoning текущего раунда, ждёт прикрепления к итерации
  let pendingThinking = ''
  let pendingThinkingMs: number | undefined

  // Live token counter — считаем накопленный контекст агента
  const isSubAgentWorker = !!(workerData as Record<string, unknown>).isSubAgent
  const contextWindow = getModelContextWindow(storeData, isSubAgentWorker ? 'subagent' : 'main')
  const sysPromptTokens = estimateTokens(systemPrompt) + 4
  // Токены истории (начальный снапшот)
  const historyBaseTokens = history.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0)
  let toolResultTokensAccum = 0  // накопленные токены tool results за сессию

  // Последний breakdown для мерджа с реальным usage
  let lastBreakdown: Record<string, number> | undefined

  function sendLiveContextUsage() {
    const estimated = historyBaseTokens + sysPromptTokens + TOOL_SCHEMAS_OVERHEAD + toolResultTokensAccum + estimateTokens(fullText) + 100
    const pct = Math.min(100, Math.round(estimated / contextWindow * 100))
    const status = pct >= 85 ? 'critical' : pct >= 60 ? 'warn' : 'ok'
    const breakdown = {
      history: historyBaseTokens,
      system: sysPromptTokens,
      tools: TOOL_SCHEMAS_OVERHEAD,
      toolResults: toolResultTokensAccum,
      answer: estimateTokens(fullText),
    }
    lastBreakdown = breakdown
    send({
      type: 'context_usage',
      pct, estimated, limit: contextWindow, status,
      source: 'estimate',
      breakdown,
    })
  }

  const flushIter = () => {
    if (currentIterSteps.length > 0) {
      collectedIters.push({
        textBefore: currentIterTextBefore,
        thinking: currentIterThinking || undefined,
        thinkingMs: currentIterThinkingMs,
        steps: currentIterSteps,
      })
      currentIterTextBefore = ''
      currentIterSteps = []
      currentIterThinking = ''
      currentIterThinkingMs = undefined
    }
  }

  let agent: Agent | null = null

  const finalize = (details?: unknown) => {
    flushIter()
    // Если после последней итерации остался thinking или текст — создаём финальную итерацию
    if (collectedIters.length > 0 && (pendingThinking || pendingTextAfter.trim())) {
      collectedIters.push({
        textBefore: pendingTextAfter,
        thinking: pendingThinking || undefined,
        thinkingMs: pendingThinkingMs,
        steps: [],
      })
      pendingThinking = ''
      pendingTextAfter = ''
    }
    const fileCacheUpdates = agent ? agent.getFileCacheUpdates() : undefined
    send({
      type: 'done',
      chatId, msgId,
      fullText,
      thinkingText: thinkingText || undefined,
      thinkingMs,
      collectedSteps,
      collectedIters: collectedIters.length > 0 ? collectedIters : undefined,
      // Round-robin индекс мутировался в этой копии storeData (см. fakeStore.set)
      // — прокидываем обновлённых providers обратно в main, чтобы ротация
      // ключей продолжалась со следующего сообщения, а не сбрасывалась.
      updatedProviders: storeData.providers,
      // Персистентный кэш файлов — обновлённые записи для main-процесса
      fileCacheUpdates,
      // Структурированный результат агента (файлы, diff-и, команды) — для суб-агентов
      agentSummary: details,
      incognito,
      content,
    })
  }

  try {
    if (enableTools && !incognito) {
      const isSubAgent = !!(workerData as Record<string, unknown>).isSubAgent
      agent = new Agent(fakeStore, isSubAgent ? 'subagent' : 'main')

      // Прокидываем chatId и колбэки рабочей памяти
      agent.chatId = chatId
      // workdir чата (новые Code-чаты после фичи workdir; undefined для
      // Work-режима и старых чатов — поведение остаётся прежним).
      agent.workdir = (workerData as Record<string, unknown>).workdir as string | undefined
      agent.verificationCommand = (workerData as Record<string, unknown>).verificationCommand as string | undefined
      agent.onUpdateWorkingMemory = (cid, content, mode) => {
        console.log('[ai-worker] update_working_memory:', cid, mode, content.length, 'chars')
        send({ type: 'update_working_memory', chatId: cid, content, mode })
      }
      agent.onGetWorkingMemory = (cid) => {
        // Синхронно читаем из БД — getWorkingMemory импортирован в main thread
        // В воркере нет прямого доступа к БД — используем кэш из workerData
        const wm = (workerData as Record<string, unknown>).workingMemory as string | undefined
        console.log('[ai-worker] getWorkingMemory:', cid, '->', wm?.length ?? 0, 'chars')
        return wm ?? ''
      }

      await agent.run(
        content,
        {
          onContextCounted: (promptTokens) => {            const pct = Math.min(100, Math.round(promptTokens / contextWindow * 100))
            const status = pct >= 85 ? 'critical' : pct >= 60 ? 'warn' : 'ok'
            const breakdown = { history: promptTokens, system: 0, tools: 3800, current: 0 }
            lastBreakdown = breakdown
            send({
              type: 'context_usage',
              pct, estimated: promptTokens, limit: contextWindow, status,
              source: 'estimate',
              breakdown,
            })
          },
          onStep: (step) => {
            // Скрытые тулы (think, update_working_memory) — не шлём в UI
            if (step.hidden) {
              return
            }
            if (step.type === 'tool_call_pending') {
              // Ранний сигнал "модель начала вызывать тул X" — ЕЩЁ до того как
              // JSON аргументов полностью собран. Не пишем в collectedSteps —
              // это временное отображение, которое renderer заменит на
              // настоящий tool_call (см. pendingCallId матчинг в ChatPage.tsx).
              // Не персистится в БД само по себе.
              send({ type: 'step', chatId, msgId, step })
              return
            }
            if (step.type === 'tool_call') {
              const ts = {
                id: `${Date.now()}-${Math.random()}`,
                type: step.type,
                toolName: step.toolName,
                toolArgs: step.toolArgs,
                content: step.content,
                success: step.success,
                timestamp: Date.now(),
                imageUrl: step.imageUrl,
                callId: step.callId,
                pendingCallId: step.pendingCallId,
              }
              collectedSteps.push(ts)
              if (pendingTextAfter.trim() || pendingThinking) {
                flushIter()
                currentIterTextBefore = pendingTextAfter
                currentIterThinking = pendingThinking
                currentIterThinkingMs = pendingThinkingMs
                pendingTextAfter = ''
                pendingThinking = ''
                pendingThinkingMs = undefined
              } else if (currentIterSteps.length === 0) {
                currentIterTextBefore = pendingTextAfter
                pendingTextAfter = ''
              }
              currentIterSteps.push(ts)
              send({ type: 'step', chatId, msgId, step })
            } else if (step.type === 'tool_result') {
              const ts = {
                id: `${Date.now()}-${Math.random()}`,
                type: step.type,
                toolName: step.toolName,
                toolArgs: step.toolArgs,
                content: step.content,
                success: step.success,
                timestamp: Date.now(),
                imageUrl: step.imageUrl,
                diff: (step as { diff?: string }).diff,
                callId: step.callId,
              }
              collectedSteps.push(ts)
              currentIterSteps.push(ts)
              send({ type: 'step', chatId, msgId, step })

              // Live обновление token counter после каждого tool result
              const resultTokens = estimateTokens(step.content || '') + 4
              toolResultTokensAccum += resultTokens
              sendLiveContextUsage()

            } else if (step.type === 'thought') {
              // Fallback — reasoning не стримился, пришёл одним блоком
              if (!thinkingStartMs) thinkingStartMs = Date.now()
              const thoughtStr = typeof step.content === 'string' ? step.content : String(step.content ?? '')
              thinkingText += thoughtStr
              pendingThinking += thoughtStr
              thinkingMs = Date.now() - thinkingStartMs
              pendingThinkingMs = thinkingMs
              send({ type: 'thinking_token', chatId, msgId, token: thoughtStr })
              send({ type: 'thinking_done', chatId, msgId, thinkingMs })
            } else if (step.type === 'answer') {
              fullText += step.content
              pendingTextAfter += step.content
              send({ type: 'token', chatId, msgId, token: step.content })
            }
          },
          onDone: (_answer: string, details?: unknown) => finalize(details),
          onError: (err) => {
            flushIter()
            send({
              type: 'error', chatId, error: err.message,
              fullText, thinkingText: thinkingText || undefined, thinkingMs,
              collectedSteps, collectedIters: collectedIters.length > 0 ? collectedIters : undefined,
              updatedProviders: storeData.providers,
              fileCacheUpdates: agent?.getFileCacheUpdates(),
            })
          },
          onContextUpdate: (tokens: number) => {
            const pct = Math.min(100, Math.round(tokens / contextWindow * 100))
            const status = pct >= 85 ? 'critical' : pct >= 60 ? 'warn' : 'ok'
            const breakdown = { history: historyBaseTokens, system: sysPromptTokens, tools: 3800, current: tokens - historyBaseTokens - sysPromptTokens - 3800 }
            lastBreakdown = breakdown
            send({
              type: 'context_usage',
              pct, estimated: tokens, limit: contextWindow, status,
              source: 'estimate',
              breakdown,
            })
          },
          onUsage: (promptTokens: number, completionTokens: number) => {
            // Реальные токены от провайдера — приоритет над оценкой
            const snapshot = buildSnapshotFromReal(
              { promptTokens, completionTokens },
              contextWindow,
              lastBreakdown as { history: number; system: number; tools: number; current: number; toolResults?: number },
            )
            // Накапливаем стоимость сессии
            const sess = recordSessionCost(chatId, resolvedProviderId ?? '', resolvedModelId ?? '', promptTokens, completionTokens)
            send({
              type: 'context_usage',
              pct: snapshot.pct,
              estimated: snapshot.estimated,
              limit: snapshot.limit,
              status: snapshot.status,
              source: 'real',
              breakdown: snapshot.breakdown,
              sessionCostCents: sess?.totalCents ?? null,
              sessionRequests: sess?.requests ?? 0,
            })
          },
          onPlanSaved: (plan) => {
            send({ type: 'plan_saved', chatId, msgId, plan })
          },
          onStatus: (text) => {
            send({ type: 'agent_status', chatId, msgId, text })
          },
          onRateLimit: (waitSec) => {
            // Шлём оба события — rate_limit для бара и agent_status для bubble
            send({ type: 'rate_limit', chatId, waitSec })
            send({ type: 'agent_status', chatId, msgId, text: `Rate limit — жду ${waitSec}с...` })
          },
          onRetry: (attempt, reason, waitSec) => {
            const text = reason === 'rate_limit'
              ? `Лимит запросов, повтор через ${waitSec}с...`
              : `Ошибка сети, повтор ${attempt}...`
            send({ type: 'agent_status', chatId, msgId, text })
            if (reason === 'rate_limit' && waitSec) {
              send({ type: 'rate_limit', chatId, waitSec })
            }
          },
          approvalMode: agentSettings.approvalMode as never,
          onConfirm: (toolName, args) => {
            return new Promise(async (resolve) => {
              const reqId = `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              replyHandlers.set(`confirm-reply-${reqId}`, (reply) => {
                resolve(reply.approved as boolean)
              })
              // Единый источник правды: классификация из commandSafety (§1.4)
              const agentPerms = (storeData.agentPermissions as {
                forbiddenPaths?: string[]
              } | undefined) ?? {}
              const classification = classifyTool(toolName, args, { forbiddenPaths: agentPerms.forbiddenPaths })
              // Diff-превью для файловых тулов (§4.1) — dryRun без записи
              let previewDiff = ''
              try {
                if (toolName === 'write_file') {
                  const r = await writeFile(args.path as string, args.content as string, { dryRun: true })
                  previewDiff = r.diff ?? ''
                } else if (toolName === 'edit_file') {
                  const r = await editFile({ ...(args as Parameters<typeof editFile>[0]), dryRun: true })
                  previewDiff = r.diff ?? ''
                } else if (toolName === 'multi_edit_file') {
                  const r = await multiEditFile({ ...(args as Parameters<typeof multiEditFile>[0]), dryRun: true })
                  previewDiff = r.diff ?? ''
                }
              } catch { /* превью опционально */ }
              send({
                type: 'confirm', chatId, msgId, reqId, toolName, args,
                dangerLevel: classification.level,
                dangerReason: classification.reason,
                previewDiff,
              })
            })
          },
          onSpawnAgent: (opts) => {
            return new Promise((resolve) => {
              const replyId = `spawn-reply-${opts.id}`
              replyHandlers.set(replyId, (reply) => {
                resolve({ summary: reply.summary as string, error: reply.error as string | undefined })
              })
              const { approvalMode, ...rest } = opts
              send({ type: 'spawn_agent', chatId, msgId, replyId, ...rest, approval_mode: approvalMode })
            })
          },
          onShellExec: (command, cwd, timeoutSec) => {
            return new Promise((resolve) => {
              const replyId = `shell-exec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              replyHandlers.set(replyId, (reply) => {
                resolve({
                  output: (reply.output as string) ?? '',
                  exitCode: (reply.exitCode as number) ?? 1,
                  timedOut: reply.timedOut as boolean | undefined,
                })
              })
              send({ type: 'shell_exec', chatId, msgId, replyId, command, cwd, timeoutSec })
            })
          },
          onGetAgentStatus: (agentId) => {
            return new Promise((resolve) => {
              const replyId = `get-status-${agentId}-${Date.now()}`
              replyHandlers.set(replyId, (reply) => {
                resolve(reply.status as { status: string; currentStep?: string; stepsCount: number } | null)
              })
              send({ type: 'get_agent_status', chatId, msgId, replyId, agent_id: agentId })
            })
          },
          onTodoUpdate: (items) => {
            send({ type: 'todo_update', chatId, msgId, items })
          },
          onThinkingToken: (token) => {
            if (!thinkingStartMs) thinkingStartMs = Date.now()
            const tok = typeof token === 'string' ? token : ''
            thinkingText += tok
            pendingThinking += tok
            send({ type: 'thinking_token', chatId, msgId, token: tok })
          },
          onThinkingDone: (ms) => {
            thinkingMs = ms
            pendingThinkingMs = ms
            send({ type: 'thinking_done', chatId, msgId, thinkingMs: ms })
          },
        },
        agentSettings.maxSteps,
        undefined,
        systemPrompt,
        planningMode ? [{ role: 'system', content: buildPlanningInjection() }, ...history] : history,
        (toolSchemas as typeof getToolSchemas extends (...args: never[]) => infer R ? R : never) ?? getToolSchemas({ planningMode, mode: workerMode }),
        {
          autoMemoryInterval: agentSettings.autoMemoryInterval ?? 5,
          readFileCache: agentSettings.readFileCache !== false,
          maxRepeatedToolCalls: agentSettings.maxRepeatedToolCalls ?? 3,
          maxRepeatedErrors: agentSettings.maxRepeatedErrors ?? 2,
          fileCacheSnapshot: (workerData as Record<string, unknown>).fileCacheSnapshot as Record<string, import('../core/context/fileCacheTypes').FileCacheEntry> | undefined,
        }
      )
    } else {
      // Обычный стриминг без tools
      const contextMessages = history.map(m => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
      }))
      contextMessages.push({ role: 'user', content })

      await aiClient.streamChat(
        contextMessages,
        {
          onContextCounted: (promptTokens) => {
            const pct = Math.min(100, Math.round(promptTokens / contextWindow * 100))
            const status = pct >= 85 ? 'critical' : pct >= 60 ? 'warn' : 'ok'
            const breakdown = { history: promptTokens, system: 0, tools: 0, current: 0 }
            lastBreakdown = breakdown
            send({
              type: 'context_usage',
              pct, estimated: promptTokens, limit: contextWindow, status,
              source: 'estimate',
              breakdown,
            })
          },
          onToken: (token) => {
            fullText += token
            send({ type: 'token', chatId, msgId, token })
          },
          onThinkingToken: (token) => {
            if (!thinkingStartMs) thinkingStartMs = Date.now()
            const tok = typeof token === 'string' ? token : ''
            thinkingText += tok
            send({ type: 'thinking_token', chatId, msgId, token: tok })
          },
          onThinkingDone: (ms) => {
            thinkingMs = ms
            send({ type: 'thinking_done', chatId, msgId, thinkingMs: ms })
          },
          onUsage: (usage) => {
            // Реальные токены от провайдера — обновляем counter точными данными
            const cw = getModelContextWindow(storeData)
            const snapshot = buildSnapshotFromReal(usage, cw, lastBreakdown as { history: number; system: number; tools: number; current: number })
            // Накапливаем стоимость сессии
            const sess = recordSessionCost(chatId, resolvedProviderId ?? '', resolvedModelId ?? '', usage.promptTokens, usage.completionTokens)
            send({
              type: 'context_usage',
              pct: snapshot.pct,
              estimated: snapshot.estimated,
              limit: snapshot.limit,
              status: snapshot.status,
              source: 'real',
              breakdown: snapshot.breakdown,
              sessionCostCents: sess?.totalCents ?? null,
              sessionRequests: sess?.requests ?? 0,
            })
          },
          onDone: () => finalize(),
          onError: (err) => {
            send({
              type: 'error', chatId, error: err.message,
              fullText, thinkingText: thinkingText || undefined, thinkingMs,
            })
          },
          onRateLimit: (waitSec) => {
            send({ type: 'rate_limit', chatId, waitSec })
          },
          onWaiting: () => {
            send({ type: 'agent_status', chatId, msgId, text: 'Ожидаю ответа...' })
          },
          onRetry: (attempt, reason, waitSec) => {
            const text = reason === 'rate_limit'
              ? `Лимит запросов, повтор через ${waitSec}с...`
              : `Ошибка сети, повтор ${attempt}...`
            send({ type: 'agent_status', chatId, msgId, text })
            // Дублируем rate_limit для бара с таймером
            if (reason === 'rate_limit' && waitSec) {
              send({ type: 'rate_limit', chatId, waitSec })
            }
          },
        },
        'main',
        systemPrompt
      )
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    flushIter()
    send({
      type: 'error', chatId, error: errMsg,
      fullText, thinkingText: thinkingText || undefined, thinkingMs,
      collectedSteps, collectedIters: collectedIters.length > 0 ? collectedIters : undefined,
      updatedProviders: storeData.providers,
      fileCacheUpdates: agent?.getFileCacheUpdates(),
    })
  }
})
