/**
 * AI Worker Thread — весь AI/Agent код здесь.
 * При worker.terminate() все соединения рвутся мгновенно OS-ом.
 * Сохранение происходит в main thread через сообщение 'done'.
 */
import { parentPort, workerData } from 'worker_threads'
import { AIClient } from '../core/ai/AIClient'
import { Agent } from '../core/agent/Agent'
import { buildSystemPrompt } from '../core/prompts/buildSystemPrompt'

const storeData: Record<string, unknown> = workerData.storeData

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
  } = msg as {
    chatId: string
    msgId: string
    content: string
    history: Array<{ role: string; content: string }>
    systemPrompt: string
    enableTools: boolean
    incognito: boolean
    agentSettings: {
      enableTools: boolean
      maxSteps: number
      approvalMode: string
      toolOutputMode: string
      enableThinking: boolean
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

      // Передаём историю как нормальный массив сообщений в userMessage
      // Agent.run добавит их в messages перед user-запросом
      await agent.run(
        content,
        {
          onStep: (step) => {
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
              }
              collectedSteps.push(ts)
              // Новая итерация только если между тулами был текст
              if (pendingTextAfter.trim()) {
                flushIter()
                currentIterTextBefore = pendingTextAfter
                pendingTextAfter = ''
              } else if (currentIterSteps.length === 0) {
                // Первый тул — берём накопленный текст как textBefore
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
              }
              collectedSteps.push(ts)
              currentIterSteps.push(ts)
              send({ type: 'step', chatId, msgId, step })
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
          approvalMode: agentSettings.approvalMode as never,
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
            return agentStatusCache.get(agentId) ?? null
          },
        },
        agentSettings.maxSteps,
        undefined,
        systemPrompt,
        history,  // processedHistory (после rolling window) как нормальные messages
      )
    } else {
      // Обычный стриминг без tools — тоже используем processedHistory
      const contextMessages = history.map(m => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
      }))
      contextMessages.push({ role: 'user', content })

      await aiClient.streamChat(
        contextMessages,
        {
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
          onDone: () => finalize(),
          onError: (err) => {
            send({ type: 'error', chatId, error: err.message })
          },
          onRateLimit: (waitSec) => {
            send({ type: 'rate_limit', chatId, waitSec })
          },
        },
        'main',
        systemPrompt
      )
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    send({ type: 'error', chatId, error: msg })
  }
})
