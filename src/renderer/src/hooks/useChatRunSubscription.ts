import { useEffect } from 'react'
import { v4 as uuid } from 'uuid'
import { IPC_EVENTS } from '../../../shared/constants'
import { useChatStore, type LiveIter, type ChatLiveState, type RunStatus } from '../store/chat.store'
import type { Message, ToolStep, QueueItemMeta } from '../../../shared/types'

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
  tokenBuf: string           // time-based throttle буфер для text-токенов
  thinkingBuf: string        // time-based throttle буфер для thinking-токенов
  flushTimer: ReturnType<typeof setTimeout> | null  // id setTimeout для батч-флеша
  streamMsgId: string | null // msgId текущего стрима (для матчинга step→итерация)
  toolProgress: Record<string, { stage: string; detail?: string; sessionId?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }>; ts: number }>
  /** Live-маппинг саб-агентов текущего стрима (для мгновенной карточки). */
  spawnedAgents: Array<{ agentId: string; callId?: string; task: string; msgId: string; model?: string; ts: number }>
  retry: { attempt: number; maxAttempts?: number; reason: string; waitSec?: number } | null
  lastError: string | null
}

const buffers = new Map<string, ChatBuffers>()

// Отложенные user-сообщения для queued-запросов. Ключ — assistantMsgId
// (будущий id ответа), значение — user-сообщение. Когда queued-запрос
// стартует (статус 'running' с этим msgId), сообщение достаётся отсюда и
// addMessage'ится в чат — это сохраняет порядок: user1 → assistant1 →
// user2 → assistant2, вместо user1 user2 user3 → assistant1 assistant2 assistant3.
const pendingUserMsgs = new Map<string, Message>()

/**
 * Регистрирует user-сообщение как отложенное для queued-запроса.
 * Вызывается из ChatPage.handleSend когда chat:send вернул queued: true.
 * Сообщение будет добавлено в чат когда запрос стартует (статус 'running').
 */
export function enqueuePendingUserMsg(assistantMsgId: string, userMsg: Message) {
  pendingUserMsgs.set(assistantMsgId, userMsg)
}

/**
 * Убирает отложенное user-сообщение (например, при cancel из очереди).
 * Вызывается из QueuePanel при remove элемента очереди.
 */
export function removePendingUserMsg(assistantMsgId: string) {
  pendingUserMsgs.delete(assistantMsgId)
}

function getBuf(chatId: string): ChatBuffers {
  let buf = buffers.get(chatId)
  if (!buf) {
    buf = {
      text: '', thinking: '', thinkingMs: undefined, isThinkingLive: false,
      iters: [], steps: [], todo: [], agentStatus: null, rateLimitSec: 0,
      tokenBuf: '', thinkingBuf: '', flushTimer: null, streamMsgId: null,
      toolProgress: {}, retry: null, lastError: null, spawnedAgents: [],
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
  buf.thinkingBuf = ''
  buf.retry = null
  buf.lastError = null
  buf.spawnedAgents = []
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
    retry: null,
    lastError: null,
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
      bufferedRetry: { attempt: number; maxAttempts?: number; reason: string; waitSec?: number } | null
      meta: QueueItemMeta | null
    } | null
    if (!live || !live.isRunning) {
      // В main нет активного запуска — чистим локальный буфер если был
      buffers.delete(chatId)
      useChatStore.getState().clearLiveState(chatId)
      useChatStore.getState().setActiveRun(chatId, null)
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
      retry: live.bufferedRetry ?? null,
      isTyping: true,
      isAgentRunning: buf.iters.length > 0 || buf.steps.length > 0,
    })
    // Восстанавливаем meta активного запуска для UI-панели очереди.
    if (live.meta) useChatStore.getState().setActiveRun(chatId, live.meta)
    return true
  } catch {
    return false
  }
}

// ── Side chat helpers ──────────────────────────────────────────────────
// Side-чат имеет chatId = 'sidechat:'+parentChatId. События стриминга
// приходят с этим chatId — нужно маршрутизировать их в sideChatByChat
// вместо обычных messages/liveByChat.
const SIDE_PREFIX = 'sidechat:'
function isSideChat(chatId: string | undefined | null): boolean {
  return typeof chatId === 'string' && chatId.startsWith(SIDE_PREFIX)
}
function sideParent(chatId: string): string { return chatId.slice(SIDE_PREFIX.length) }

// Aux-окна (spotlight/overlay/voice) грузят тот же renderer bundle и
// выполняют полный App.tsx со всеми эффектами. Но стрим-события чатов
// (chat:stream-token и др.) адресованы только главному окну — получать
// их здесь бессмысленно и вызывает спам в консоль (isSideChat на каждом
// токене) + лишнюю нагрузку. Гейт по hash маршрута.
function isAuxWindow(): boolean {
  const hash = window.location.hash.replace('#/', '')
  return hash === 'spotlight' || hash === 'overlay' || hash === 'voice'
}

/**
 * Инициализация live-буфера для side-чата. Вызывается из SideChatPanel
 * перед отправкой сообщения. Аналог initChatSend, но пишет в sideChatByChat.
 */
export function initSideChatSend(parentChatId: string) {
  const sideChatId = SIDE_PREFIX + parentChatId
  if (buffers.has(sideChatId)) return
  const buf = getBuf(sideChatId)
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
  buf.thinkingBuf = ''
  buf.retry = null
  buf.lastError = null
  useChatStore.getState().hydrateSideLiveState(parentChatId, {
    msgId: 'streaming-pending',
    text: '',
    thinking: '',
    isThinkingLive: false,
    iters: [],
    steps: [],
    todo: [],
    agentStatus: null,
    rateLimitSec: 0,
    retry: null,
    lastError: null,
    isTyping: true,
    isAgentRunning: false,
  })
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
    // Aux-окна не обрабатывают стрим чатов — см. isAuxWindow().
    if (isAuxWindow()) return

    // ── Time-based throttle (50мс / ~20fps) ────────────────────────────
    // Раньше использовался requestAnimationFrame (~16мс / 60fps): каждый
    // кадр ре-парсил ВЕСЬ накопленный markdown (ReactMarkdown + SyntaxHighlighter),
    // стоимость росла O(n) на кадр → main thread блокировался на длинных
    // ответах → падение FPS всего приложения. 50мс визуально неотличимо от
    // 60fps (токены и так приходят кусками), но ре-парс в 3 раза реже.
    // Финальный flush при done/tool_call — синхронный, ничего не теряется.
    const FLUSH_MS = 50

    const flushTokens = (chatId: string) => {
      const buf = getBuf(chatId)
      buf.flushTimer = null
      const partial: Partial<ChatLiveState> = {}
      if (buf.tokenBuf) {
        buf.text += buf.tokenBuf
        buf.tokenBuf = ''
        partial.text = buf.text
      }
      if (buf.thinkingBuf) {
        buf.thinking += buf.thinkingBuf
        buf.thinkingBuf = ''
        partial.thinking = buf.thinking
      }
      if (Object.keys(partial).length > 0) {
        liveSet(chatId, partial)
      }
    }

    const scheduleFlush = (chatId: string) => {
      const buf = getBuf(chatId)
      if (buf.flushTimer !== null) return
      buf.flushTimer = setTimeout(() => flushTokens(chatId), FLUSH_MS)
    }

    // ── Side-chat-aware wrappers ──────────────────────────────────────
    // Детектят 'sidechat:' префикс и маршрутизируют в sideChatByChat
    // вместо обычных messages/liveByChat.
    const liveSet = (chatId: string, partial: Partial<ChatLiveState>) => {
      if (isSideChat(chatId)) {
        useChatStore.getState().setSideLiveState(sideParent(chatId), partial)
      } else {
        useChatStore.getState().setLiveState(chatId, partial)
      }
    }
    const liveClear = (chatId: string) => {
      if (isSideChat(chatId)) {
        useChatStore.getState().clearSideLiveState(sideParent(chatId))
      } else {
        useChatStore.getState().clearLiveState(chatId)
      }
    }

    // Синхронный drain буферов в buf.text/buf.thinking БЕЗ store-обновления.
    // Возвращает partial для последующего батч-коммита. Используется в
    // tool_call/tool_call_pending перед захватом text/thinking в итерацию,
    // чтобы ничего не потерялось (точное поведение как раньше).
    const drainBufs = (chatId: string): Partial<ChatLiveState> => {
      const buf = getBuf(chatId)
      const partial: Partial<ChatLiveState> = {}
      if (buf.tokenBuf) {
        buf.text += buf.tokenBuf
        buf.tokenBuf = ''
        partial.text = buf.text
      }
      if (buf.thinkingBuf) {
        buf.thinking += buf.thinkingBuf
        buf.thinkingBuf = ''
        partial.thinking = buf.thinking
      }
      return partial
    }

    // Промоут msgId из 'streaming-pending' → реальный id — один раз.
    // Раньше setLiveState({ msgId, isTyping: true }) звался на КАЖДЫЙ токен,
    // хотя значения не меняются после первого. Теперь только при промоуте.
    const promoteMsgId = (chatId: string, msgId: string) => {
      const buf = getBuf(chatId)
      if (buf.streamMsgId === 'streaming-pending') {
        buf.streamMsgId = msgId
        liveSet(chatId, { msgId, isTyping: true })
      }
    }

    // CHAT_STREAM_TOKEN — токены ответа и reasoning
    const offToken = window.syntee.on(IPC_EVENTS.CHAT_STREAM_TOKEN, (data: {
      chatId: string; msgId: string; token?: string
      thinkingToken?: string; thinkingDone?: boolean; thinkingMs?: number
    }) => {
      if (!data || !data.chatId) return
      const buf = getBuf(data.chatId)
      buf.streamMsgId = data.msgId

      if (data.thinkingToken) {
        const tok = typeof data.thinkingToken === 'string' ? data.thinkingToken : String(data.thinkingToken ?? '')
        buf.thinkingBuf += tok
        const wasLive = buf.isThinkingLive
        buf.isThinkingLive = true
        // Промоут msgId один раз (thinking приходит раньше text).
        if (buf.streamMsgId === 'streaming-pending') {
          promoteMsgId(data.chatId, data.msgId)
        }
        // Пушим isThinkingLive=true в store на каждом переходе false → true,
        // а не только при первом промоуте msgId. Иначе в agent-режиме (тулы,
        // итерации) после первого thinkingDone флаг остаётся false в store,
        // и блок размышлений не раскрывается для последующих раундов.
        if (!wasLive) {
          liveSet(data.chatId, { isThinkingLive: true })
        }
        scheduleFlush(data.chatId)
        return
      }
      if (data.thinkingDone) {
        buf.thinkingMs = data.thinkingMs
        buf.isThinkingLive = false
        liveSet(data.chatId, {
          thinkingMs: data.thinkingMs,
          isThinkingLive: false,
        })
        return
      }
      if (data.token) {
        // Промоут msgId один раз (только при первом text-токене).
        if (buf.streamMsgId === 'streaming-pending') {
          promoteMsgId(data.chatId, data.msgId)
        }
        // Пришли новые токены — ретрай/ошибка больше не актуальны,
        // сбрасываем чтобы индикатор не показывал «повтор 3/5» после
        // успешного восстановления.
        if (buf.retry || buf.lastError) {
          buf.retry = null
          buf.lastError = null
          liveSet(data.chatId, { retry: null, lastError: null })
        }
        buf.tokenBuf += data.token
        scheduleFlush(data.chatId)
      }
    })

    // CHAT_STREAM_DONE — финал стрима, сохранение в БД
    const offDone = window.syntee.on(IPC_EVENTS.CHAT_STREAM_DONE, (data: { chatId: string; message: Message }) => {
      console.log('[chat-flow] CHAT_STREAM_DONE chatId=%s msgId=%s content=%d chars steps=%d',
        data.chatId, data.message.id, (data.message.content || '').length, data.message.toolSteps?.length ?? 0)
      const buf = buffers.get(data.chatId)
      // Синхронный финальный flush — ничего не теряется.
      if (buf?.flushTimer !== null && buf?.flushTimer !== undefined) {
        clearTimeout(buf.flushTimer)
      }
      if (buf) {
        buf.tokenBuf = ''
        buf.thinkingBuf = ''
        buf.flushTimer = null
      }
      if (buf?.rateLimitCountdown) {
        clearInterval(buf.rateLimitCountdown)
      }
      buffers.delete(data.chatId)

      if (isSideChat(data.chatId)) {
        const parentId = sideParent(data.chatId)
        liveClear(data.chatId)
        useChatStore.getState().addSideMessage(parentId, data.message)
        useChatStore.getState().setSideRunStatus(parentId, 'done')
      } else {
        // finalizeStreamMessage объединяет clearLiveState + addMessage в один
        // set() — устраняет race (live-пузырь исчезает, а сообщение ещё не
        // добавлено → кратковременная пустота в конце чата).
        useChatStore.getState().finalizeStreamMessage(data.chatId, data.message)
        window.syntee.chat.getAll().then((all) => useChatStore.getState().setChats(all))
        // ── ChangesBadge: загружаем изменения последнего turn'а ──
        // Fire-and-forget: если в этом turn'е были правки файлов — бейдж
        // появится над инпутом. При ошибке IPC — просто не появится.
        window.syntee.chat.getLastTurnChanges?.(data.chatId).then((changes) => {
          if (changes) useChatStore.getState().setLastTurnChanges(data.chatId, changes)
        }).catch(() => {})
      }
    })

    // CHAT_STREAM_ERROR — ошибка/остановка. Раньше для основного чата
    // тут был только liveClear без setRunStatus — сайдбар не показывал ✗,
    // и ошибка пропадала невидимой (пользователь видел "ожидание ответа"
    // пока live-пузырь не схлопнется). Теперь ставим runStatus='error' с
    // текстом ошибки → бейдж ✗ в сайдбаре + сохраняется для показа.
    const offError = window.syntee.on(IPC_EVENTS.CHAT_STREAM_ERROR, (data: { chatId: string; error: string }) => {
      console.log('[chat-flow] CHAT_STREAM_ERROR chatId=%s error=%s', data.chatId, data.error.slice(0, 200))
      const buf = buffers.get(data.chatId)
      if (buf?.flushTimer !== null && buf?.flushTimer !== undefined) {
        clearTimeout(buf.flushTimer)
      }
      if (buf?.rateLimitCountdown) clearInterval(buf.rateLimitCountdown)
      liveClear(data.chatId)
      buffers.delete(data.chatId)
      if (isSideChat(data.chatId)) {
        useChatStore.getState().setSideRunStatus(sideParent(data.chatId), 'error')
      } else {
        // Ставим error-статус с текстом — сайдбар покажет ✗ и при наведении
        // текст. Раньше основной чат вообще не получал error-статус здесь.
        useChatStore.getState().setRunStatus(data.chatId, 'error', data.error)
      }
    })

    // CHAT_RUN_STATUS — статус запуска для сайдбара
    const offRunStatus = window.syntee.on(IPC_EVENTS.CHAT_RUN_STATUS, (data: {
      chatId: string; status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
      msgId?: string; error?: string; ts: number
    }) => {
      // Side chat: обновляем только runStatus, без логики очереди/pending.
      if (isSideChat(data.chatId)) {
        const parentId = sideParent(data.chatId)
        useChatStore.getState().setSideRunStatus(parentId, data.status as RunStatus)
        if (data.status === 'done' || data.status === 'error' || data.status === 'cancelled') {
          const buf = buffers.get(data.chatId)
          if (buf?.flushTimer !== null && buf?.flushTimer !== undefined) clearTimeout(buf.flushTimer)
          if (buf?.rateLimitCountdown) clearInterval(buf.rateLimitCountdown)
          // Defensive cleanup (см. аналог в основной ветке ниже).
          liveClear(data.chatId)
          buffers.delete(data.chatId)
        }
        return
      }
      useChatStore.getState().setRunStatus(data.chatId, data.status, data.error, data.msgId)
      // Управляем activeRunByChat для UI-панели очереди.
      // На 'running' — асинхронно подтягиваем meta из main (там она уже установлена).
      // На терминальных — сбрасываем activeRun.
      if (data.status === 'running') {
        // ── ChangesBadge: сбрасываем бейдж при старте нового запроса ──
        useChatStore.getState().setLastTurnChanges(data.chatId, null)
        // Если это старт queued-запроса — достаём отложенное user-сообщение
        // и добавляем его в чат + инициализируем live-буфер. Это сохраняет
        // порядок диалога: предыдущий ответ уже добавлен (CHAT_STREAM_DONE),
        // затем это user-сообщение, затем live-пузырь нового ответа.
        const pending = data.msgId ? pendingUserMsgs.get(data.msgId) : undefined
        if (pending) {
          pendingUserMsgs.delete(data.msgId!)
          useChatStore.getState().addMessage(pending)
          initChatSend(data.chatId)
        }
        window.syntee.chat.getLiveState(data.chatId).then((live: { meta?: QueueItemMeta | null } | null) => {
          if (live?.meta) useChatStore.getState().setActiveRun(data.chatId, live.meta)
        }).catch(() => {})
      } else if (data.status === 'done' || data.status === 'error' || data.status === 'cancelled') {
        useChatStore.getState().setActiveRun(data.chatId, null)
        const buf = buffers.get(data.chatId)
        if (buf?.flushTimer !== null && buf?.flushTimer !== undefined) clearTimeout(buf.flushTimer)
        if (buf?.rateLimitCountdown) clearInterval(buf.rateLimitCountdown)
        // Defensive cleanup: CHAT_STREAM_DONE/CHAT_STREAM_ERROR обычно уже
        // почистили live+buffers, но если событие потеряно/запаздывает/
        // пришло не в том порядке (например при user-initiated stop, когда
        // бэк шлёт 'done' из sendDone, а затем 'cancelled' из stopRun),
        // терминальный статус сам сбрасывает isTyping/isThinkingLive/msgId.
        // Идемпотентно — delete на отсутствующем ключе это noop.
        liveClear(data.chatId)
        buffers.delete(data.chatId)
      }
    })

    // CHAT_QUEUE_UPDATED — снапшот очереди ожидающих запросов chatId.
    // Эмитится main-процессом при add/remove/reorder/drain. Обновляем store
    // для UI-панели очереди.
    const offQueue = window.syntee.on(IPC_EVENTS.CHAT_QUEUE_UPDATED, (data: {
      chatId: string; queue: QueueItemMeta[]; ts: number
    }) => {
      useChatStore.getState().setQueue(data.chatId, data.queue)
    })

    // CHAT_FILES_RESTORED — undo правок файлов (из ChangesBadge).
    // Сбрасываем lastTurnChanges — бейдж исчезает после undo.
    const offFilesRestored = window.syntee.on(IPC_EVENTS.CHAT_FILES_RESTORED, (data: { chatId: string }) => {
      useChatStore.getState().setLastTurnChanges(data.chatId, null)
    })

    // CHAT_REWOUND — откат сессии (из правой панели или кнопки на сообщении).
    // Перезагружаем messages из БД — main уже всё удалил/вставил.
    // Также сбрасываем live state — иначе isTyping/isAgentRunning могут
    // остаться true и input bar будет disabled после отката.
    const offRewound = window.syntee.on(IPC_EVENTS.CHAT_REWOUND, async (data: { chatId: string; userMessageId: string }) => {
      liveClear(data.chatId)
      const buf = buffers.get(data.chatId)
      if (buf?.flushTimer !== null && buf?.flushTimer !== undefined) {
        clearTimeout(buf.flushTimer)
      }
      if (buf?.rateLimitCountdown) clearInterval(buf.rateLimitCountdown)
      buffers.delete(data.chatId)
      const msgs = await window.syntee.chat.getMessages(data.chatId) as Message[]
      useChatStore.getState().setMessages(msgs)
    })

    // RATE_LIMIT — ожидание перед retry
    const offRateLimit = window.syntee.on(IPC_EVENTS.RATE_LIMIT, (data: { waitSec: number; chatId?: string }) => {
      if (!data.chatId) return
      const buf = getBuf(data.chatId)
      buf.rateLimitSec = data.waitSec
      liveSet(data.chatId, { rateLimitSec: data.waitSec })
      let remaining = data.waitSec
      if (buf.rateLimitCountdown) clearInterval(buf.rateLimitCountdown)
      buf.rateLimitCountdown = setInterval(() => {
        remaining -= 1
        if (remaining <= 0) {
          clearInterval(buf.rateLimitCountdown!)
          buf.rateLimitSec = 0
          liveSet(data.chatId, { rateLimitSec: 0 })
        } else {
          buf.rateLimitSec = remaining
          liveSet(data.chatId, { rateLimitSec: remaining })
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
        liveSet(data.chatId, { msgId: data.msgId })
      }
      if (data.msgId && buf.streamMsgId && data.msgId !== buf.streamMsgId) return
      buf.todo = data.items
      liveSet(data.chatId, { todo: data.items })
    })

    // agent:status — текущий статус агента
    const offStatus = window.syntee.on('agent:status', (data: { msgId: string; chatId: string; text: string }) => {
      if (!data.chatId) return
      const buf = getBuf(data.chatId)
      buf.agentStatus = data.text
      liveSet(data.chatId, { agentStatus: data.text })
    })

    // agent:retry — структурированный ретрай для UI-счётчика «повтор 3/5».
    // Не затирается следующим onStatus (в отличие от agent_status) —
    // хранится отдельно в live-стейте как retry. Сбрасывается в null
    // при успехе (новый токен/шаг) в обработчиках CHAT_STREAM_TOKEN/step.
    const offRetry = window.syntee.on('agent:retry', (data: {
      msgId: string; chatId: string
      attempt: number; maxAttempts?: number; reason: string; waitSec?: number
    }) => {
      if (!data.chatId) return
      console.log('[chat-flow] agent:retry chatId=%s attempt=%d/%s reason=%s waitSec=%s',
        data.chatId, data.attempt, data.maxAttempts ?? '?', data.reason, data.waitSec ?? '?')
      const buf = getBuf(data.chatId)
      buf.retry = { attempt: data.attempt, maxAttempts: data.maxAttempts, reason: data.reason, waitSec: data.waitSec }
      // При rate_limit persist lastError как причину для индикатора
      if (data.reason === 'rate_limit') {
        buf.lastError = `Лимит запросов (повтор ${data.attempt}${data.maxAttempts ? `/${data.maxAttempts}` : ''})`
      } else {
        buf.lastError = `Ошибка сети (повтор ${data.attempt}${data.maxAttempts ? `/${data.maxAttempts}` : ''})`
      }
      liveSet(data.chatId, { retry: buf.retry, lastError: buf.lastError })
    })

    // agent:tool_progress — live progress для долгих тулов (get_fast_context,
    // run_command, process_attachments). Эфемерный — не персистится в БД.
    const offToolProgress = window.syntee.on('agent:tool_progress', (data: {
      msgId: string; chatId: string; toolName: string; stage: string
      detail?: string; sessionId?: string; filesProcessed?: number; filesTotal?: number
      filesFound?: Array<{ path: string; score: number; why: string }>
    }) => {
      if (!data.chatId) return
      const buf = getBuf(data.chatId)
      // Усваиваем реальный msgId из первого события (как в offToken/offStep).
      // process_attachments стримит ДО первого токена, поэтому именно тут
      // промоутим 'streaming-pending' → реальный msgId + включаем isTyping,
      // чтобы showLiveBubble стал true и блок отрисовался немедленно.
      // ВАЖНО: buf.streamMsgId может быть null (не только 'streaming-pending'),
      // если chat:send ещё не вернулся из main (runChatSend await-ит
      // processAttachmentsAndStream, и initChatSend не успел вызваться в
      // renderer). Трактуем null так же как 'streaming-pending'.
      if ((!buf.streamMsgId || buf.streamMsgId === 'streaming-pending') && data.msgId) {
        buf.streamMsgId = data.msgId
        liveSet(data.chatId, { msgId: data.msgId, isTyping: true })
      }
      if (data.msgId && buf.streamMsgId && data.msgId !== buf.streamMsgId) return
      buf.toolProgress = {
        ...buf.toolProgress,
        [data.toolName]: {
          stage: data.stage,
          detail: data.detail,
          sessionId: data.sessionId,
          filesProcessed: data.filesProcessed,
          filesTotal: data.filesTotal,
          filesFound: data.filesFound,
          ts: Date.now(),
        },
      }
      liveSet(data.chatId, { toolProgress: { ...buf.toolProgress } })
    })

    // agent:spawn — main эмитит это СРАЗУ при получении spawn_agent от
    // worker'а, до запуска суб-агента. Renderer фиксирует маппинг
    // {agentId, callId, task} в live.spawnedAgents — MessageBubble матчит
    // его с live-шагом tool_call spawn_agent (по callId, fallback — по task)
    // и мгновенно рисует карточку саб-агента, не дожидаясь tool_result.
    const offSpawn = window.syntee.on('agent:spawn', (data: {
      agentId: string; task: string; callId?: string
      msgId: string; chatId: string; model?: string; ts: number
    }) => {
      if (!data.chatId) return
      const buf = getBuf(data.chatId)
      // Усваиваем реальный msgId из первого события (как в offStep).
      if ((!buf.streamMsgId || buf.streamMsgId === 'streaming-pending') && data.msgId) {
        buf.streamMsgId = data.msgId
        liveSet(data.chatId, { msgId: data.msgId, isTyping: true })
      }
      if (data.msgId && buf.streamMsgId && data.msgId !== buf.streamMsgId) return
      // Не дублируем запись (agent:spawn может теоретически прийти дважды).
      if (buf.spawnedAgents.some(a => a.agentId === data.agentId)) return
      buf.spawnedAgents = [...buf.spawnedAgents, {
        agentId: data.agentId,
        callId: data.callId,
        task: data.task,
        msgId: data.msgId,
        model: data.model,
        ts: data.ts,
      }]
      liveSet(data.chatId, { spawnedAgents: [...buf.spawnedAgents] })
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
        liveSet(chatId, { msgId: step.msgId })
      }
      if (step.msgId && step.msgId !== buf.streamMsgId) return

      // ── Батчинг setLiveState ──────────────────────────────────────────
      // Раньше каждая ветка звала 2-4 последовательных setLiveState (commitIters,
      // commitSteps, reset, drain-text) — каждый триггерил отдельный ре-рендер.
      // Теперь ОДИН setLiveState на шаг с финальным состоянием. Логика
      // группировки/матчинга не изменилась — только количество store-обновлений.
      if (step.type === 'tool_call_pending') {
        // Синхронный drain pending-токенов в buf.text/buf.thinking перед
        // захватом в итерацию (чтобы ничего не потерялось).
        if (buf.flushTimer !== null) { clearTimeout(buf.flushTimer); buf.flushTimer = null }
        drainBufs(chatId)

        const pendingStep: ToolStep = {
          id: uuid(), type: 'tool_call' as const,
          toolName: step.toolName, toolArgs: undefined,
          content: step.content, success: undefined,
          timestamp: Date.now(), imageUrl: undefined,
          callId: step.callId,
          serverName: step.serverName,
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
        // ОДИН setLiveState вместо двух (commitIters + reset).
        liveSet(chatId, {
          iters: [...buf.iters],
          isAgentRunning: true,
          isTyping: true,
          text: '',
          thinking: '',
          thinkingMs: undefined,
          isThinkingLive: false,
        })
      } else if (step.type === 'tool_call') {
        // Синхронный drain pending-токенов перед захватом в итерацию.
        if (buf.flushTimer !== null) { clearTimeout(buf.flushTimer); buf.flushTimer = null }
        drainBufs(chatId)

        const newStep: ToolStep = {
          id: uuid(), type: 'tool_call' as const,
          toolName: step.toolName, toolArgs: step.toolArgs,
          content: step.content, success: step.success,
          timestamp: Date.now(), imageUrl: step.imageUrl,
          callId: step.callId,
          serverName: step.serverName,
        }
        buf.steps.push(newStep)

        // Заменяем pending-карточку in-place. Сначала по pendingCallId
        // (точный ключ), затем — если pendingCallId не совпал — по
        // toolName в последней итерации, чтобы не плодить дубль
        // (раньше при несовпадении создавалась вторая итерация, а
        // pending-карточка оставалась без результата → бесконечный спиннер).
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
        if (!replacedPending && step.toolName) {
          // Fallback: pending-карточка по toolName в последней итерации
          // (pending-шаги не имеют реального callId, только pending-*).
          const last = buf.iters[buf.iters.length - 1]
          if (last) {
            const stepIdx = last.steps.findIndex(s =>
              s.type === 'tool_call' && s.toolName === step.toolName && s.pending
            )
            if (stepIdx !== -1) {
              const nextSteps = [...last.steps]
              nextSteps[stepIdx] = newStep
              buf.iters = [...buf.iters.slice(0, -1), { ...last, steps: nextSteps }]
              replacedPending = true
            }
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
        // ОДИН setLiveState вместо четырёх (drain-text + commitIters + commitSteps + reset).
        liveSet(chatId, {
          iters: [...buf.iters],
          steps: [...buf.steps],
          isAgentRunning: true,
          isTyping: true,
          text: '',
          thinking: '',
          thinkingMs: undefined,
          isThinkingLive: false,
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
        buf.steps.push(newStep)
        if (buf.iters.length === 0) {
          liveSet(chatId, { steps: [...buf.steps] })
          return
        }
        const iters = buf.iters
        // Матчим result в правильную итерацию. Раньше дефолтом была
        // последняя итерация (targetIterIdx = iters.length - 1) — при
        // результате без callId (блок/отказ/MCP-ошибка) и дубликате
        // toolName в нескольких итерациях findIndex брал первую, а
        // дефолт оставлял последнюю → рассинхрон: реальный вызов без
        // result → бесконечный спиннер. Теперь ищем самую старую
        // resultless-итерацию с тем же toolName, иначе — самую старую
        // resultless вообще (чтобы orphan-результат не повис).
        let targetIterIdx = -1
        if (step.callId) {
          const idx = iters.findIndex(iter =>
            iter.steps.some(s => s.type === 'tool_call' && s.callId === step.callId)
          )
          if (idx !== -1) targetIterIdx = idx
        }
        if (targetIterIdx === -1 && step.toolName) {
          // Самая старая итерация с toolName-вызовом и без результата
          const idx = iters.findIndex(iter =>
            iter.steps.some(s => s.type === 'tool_call' && s.toolName === step.toolName) &&
            !iter.steps.some(s => s.type === 'tool_result')
          )
          if (idx !== -1) targetIterIdx = idx
        }
        if (targetIterIdx === -1) {
          // Самая старая итерация без любого результата — покрывает
          // orphan-результаты (_error/_limit без парного tool_call).
          const idx = iters.findIndex(iter =>
            !iter.steps.some(s => s.type === 'tool_result')
          )
          if (idx !== -1) targetIterIdx = idx
        }
        if (targetIterIdx === -1) {
          // Нет подходящей итерации — создаём синтетическую, чтобы
          // orphan-результат не потерялся (зеркало buildIterations).
          buf.iters = [...iters, {
            textBefore: '',
            thinking: undefined,
            thinkingMs: undefined,
            steps: [
              {
                id: uuid(), type: 'tool_call' as const,
                toolName: step.toolName, toolArgs: undefined,
                content: step.toolName ?? 'tool', success: undefined,
                timestamp: Date.now(), callId: step.callId,
                pending: false,
              } as ToolStep,
              newStep,
            ],
          }]
        } else {
          iters[targetIterIdx] = { ...iters[targetIterIdx], steps: [...iters[targetIterIdx].steps, newStep] }
        }
        // ОДИН setLiveState вместо двух (commitIters + commitSteps).
        // При успешном результате тула сбрасываем retry/lastError —
        // ретрай/ошибка больше не актуальны.
        if (step.success && (buf.retry || buf.lastError)) {
          buf.retry = null
          buf.lastError = null
          liveSet(chatId, {
            iters: [...buf.iters],
            steps: [...buf.steps],
            retry: null,
            lastError: null,
            isAgentRunning: true,
            isTyping: true,
          })
        } else {
          liveSet(chatId, {
            iters: [...buf.iters],
            steps: [...buf.steps],
            isAgentRunning: true,
            isTyping: true,
          })
        }
      }
    })

    return () => {
      offToken(); offDone(); offError(); offRunStatus(); offQueue(); offFilesRestored(); offRewound(); offRateLimit(); offTodo(); offStatus(); offRetry(); offStep(); offToolProgress(); offSpawn()
    }
  }, [])
}
