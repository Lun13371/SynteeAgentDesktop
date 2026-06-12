/**
 * AI Worker Thread — весь AI/Agent код здесь.
 * При worker.terminate() все соединения рвутся мгновенно OS-ом.
 * Сохранение происходит в main thread через сообщение 'save'.
 */
import { parentPort, workerData } from 'worker_threads'
import { AIClient } from '../core/ai/AIClient'
import { Agent } from '../core/agent/Agent'

// Store-совместимый объект из сериализованных данных
const storeData: Record<string, unknown> = workerData.storeData

// Заглушка под electron-store API
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

  // Финализация — отправляем в main для сохранения и отправки DONE
  const finalize = () => {
    send({
      type: 'done',
      chatId,
      msgId,
      fullText,
      thinkingText: thinkingText || undefined,
      thinkingMs,
      collectedSteps,
      incognito,
      content, // оригинальный запрос пользователя (для автоимени и памяти)
    })
  }

  try {
    if (enableTools && !incognito) {
      // Агентский режим
      const agent = new Agent(fakeStore)
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
              }
              collectedSteps.push(ts)
              send({ type: 'step', chatId, msgId, step })
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
        },
        agentSettings.maxSteps
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
            // Парсим <thinking> теги
            const buf = fullText + thinkingText + token
            const thinkStart = '<thinking>'
            const thinkEnd = '</thinking>'

            if (buf.includes(thinkStart) && !buf.includes(thinkEnd)) {
              // Внутри thinking
              if (!thinkingStartMs) thinkingStartMs = Date.now()
              thinkingText += token
              send({ type: 'thinking_token', chatId, msgId, token })
            } else if (buf.includes(thinkStart) && buf.includes(thinkEnd) && !thinkingMs) {
              // thinking завершился
              thinkingMs = Date.now() - thinkingStartMs
              send({ type: 'thinking_done', chatId, msgId, thinkingMs })
            } else if (!buf.includes(thinkStart) || buf.includes(thinkEnd)) {
              fullText += token
              send({ type: 'token', chatId, msgId, token })
            }
          },
          onDone: () => finalize(),
          onError: (err) => {
            // При terminate() тоже попадаем сюда — финализируем с тем что есть
            finalize()
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
  } catch {
    // Любой крэш — финализируем с накопленным текстом
    finalize()
  }
})
