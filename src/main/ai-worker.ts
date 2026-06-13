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
// Все async ответы от main (spawn_agent_reply, wait_agents_reply) приходят сюда
const replyHandlers = new Map<string, (msg: Record<string, unknown>) => void>()

parentPort?.on('message', (msg: Record<string, unknown>) => {
  if (msg.type === 'agent_status_update' && msg.agentId) {
    agentStatusCache.set(msg.agentId as string, msg.statusData as never)
    return
  }
  // Все reply — диспатчим в зарегистрированный handler
  if (msg.replyId) {
    const handler = replyHandlers.get(msg.replyId as string)
    if (handler) {
      replyHandlers.delete(msg.replyId as string)
      handler(msg)
    }
  }
})

const fakeStore = {
  get: (key: string, def?: unknown) => (storeData[key] !== undefined ? storeData[key] : def),
  set: (_key: string, _val: unknown) => {},
} as never

const aiClient = new AIClient(fakeStore)

interface WorkerStartParams {
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

function send(msg: Record<string, unknown>) {
  parentPort?.postMessage(msg)
}

parentPort?.on('message', async (params: WorkerStartParams) => {
  const {
    chatId, msgId, content, history,
    systemPrompt, enableTools, incognito,
    agentSettings,
  } = params

  let fullText = ''
  let thinkingText = ''
  let thinkingStartMs = 0
  let thinkingMs: number | undefined
  const collectedSteps: unknown[] = []

  const finalize = () => {
    send({
      type: 'done',
      chatId, msgId,
      fullText,
      thinkingText: thinkingText || undefined,
      thinkingMs,
      collectedSteps,
      incognito,
      content,
    })
  }

  try {
    if (enableTools && !incognito) {
      // Агентский режим
      const isSubAgent = !!(workerData as Record<string, unknown>).isSubAgent
      const agent = new Agent(fakeStore, isSubAgent ? 'subagent' : 'main')

      // История как текст для контекста
      const historyContext = history.slice(-10)
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n')
      const messageWithContext = historyContext
        ? `[Контекст разговора]\n${historyContext}\n\n[Новый вопрос]\n${content}`
        : content

      await agent.run(
        messageWithContext,
        {
          onStep: (step) => {
            if (step.type === 'tool_call' || step.type === 'tool_result') {
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
              replyHandlers.set(replyId, (msg) => {
                resolve({ summary: msg.summary as string, error: msg.error as string | undefined })
              })
              send({ type: 'spawn_agent', chatId, msgId, replyId, ...opts })
            })
          },
          onWaitAgents: (agentIds) => {
            return new Promise((resolve) => {
              const replyId = `wait-agents-${Date.now()}`
              replyHandlers.set(replyId, (msg) => {
                resolve(msg.results as Array<{ summary: string; error?: string }>)
              })
              send({ type: 'wait_agents', chatId, msgId, replyId, agentIds })
            })
          },
          onGetAgentStatus: (agentId) => {
            // Синхронный запрос статуса — worker посылает и ждёт ответа
            // Используем блокирующий atomics trick не вариант в worker — делаем через реестр
            // Шлём запрос, ответ придёт через parentPort — но callback синхронный
            // Решение: кэшируем последние статусы при каждом agent:update
            return agentStatusCache.get(agentId) ?? null
          },
        },
        agentSettings.maxSteps,
        undefined,
        systemPrompt,
      )
    } else {
      // Обычный стриминг без tools
      const contextMessages = history.slice(-20).map(m => ({
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
          onError: () => finalize(),
          onRateLimit: (waitSec) => {
            send({ type: 'rate_limit', chatId, waitSec })
          },
        },
        'main',
        systemPrompt
      )
    }
  } catch {
    finalize()
  }
})
