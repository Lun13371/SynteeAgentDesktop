/**
 * AI Worker Thread — весь AI/Agent код здесь.
 * При worker.terminate() все соединения рвутся мгновенно OS-ом.
 * Сохранение происходит в main thread через сообщение 'done'.
 */
import { parentPort, workerData } from 'worker_threads'
import { AIClient } from '../core/ai/AIClient'
import { Agent } from '../core/agent/Agent'
import { buildPlanningInjection } from '../core/prompts/buildSystemPrompt'
import { estimateTokens, getModelContextWindow, TOOL_SCHEMAS_OVERHEAD } from '../core/context/contextManager'
import { getToolSchemas } from '../core/tools/index'

const storeData: Record<string, unknown> = workerData.storeData
const planningMode: boolean = !!(workerData as Record<string, unknown>).planningMode

// Кэш статусов суб-агентов — обновляется через agent_status_update от main
const agentStatusCache = new Map<string, { status: string; stepsCount: number; currentStep?: string }>()

// Единый реестр одноразовых reply-handlers (replyId → resolver)
const replyHandlers = new Map<string, (msg: Record<string, unknown>) => void>()

// Флаг — агент уже запущен (стартовое сообщение обработано)
let agentStarted = false

const fakeStore = {
  get: (key: string, def?: unknown) => (storeData[key] !== undefined ? storeData[key] : def),
  set: (_key: string, _val: unknown) => {},
} as never

const aiClient = new AIClient(fakeStore)

function send(msg: Record<string, unknown>) {
  parentPort?.postMessage(msg)
}

// ЕДИНЫЙ handler — все входящие сообщения через один on('message')
parentPort?.on('message', async (msg: Record<string, unknown>) => {
  // --- Reply от main (spawn_agent_reply, wait_agents_reply, get_agent_status_reply) ---
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
  } = msg as {
    chatId: string
    msgId: string
    content: string
    history: Array<{ role: string; content: string }>
    systemPrompt: string
    enableTools: boolean
    incognito: boolean
    toolSchemas?: unknown[]
    agentSettings: {
      enableTools: boolean
      maxSteps: number
      approvalMode: string
      toolOutputMode: string
      enableThinking: boolean
      autoMemoryInterval?: number
      readFileCache?: boolean
      toolSummarization?: boolean
      maxRepeatedToolCalls?: number
      maxRepeatedErrors?: number
      contextCompactionPct?: number
      preserveRecentToolRounds?: number
    }
  }

  let fullText = ''
  let thinkingText = ''
  let thinkingStartMs = 0
  let thinkingMs: number | undefined
  const collectedSteps: unknown[] = []

  // Итерации для сохранения в БД — {label?, textBefore, steps[]}
  const collectedIters: Array<{ label?: string; textBefore: string; steps: unknown[] }> = []
  let currentIterTextBefore = ''
  let currentIterSteps: unknown[] = []
  let pendingTextAfter = ''  // текст после последнего тулчейна

  // Live token counter — считаем накопленный контекст агента
  const contextWindow = getModelContextWindow(storeData)
  const sysPromptTokens = estimateTokens(systemPrompt) + 4
  // Токены истории (начальный снапшот)
  const historyBaseTokens = history.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0)
  let toolResultTokensAccum = 0  // накопленные токены tool results за сессию

  function sendLiveContextUsage() {
    const estimated = historyBaseTokens + sysPromptTokens + TOOL_SCHEMAS_OVERHEAD + toolResultTokensAccum + estimateTokens(fullText) + 100
    const pct = Math.min(100, Math.round(estimated / contextWindow * 100))
    const status = pct >= 85 ? 'critical' : pct >= 60 ? 'warn' : 'ok'
    send({
      type: 'context_usage',
      pct, estimated, limit: contextWindow, status,
      breakdown: {
        history: historyBaseTokens,
        system: sysPromptTokens,
        tools: TOOL_SCHEMAS_OVERHEAD,
        toolResults: toolResultTokensAccum,
        answer: estimateTokens(fullText),
      },
    })
  }

  const flushIter = () => {
    if (currentIterSteps.length > 0) {
      collectedIters.push({ textBefore: currentIterTextBefore, steps: currentIterSteps })
      currentIterTextBefore = ''
      currentIterSteps = []
    }
  }

  const finalize = () => {
    flushIter()
    send({
      type: 'done',
      chatId, msgId,
      fullText,
      thinkingText: thinkingText || undefined,
      thinkingMs,
      collectedSteps,
      collectedIters: collectedIters.length > 0 ? collectedIters : undefined,
      incognito,
      content,
    })
  }

  try {
    if (enableTools && !incognito) {
      const isSubAgent = !!(workerData as Record<string, unknown>).isSubAgent
      const agent = new Agent(fakeStore, isSubAgent ? 'subagent' : 'main')

      // Прокидываем chatId и колбэки рабочей памяти
      agent.chatId = chatId
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
          onContextCounted: (promptTokens) => {
            const pct = Math.min(100, Math.round(promptTokens / contextWindow * 100))
            const status = pct >= 85 ? 'critical' : pct >= 60 ? 'warn' : 'ok'
            send({
              type: 'context_usage',
              pct, estimated: promptTokens, limit: contextWindow, status,
              breakdown: { history: promptTokens, system: 0, tools: 3800, current: 0 },
            })
          },
          onStep: (step) => {
            // Скрытые тулы (think, update_working_memory) — не шлём в UI
            if (step.hidden) {
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
              }
              collectedSteps.push(ts)
              if (pendingTextAfter.trim()) {
                flushIter()
                currentIterTextBefore = pendingTextAfter
                pendingTextAfter = ''
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
              if (!thinkingStartMs) thinkingStartMs = Date.now()
              const thoughtStr = typeof step.content === 'string' ? step.content : String(step.content ?? '')
              thinkingText += thoughtStr
              send({ type: 'thinking_token', chatId, msgId, token: thoughtStr })
              thinkingMs = Date.now() - thinkingStartMs
              send({ type: 'thinking_done', chatId, msgId, thinkingMs })
            } else if (step.type === 'answer') {
              fullText += step.content
              pendingTextAfter += step.content
              send({ type: 'token', chatId, msgId, token: step.content })
            }
          },
          onDone: () => finalize(),
          onError: (err) => {
            send({ type: 'error', chatId, error: err.message })
          },
          onContextUpdate: (tokens: number) => {
            const pct = Math.min(100, Math.round(tokens / contextWindow * 100))
            const status = pct >= 85 ? 'critical' : pct >= 60 ? 'warn' : 'ok'
            send({
              type: 'context_usage',
              pct, estimated: tokens, limit: contextWindow, status,
              breakdown: { history: historyBaseTokens, system: sysPromptTokens, tools: 3800, current: tokens - historyBaseTokens - sysPromptTokens - 3800 },
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
            return new Promise((resolve) => {
              const reqId = `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              replyHandlers.set(`confirm-reply-${reqId}`, (reply) => {
                resolve(reply.approved as boolean)
              })
              send({ type: 'confirm', chatId, msgId, reqId, toolName, args })
            })
          },
          onSpawnAgent: (opts) => {
            return new Promise((resolve) => {
              const replyId = `spawn-reply-${opts.id}`
              replyHandlers.set(replyId, (reply) => {
                resolve({ summary: reply.summary as string, error: reply.error as string | undefined })
              })
              send({ type: 'spawn_agent', chatId, msgId, replyId, ...opts })
            })
          },
          onWaitAgents: (agentIds) => {
            return new Promise((resolve) => {
              const replyId = `wait-agents-${Date.now()}`
              replyHandlers.set(replyId, (reply) => {
                resolve(reply.results as Array<{ summary: string; error?: string }>)
              })
              send({ type: 'wait_agents', chatId, msgId, replyId, agentIds })
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
        },
        agentSettings.maxSteps,
        undefined,
        systemPrompt,
        planningMode ? [{ role: 'system', content: buildPlanningInjection() }, ...history] : history,
        (toolSchemas as typeof getToolSchemas extends (...args: never[]) => infer R ? R : never) ?? getToolSchemas({ planningMode }),
        {
          autoMemoryInterval: agentSettings.autoMemoryInterval ?? 5,
          readFileCache: agentSettings.readFileCache !== false,
          toolSummarization: agentSettings.toolSummarization !== false,
          maxRepeatedToolCalls: agentSettings.maxRepeatedToolCalls ?? 3,
          maxRepeatedErrors: agentSettings.maxRepeatedErrors ?? 2,
          contextCompactionPct: agentSettings.contextCompactionPct ?? 75,
          preserveRecentToolRounds: agentSettings.preserveRecentToolRounds ?? 8,
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
            send({
              type: 'context_usage',
              pct, estimated: promptTokens, limit: contextWindow, status,
              breakdown: { history: promptTokens, system: 0, tools: 0, current: 0, real: false },
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
            const contextWindow = getModelContextWindow(storeData)
            const pct = Math.min(100, Math.round(usage.promptTokens / contextWindow * 100))
            const status = pct >= 85 ? 'critical' : pct >= 60 ? 'warn' : 'ok'
            send({
              type: 'context_usage',
              pct, estimated: usage.promptTokens, limit: contextWindow, status,
              breakdown: {
                history: usage.promptTokens,
                system: 0,
                tools: 0,
                current: 0,
                real: true,  // флаг что это реальные данные от провайдера
                completionTokens: usage.completionTokens,
              },
            })
          },
          onDone: () => finalize(),
          onError: (err) => {
            send({ type: 'error', chatId, error: err.message })
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
    send({ type: 'error', chatId, error: errMsg })
  }
})
