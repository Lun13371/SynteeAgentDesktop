import { useEffect } from 'react'
import { v4 as uuid } from 'uuid'
import { IPC_EVENTS } from '../../../shared/constants'
import { useChatStore, type LiveIter } from '../store/chat.store'
import type { Message, ToolStep } from '../../../shared/types'

// Per-chat mutable буферы для высокочастотных обновлений (токены стриминга).
// Не React-state — обновляется синхронно на каждый токен, а Zustand store
// обновляется через RAF throttle (60fps). Раньше эти буферы лежали в
// useState ChatPage и были общими для всех чатов — при переключении чатов
// токены чужого чата silently дропались фильтром chatId !== current.
// Теперь: один буфер на chatId в module-level Map. ChatPage читает
// отображаемое состояние из liveByChat[currentChatId] в Zustand.
interface ChatBuffers {
  text: string               // liveTextAfter — текст после последних тулов
  thinking: string           // pendingThinking — накопленный reasoning раунда
  thinkingMs?: number        // длительность reasoning текущего раунда
  isThinkingLive: boolean    // reasoning ещё стримится
  iters: LiveIter[]          // итерации тула (textBefore + steps)
  steps: ToolStep[]          // плоский список шагов (для финального сохранения)
  todo: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>
  agentStatus: string | null
  rateLimitSec: number
  rateLimitCountdown?: ReturnType<typeof setInterval>
  tokenBuf: string           // RAF throttle буфер
  rafId: number | null       // id requestAnimationFrame для флеша токенов
  streamMsgId: string | null // msgId текущего стрима (для матчинга step→итерация)
}

const buffers = new Map<string, ChatBuffers>()

function getBuf(chatId: string): ChatBuffers {
  let buf = buffers.get(chatId)
  if (!buf) {
    buf = {
      text: '', thinking: '', thinkingMs: undefined, isThinkingLive: false,
      iters: [], steps: [], todo: [], agentStatus: null, rateLimitSec: 0,
      tokenBuf: '', rafId: null, streamMsgId: null,
    }
    buffers.set(chatId, buf)
  }
  return buf
}

/**
 * Инициализация буфера для нового запуска chat:send. Вызывается из ChatPage
 * перед отправкой сообщения. Устанавливает streamMsgId = 'streaming-pending'
 * и выставляет isTyping в store, чтобы live-пузырь появился сразу.
 * Если в этом чате уже есть активный буфер (например, ждёт в очереди) —
 * не трогаем его, новый send встанет в очередь в main-процессе.
 */
export function initChatSend(chatId: string) {
  // Если буфер уже есть и активен — не перезаписываем (main поставит в очередь)
  if (buffers.has(chatId)) return
  const buf = getBuf(chatId)
  buf.streamMsgId = 'streaming-pending'
  buf.text = ''
  buf.thinking = ''
  buf.thinkingMs = undefined
  buf.isThinkingLive = false
  buf.iters = []
  buf.steps = []
  buf.todo = []
  buf.agentStatus = null
  buf.rateLimitSec = 0
  buf.tokenBuf = ''
  useChatStore.getState().hydrateLiveState(chatId, {
    msgId: 'streaming-pending',
    text: '',
    thinking: '',
    isThinkingLive: false,
    iters: [],
    steps: [],
    todo: [],
    agentStatus: null,
    rateLimitSec: 0,
    isTyping: true,
    isAgentRunning: false,
  })
}

/**
 * Гидрация буфера из main при возврате в чат с активным агентом.
 * ChatPage вызывает это при selectChat — если в main есть ActiveRun,
 * копируем его буферы сюда, чтобы продолжить стрим с того же места.
 */
export async function hydrateFromMain(chatId: string): Promise<boolean> {
  try {
    const live = await window.syntee.chat.getLiveState(chatId) as {
      chatId: string; msgId: string; isRunning: boolean
      bufferedText: string; bufferedThinking: string; bufferedThinkingMs?: number
      bufferedSteps: unknown[]; bufferedIters: unknown[]
      bufferedTodo: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>
      bufferedAgentStatus: string | null; bufferedRateLimitSec: number
    } | null
    if (!live || !live.isRunning) {
      // В main нет активного запуска — чистим локальный буфер если был
      buffers.delete(chatId)
      useChatStore.getState().clearLiveState(chatId)
      return false
    }
    const buf = getBuf(chatId)
    buf.streamMsgId = live.msgId
    buf.text = live.bufferedText || ''
    buf.thinking = live.bufferedThinking || ''
    buf.thinkingMs = live.bufferedThinkingMs
    buf.isThinkingLive = false
    buf.iters = (live.bufferedIters as LiveIter[]) || []
    buf.steps = (live.bufferedSteps as ToolStep[]) || []
    buf.todo = live.bufferedTodo || []
    buf.agentStatus = live.bufferedAgentStatus
    buf.rateLimitSec = live.bufferedRateLimitSec || 0
    buf.tokenBuf = ''
    useChatStore.getState().hydrateLiveState(chatId, {
      msgId: live.msgId,
      text: buf.text,
      thinking: buf.thinking,
      thinkingMs: buf.thinkingMs,
      isThinkingLive: false,
      iters: buf.iters,
      steps: buf.steps,
      todo: buf.todo,
      agentStatus: buf.agentStatus,
      rateLimitSec: buf.rateLimitSec,
      isTyping: true,
      isAgentRunning: buf.iters.length > 0 || buf.steps.length > 0,
    })
    return true
  } catch {
    return false
  }
}

// Глобальная подписка на все IPC-события чатов. Монтируется ОДИН раз
// в App.tsx. Пишет в Zustand store по chatId — параллельные чаты каждый
// имеют свой LiveState, не перетирая друг друга.
// Перенесено из ChatPage.tsx (строки 218-481) чтобы:
// 1. События чужого чата не дропались при переключении
// 2. При возврате в чат показать накопленный прогресс
// 3. Sidebar мог показывать статус чата (spinner/✓/✗)
export function useChatRunSubscription() {
  useEffect(() => {
    const flushTokens = (chatId: string) => {
      const buf = getBuf(chatId)
      buf.rafId = null
      if (!buf.tokenBuf) return
      const chunk = buf.tokenBuf
      buf.tokenBuf = ''
      buf.text += chunk
      useChatStore.getState().setLiveState(chatId, { text: buf.text })
    }

    const scheduleFlush = (chatId: string) => {
      const buf = getBuf(chatId)
      if (buf.rafId !== null) return
      buf.rafId = requestAnimationFrame(() => flushTokens(chatId))
    }

    // CHAT_STREAM_TOKEN — токены ответа и reasoning
    const offToken = window.syntee.on(IPC_EVENTS.CHAT_STREAM_TOKEN, (data: {
      chatId: string; msgId: string; token?: string
      thinkingToken?: string; thinkingDone?: boolean; thinkingMs?: number
    }) => {
      const buf = getBuf(data.chatId)
      buf.streamMsgId = data.msgId
      useChatStore.getState().setLiveState(data.chatId, {
        msgId: data.msgId,
        isTyping: true,
      })

      if (data.thinkingToken) {
        const tok = typeof data.thinkingToken === 'string' ? data.thinkingToken : String(data.thinkingToken ?? '')
        buf.thinking += tok
        buf.isThinkingLive = true
        useChatStore.getState().setLiveState(data.chatId, {
          thinking: buf.thinking,
          isThinkingLive: true,
        })
        return
      }
      if (data.thinkingDone) {
        buf.thinkingMs = data.thinkingMs
        buf.isThinkingLive = false
        useChatStore.getState().setLiveState(data.chatId, {
          thinkingMs: data.thinkingMs,
          isThinkingLive: false,
        })
        return
      }
      if (data.token) {
        buf.tokenBuf += data.token
        scheduleFlush(data.chatId)
      }
    })

    // CHAT_STREAM_DONE — финал стрима, сохранение в БД
    const offDone = window.syntee.on(IPC_EVENTS.CHAT_STREAM_DONE, (data: { chatId: string; message: Message }) => {
      const buf = buffers.get(data.chatId)
      if (buf?.rafId !== null && buf?.rafId !== undefined) {
        cancelAnimationFrame(buf.rafId)
      }
      if (buf) {
        buf.tokenBuf = ''
        buf.rafId = null
      }
      if (buf?.rateLimitCountdown) {
        clearInterval(buf.rateLimitCountdown)
      }
      useChatStore.getState().clearLiveState(data.chatId)
      buffers.delete(data.chatId)

      useChatStore.getState().addMessage(data.message)
      window.syntee.chat.getAll().then((all) => useChatStore.getState().setChats(all))
    })

    // CHAT_STREAM_ERROR — ошибка/остановка
    const offError = window.syntee.on(IPC_EVENTS.CHAT_STREAM_ERROR, (data: { chatId: string; error: string }) => {
      const buf = buffers.get(data.chatId)
      if (buf?.rafId !== null && buf?.rafId !== undefined) {
        cancelAnimationFrame(buf.rafId)
      }
      if (buf?.rateLimitCountdown) clearInterval(buf.rateLimitCountdown)
      useChatStore.getState().clearLiveState(data.chatId)
      buffers.delete(data.chatId)
    })

    // CHAT_RUN_STATUS — статус запуска для сайдбара
    const offRunStatus = window.syntee.on(IPC_EVENTS.CHAT_RUN_STATUS, (data: {
      chatId: string; status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
      msgId?: string; error?: string; ts: number
    }) => {
      useChatStore.getState().setRunStatus(data.chatId, data.status, data.error, data.msgId)
      if (data.status === 'cancelled' || data.status === 'error') {
        const buf = buffers.get(data.chatId)
        if (buf?.rafId !== null && buf?.rafId !== undefined) cancelAnimationFrame(buf.rafId)
        if (buf?.rateLimitCountdown) clearInterval(buf.rateLimitCountdown)
      }
    })

    // RATE_LIMIT — ожидание перед retry
    const offRateLimit = window.syntee.on(IPC_EVENTS.RATE_LIMIT, (data: { waitSec: number; chatId?: string }) => {
      if (!data.chatId) return
      const buf = getBuf(data.chatId)
      buf.rateLimitSec = data.waitSec
      useChatStore.getState().setLiveState(data.chatId, { rateLimitSec: data.waitSec })
      let remaining = data.waitSec
      if (buf.rateLimitCountdown) clearInterval(buf.rateLimitCountdown)
      buf.rateLimitCountdown = setInterval(() => {
        remaining -= 1
        if (remaining <= 0) {
          clearInterval(buf.rateLimitCountdown!)
          buf.rateLimitSec = 0
          useChatStore.getState().setLiveState(data.chatId, { rateLimitSec: 0 })
        } else {
          buf.rateLimitSec = remaining
          useChatStore.getState().setLiveState(data.chatId, { rateLimitSec: remaining })
        }
      }, 1000)
    })

    // agent:todo — чек-лист плана
    const offTodo = window.syntee.on('agent:todo', (data: {
      items: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>
      msgId?: string; chatId?: string
    }) => {
      if (!data.chatId) return
      const buf = getBuf(data.chatId)
      if (buf.streamMsgId === 'streaming-pending' && data.msgId) {
        buf.streamMsgId = data.msgId
        useChatStore.getState().setLiveState(data.chatId, { msgId: data.msgId })
      }
      if (data.msgId && buf.streamMsgId && data.msgId !== buf.streamMsgId) return
      buf.todo = data.items
      useChatStore.getState().setLiveState(data.chatId, { todo: data.items })
    })

    // agent:status — текущий статус агента
    const offStatus = window.syntee.on('agent:status', (data: { msgId: string; chatId: string; text: string }) => {
      if (!data.chatId) return
      const buf = getBuf(data.chatId)
      buf.agentStatus = data.text
      useChatStore.getState().setLiveState(data.chatId, { agentStatus: data.text })
    })

    // agent:step — шаги тулов (tool_call_pending/tool_call/tool_result).
    // Самая нетривиальная часть: матчинг pending→call по pendingCallId,
    // группировка в итерации по textBefore/thinking.
    const offStep = window.syntee.on('agent:step', (step: {
      type: string; toolName?: string; toolArgs?: Record<string, unknown>
      content: string; success?: boolean; imageUrl?: string
      msgId?: string; callId?: string; pendingCallId?: string; chatId?: string
      diff?: string
    }) => {
      if (!step.chatId) return
      const chatId = step.chatId
      const buf = getBuf(chatId)
      if (!buf.streamMsgId) return

      // Усваиваем реальный msgId из первого события (как в offToken)
      if (buf.streamMsgId === 'streaming-pending' && step.msgId) {
        buf.streamMsgId = step.msgId
        useChatStore.getState().setLiveState(chatId, { msgId: step.msgId })
      }
      if (step.msgId && step.msgId !== buf.streamMsgId) return

      const commitIters = () => {
        useChatStore.getState().setLiveState(chatId, {
          iters: [...buf.iters],
          isAgentRunning: true,
          isTyping: true,
        })
      }
      const commitSteps = () => {
        useChatStore.getState().setLiveState(chatId, { steps: [...buf.steps] })
      }

      if (step.type === 'tool_call_pending') {
        const pendingStep: ToolStep = {
          id: uuid(), type: 'tool_call' as const,
          toolName: step.toolName, toolArgs: undefined,
          content: step.content, success: undefined,
          timestamp: Date.now(), imageUrl: undefined,
          callId: step.callId,
          pending: true,
        }
        const iters = buf.iters
        const last = iters[iters.length - 1]
        const textBetween = buf.text
        const thinkingNow = buf.thinking
        const thinkingMsNow = buf.thinkingMs
        let newIters: typeof iters
        if (!last || textBetween.trim() || thinkingNow) {
          newIters = [...iters, {
            textBefore: textBetween,
            thinking: thinkingNow || undefined,
            thinkingMs: thinkingMsNow,
            steps: [pendingStep],
          }]
        } else {
          iters[iters.length - 1] = { ...last, steps: [...last.steps, pendingStep] }
          newIters = iters
        }
        buf.iters = newIters
        buf.text = ''
        buf.thinking = ''
        buf.thinkingMs = undefined
        buf.isThinkingLive = false
        commitIters()
        useChatStore.getState().setLiveState(chatId, {
          text: '', thinking: '', thinkingMs: undefined, isThinkingLive: false,
        })
      } else if (step.type === 'tool_call') {
        // Сначала синхронно флешим буфер токенов
        if (buf.rafId !== null) {
          cancelAnimationFrame(buf.rafId)
          buf.rafId = null
        }
        if (buf.tokenBuf) {
          const chunk = buf.tokenBuf
          buf.tokenBuf = ''
          buf.text += chunk
          useChatStore.getState().setLiveState(chatId, { text: buf.text })
        }
        const newStep: ToolStep = {
          id: uuid(), type: 'tool_call' as const,
          toolName: step.toolName, toolArgs: step.toolArgs,
          content: step.content, success: step.success,
          timestamp: Date.now(), imageUrl: step.imageUrl,
          callId: step.callId,
        }
        buf.steps = [...buf.steps, newStep]

        // Заменяем pending-карточку in-place по pendingCallId
        let replacedPending = false
        if (step.pendingCallId) {
          const itersForReplace = buf.iters.map(iter => {
            const stepIdx = iter.steps.findIndex(s => s.type === 'tool_call' && s.callId === step.pendingCallId)
            if (stepIdx === -1) return iter
            replacedPending = true
            const nextSteps = [...iter.steps]
            nextSteps[stepIdx] = newStep
            return { ...iter, steps: nextSteps }
          })
          if (replacedPending) {
            buf.iters = itersForReplace
          }
        }

        if (!replacedPending) {
          const iters = buf.iters
          const last = iters[iters.length - 1]
          const textBetween = buf.text
          const thinkingNow = buf.thinking
          const thinkingMsNow = buf.thinkingMs
          let newIters: typeof iters
          if (!last || textBetween.trim() || thinkingNow) {
            newIters = [...iters, {
              textBefore: textBetween,
              thinking: thinkingNow || undefined,
              thinkingMs: thinkingMsNow,
              steps: [newStep],
            }]
          } else {
            iters[iters.length - 1] = { ...last, steps: [...last.steps, newStep] }
            newIters = iters
          }
          buf.iters = newIters
        }
        buf.text = ''
        buf.thinking = ''
        buf.thinkingMs = undefined
        buf.isThinkingLive = false
        commitIters()
        commitSteps()
        useChatStore.getState().setLiveState(chatId, {
          text: '', thinking: '', thinkingMs: undefined, isThinkingLive: false,
        })
      } else if (step.type === 'tool_result') {
        const newStep: ToolStep = {
          id: uuid(), type: 'tool_result' as const,
          toolName: step.toolName, toolArgs: step.toolArgs,
          content: step.content, success: step.success,
          timestamp: Date.now(), imageUrl: step.imageUrl,
          diff: step.diff,
          callId: step.callId,
        }
        buf.steps = [...buf.steps, newStep]
        if (buf.iters.length === 0) {
          commitSteps()
          return
        }
        const iters = buf.iters
        // Матчим result в правильную итерацию по callId или toolName
        let targetIterIdx = iters.length - 1
        if (step.callId) {
          const idx = iters.findIndex(iter =>
            iter.steps.some(s => s.type === 'tool_call' && s.callId === step.callId)
          )
          if (idx !== -1) targetIterIdx = idx
        } else if (step.toolName) {
          const idx = iters.findIndex(iter =>
            iter.steps.some(s => s.type === 'tool_call' && s.toolName === step.toolName) &&
            !iter.steps.some(s => s.type === 'tool_result' && s.toolName === step.toolName)
          )
          if (idx !== -1) targetIterIdx = idx
        }
        iters[targetIterIdx] = { ...iters[targetIterIdx], steps: [...iters[targetIterIdx].steps, newStep] }
        commitIters()
        commitSteps()
      }
    })

    return () => {
      offToken(); offDone(); offError(); offRunStatus(); offRateLimit(); offTodo(); offStatus(); offStep()
    }
  }, [])
}
