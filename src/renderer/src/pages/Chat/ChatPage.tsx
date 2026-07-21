import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useVirtualizer } from '@tanstack/react-virtual'
import { v4 as uuid } from 'uuid'
import { useContextCounter } from '../../hooks/useContextCounter'
import TitleBar from '../../components/layout/TitleBar/TitleBar'
import Sidebar from '../../components/layout/Sidebar/Sidebar'
import { playDoneSound } from '../../utils/sounds'
import MessageBubble from '../../components/ui/MessageBubble/MessageBubble'
import ChatInput from '../../components/ui/ChatInput/ChatInput'
import LiveTodoBar from '../../components/ui/LiveTodoBar/LiveTodoBar'
import AnimatedBackground from '../../components/ui/AnimatedBackground/AnimatedBackground'
import AppIcon from '../../components/ui/AppIcon/AppIcon'
import ToastContainer, { useToast } from '../../components/ui/Toast/Toast'
import ToolChain from '../../components/ui/ToolChain/ToolChain'
import ChatSearch from '../../components/ui/ChatSearch/ChatSearch'
import { useChatStore } from '../../store/chat.store'
import { parseSlashCommand } from '../../../../shared/slashCommands'
import { IPC_EVENTS } from '../../../../shared/constants'
import type { Chat, Message, ToolOutputMode, Project } from '../../../../shared/types'
import './ChatPage.css'

export default function ChatPage({ embedded = false }: { embedded?: boolean }) {
  const {
    chats, currentChatId, messages, isTyping, streamingText,
    setChats, setCurrentChat, setMessages, addMessage,
    appendStreamToken, clearStream, setTyping, pinMessage,
    isIncognito, toggleIncognito,
    activeMode, setActiveMode,
    projects, setProjects, activeProjectId, setActiveProject,
  } = useChatStore()

  const { add: toast } = useToast()
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const chatInputWrapRef = useRef<HTMLDivElement>(null)
  const streamMsgIdRef = useRef<string | null>(null)
  const [streamMsgId, setStreamMsgId] = useState<string | null>(null)
  const [rateLimitSec, setRateLimitSec] = useState(0)
  const [toolOutputMode, setToolOutputMode] = useState<ToolOutputMode>('normal')
  const [isAgentRunning, setIsAgentRunning] = useState(false)
  const [isLoadingMessages, setIsLoadingMessages] = useState(false)
  const [showSkeleton, setShowSkeleton] = useState(false)
  // §4.3 — видимый чек-лист плана (todo list)
  const [liveTodo, setLiveTodo] = useState<Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>>([])
  const isInitialScrollRef = useRef(true)
  const skeletonTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Агентские итерации: [{textBefore, thinking?, thinkingMs?, steps[]}]
  // textBefore — текст который AI написал ДО вызова тулов в этой итерации
  // thinking — reasoning блок этой итерации (на своей позиции)
  // steps — все tool_call+tool_result этой итерации
  type LiveIter = { textBefore: string; thinking?: string; thinkingMs?: number; steps: import('../../components/ui/ToolChain/ToolChain').ToolStep[] }
  const [liveIters, setLiveIters] = useState<LiveIter[]>([])
  // Ref для синхронного доступа — setState батчится, ref обновляется сразу
  const liveItersRef = useRef<LiveIter[]>([])
  // текст ПОСЛЕ последних тулов (финальный ответ после выполнения)
  const [liveTextAfter, setLiveTextAfter] = useState('')
  const liveTextAfterRef = useRef('')
  useEffect(() => { liveTextAfterRef.current = liveTextAfter }, [liveTextAfter])
  // Pending thinking — накопленное reasoning текущего раунда, ждёт прикрепления к итерации
  const pendingThinkingRef = useRef('')
  const pendingThinkingMsRef = useRef<number | undefined>(undefined)

  // Throttle буфер для токенов — батчим через RAF вместо setState на каждый токен
  const tokenBufRef = useRef('')
  const rafRef = useRef<number | null>(null)
  const flushTokens = useCallback(() => {
    rafRef.current = null
    if (!tokenBufRef.current) return
    const chunk = tokenBufRef.current
    tokenBufRef.current = ''
    setLiveTextAfter(prev => prev + chunk)
    liveTextAfterRef.current = liveTextAfterRef.current + chunk
    appendStreamToken(chunk)
    // Автоскролл при стриминге — только если пользователь не ушёл вверх
    if (autoScrollRef.current) {
      const el = scrollContainerRef.current
      if (el) el.scrollTop = el.scrollHeight - el.clientHeight
    }
  }, [])

  const scheduleFlush = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(flushTokens)
  }, [flushTokens])
  // liveSteps оставляем только для финального сохранения в БД
  const [liveSteps, setLiveSteps] = useState<import('../../components/ui/ToolChain/ToolChain').ToolStep[]>([])
  const [agentStatus, setAgentStatus] = useState<string | null>(null)
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatchIds, setSearchMatchIds] = useState<string[]>([])
  const [replyTo, setReplyTo] = useState<Message[]>([])
  const [selectionPopup, setSelectionPopup] = useState<{ x: number; y: number; text: string } | null>(null)
  const [inputText, setInputText] = useState('')
  const [planningMode, setPlanningMode] = useState(false)
  const [imageMode, setImageMode] = useState(false)

  // Настройка показа счётчика контекста
  const [showContextRing, setShowContextRing] = useState(true)
  const [mainModelId, setMainModelId] = useState('claude-sonnet-4-6')
  const [reasoningValue, setReasoningValue] = useState('')

  const handleReasoningChange = (value: string) => {
    setReasoningValue(value)
    window.syntee.settings.set('reasoningValue', value).catch(() => {})
  }

  // Смена main-модели из селектора над инпутом. Обновляем назначение через
  // IPC и локальное состояние (mainModelId нужно для ReasoningSelector и
  // контекст-счётчика).
  const handleMainModelChange = async (modelId: string, providerId: string) => {
    try {
      await window.syntee.models.setAssignment({ role: 'main', modelId, providerId })
      setMainModelId(modelId)
    } catch (e) {
      console.error('[ChatPage] setAssignment error', e)
    }
  }

  useEffect(() => {
    window.syntee.settings.get('showContextRing').then((v: unknown) => {
      if (v !== null && v !== undefined) setShowContextRing(v as boolean)
    }).catch(() => {})
    window.syntee.settings.get('modelAssignments').then((v: unknown) => {
      if (Array.isArray(v)) {
        const main = (v as Array<{ role: string; modelId: string }>).find(a => a.role === 'main')
        if (main) setMainModelId(main.modelId)
      }
    }).catch(() => {})
    window.syntee.settings.get('reasoningValue').then((v: unknown) => {
      if (typeof v === 'string' && v) setReasoningValue(v)
    }).catch(() => {})
  }, [])

  // Счётчик контекста
  const contextInfo = useContextCounter({
    chatId: currentChatId || '',
    currentInput: inputText,
    modelId: mainModelId,
    incognito: isIncognito,
    enabled: showContextRing && !isIncognito,
    messageCount: messages.length,
  })

  // Selection reply — выделил текст в чате → popup с кнопкой Reply
  useEffect(() => {
    let lastFireTime = 0
    const handleMouseUp = (e: MouseEvent) => {
      // throttle: не чаще раза в 100мс
      const now = Date.now()
      if (now - lastFireTime < 100) return
      lastFireTime = now

      const sel = window.getSelection()
      const text = sel?.toString().trim()
      if (!text || text.length < 2) { setSelectionPopup(null); return }
      const anchor = sel?.anchorNode?.parentElement
      if (!anchor?.closest('.chat-messages')) { setSelectionPopup(null); return }
      const range = sel?.getRangeAt(0)
      const rect = range?.getBoundingClientRect()
      if (!rect) return
      setSelectionPopup({ x: rect.left + rect.width / 2, y: rect.top - 8, text })
    }
    const handleMouseDown = (e: MouseEvent) => {
      // не закрываем если клик на сам popup
      if ((e.target as HTMLElement)?.closest('.selection-reply-popup')) return
      setSelectionPopup(null)
    }
    document.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('mousedown', handleMouseDown)
    return () => {
      document.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('mousedown', handleMouseDown)
    }
  }, [])

  // Загружаем toolOutputMode
  useEffect(() => {
    window.syntee.agent.getSettings().then((s: { toolOutputMode?: ToolOutputMode }) => {
      if (s.toolOutputMode) setToolOutputMode(s.toolOutputMode)
    }).catch(() => {})
  }, [])

  // Ctrl+F — поиск в чате
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        setShowSearch(v => !v)
      }
      if (e.key === 'Escape') { setShowSearch(false); setSearchQuery(''); setSearchMatchIds([]) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Загрузка чатов и проектов при старте
  useEffect(() => {
    window.syntee.projects.getAll().then((all: Project[]) => {
      setProjects(all)
    })
    window.syntee.chat.getAll().then((all: Chat[]) => {
      setChats(all)
      // Открываем первый чат или создаём новый
      if (all.length > 0) {
        selectChat(all[0].id)
      }
    })
  }, [])

  // IPC события стриминга
  const [liveThinking, setLiveThinking] = useState<{ text: string; isLive: boolean; ms?: number } | null>(null)
  // ref для currentChatId чтобы listener не пересоздавался при смене чата
  const currentChatIdRef = useRef<string | null>(currentChatId)
  useEffect(() => { currentChatIdRef.current = currentChatId }, [currentChatId])

  useEffect(() => {
    const offToken = window.syntee.on(IPC_EVENTS.CHAT_STREAM_TOKEN, (data: {
      chatId: string; msgId: string; token?: string
      thinkingToken?: string; thinkingDone?: boolean; thinkingMs?: number
    }) => {
      if (data.chatId !== currentChatIdRef.current) return
      streamMsgIdRef.current = data.msgId
      setStreamMsgId(data.msgId)

      if (data.thinkingToken) {
        const tok = typeof data.thinkingToken === 'string' ? data.thinkingToken : String(data.thinkingToken ?? '')
        pendingThinkingRef.current += tok
        setLiveThinking({ text: pendingThinkingRef.current, isLive: true })
        return
      }
      if (data.thinkingDone) {
        const ms = data.thinkingMs as number | undefined
        pendingThinkingMsRef.current = ms
        setLiveThinking(prev => prev ? { ...prev, isLive: false, ms } : null)
        return
      }
      if (data.token) {
        // Батчим токены через RAF — не setState на каждый символ
        tokenBufRef.current += data.token
        scheduleFlush()
      }
    })

    const offDone = window.syntee.on(IPC_EVENTS.CHAT_STREAM_DONE, (data: { chatId: string; message: Message }) => {
      streamMsgIdRef.current = null
      setStreamMsgId(null)
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
      tokenBufRef.current = ''
      clearStream()
      setTyping(false)
      setIsAgentRunning(false)
      setLiveSteps([])
      liveItersRef.current = []
      setLiveIters([])
      liveTextAfterRef.current = ''
      setLiveTextAfter('')
      pendingThinkingRef.current = ''
      pendingThinkingMsRef.current = undefined
      playDoneSound()
      setLiveThinking(null)
      setAgentStatus(null)
      setLiveTodo([])
      if (data.chatId === currentChatIdRef.current) {
        addMessage(data.message)
        window.syntee.chat.getAll().then((all: Chat[]) => setChats(all))
      }
    })

    const offError = window.syntee.on(IPC_EVENTS.CHAT_STREAM_ERROR, (data: { error: string }) => {
      streamMsgIdRef.current = null
      setStreamMsgId(null)
      clearStream()
      setTyping(false)
      setLiveThinking(null)
      setIsAgentRunning(false)
      setLiveSteps([])
      liveItersRef.current = []
      setLiveIters([])
      liveTextAfterRef.current = ''
      setLiveTextAfter('')
      pendingThinkingRef.current = ''
      pendingThinkingMsRef.current = undefined
      if (data.error !== 'stopped') toast('Ошибка: ' + data.error, 'error')
    })

    const offRateLimit = window.syntee.on(IPC_EVENTS.RATE_LIMIT, (data: { waitSec: number }) => {
      setRateLimitSec(data.waitSec)
      // Countdown — уменьшаем каждую секунду для WaitingIndicator
      let remaining = data.waitSec
      const countdown = setInterval(() => {
        remaining -= 1
        if (remaining <= 0) {
          clearInterval(countdown)
          setRateLimitSec(0)
        } else {
          setRateLimitSec(remaining)
        }
      }, 1000)
    })

    // §4.3 — чек-лист плана (todo list)
    const offTodo = window.syntee.on('agent:todo', (data: { items: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>; msgId?: string }) => {
      if (streamMsgIdRef.current === 'streaming-pending' && data.msgId) {
        streamMsgIdRef.current = data.msgId
        setStreamMsgId(data.msgId)
      }
      if (data.msgId && streamMsgIdRef.current && data.msgId !== streamMsgIdRef.current) return
      setLiveTodo(data.items)
    })

    // Шаги агента — только от основного потока (фильтруем по msgId)
    const offStep = window.syntee.on('agent:step', (step: {
      type: string; toolName?: string; toolArgs?: Record<string, unknown>; content: string; success?: boolean; imageUrl?: string; msgId?: string; callId?: string; pendingCallId?: string
    }) => {
      if (!streamMsgIdRef.current) return
      // Гонка: streamMsgIdRef.current выставляется в 'streaming-pending' сразу
      // при отправке, а на реальный assistantMsgId меняется только когда
      // резолвится Promise chat.send(). Если модель вызывает тул первым шагом
      // (без предшествующего токена), это событие может прийти раньше, чем
      // Promise зарезолвится — тогда step.msgId (реальный) !== 'streaming-pending'
      // и блок тула молча терялся. Усваиваем реальный id из первого события,
      // как уже делает offToken.
      if (streamMsgIdRef.current === 'streaming-pending' && step.msgId) {
        streamMsgIdRef.current = step.msgId
        setStreamMsgId(step.msgId)
      }
      if (step.msgId && step.msgId !== streamMsgIdRef.current) return

      if (step.type === 'tool_call_pending') {
        // Ранний сигнал: модель начала вызывать тул, аргументы ещё не готовы.
        // Показываем карточку "готовится" сразу, не дожидаясь конца генерации
        // JSON аргументов (может занимать заметное время для edit_file/write_file
        // с большим content) — иначе в чате долго "ничего не происходит".
        setIsAgentRunning(true)
        const pendingStep = {
          id: uuid(), type: 'tool_call' as const,
          toolName: step.toolName, toolArgs: undefined,
          content: step.content, success: undefined,
          timestamp: Date.now(), imageUrl: undefined,
          callId: step.callId,
          pending: true,
        }
        const iters = [...liveItersRef.current]
        const last = iters[iters.length - 1]
        const textBetween = liveTextAfterRef.current
        const thinkingNow = pendingThinkingRef.current
        const thinkingMsNow = pendingThinkingMsRef.current
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
        liveItersRef.current = newIters
        setLiveIters(newIters)
        liveTextAfterRef.current = ''
        setLiveTextAfter('')
        pendingThinkingRef.current = ''
        pendingThinkingMsRef.current = undefined
        setLiveThinking(null)
      } else if (step.type === 'tool_call') {
        // Сначала флашим буфер токенов синхронно
        if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
        if (tokenBufRef.current) {
          const chunk = tokenBufRef.current
          tokenBufRef.current = ''
          liveTextAfterRef.current = liveTextAfterRef.current + chunk
          setLiveTextAfter(prev => prev + chunk)
          appendStreamToken(chunk)
        }
        setIsAgentRunning(true)
        const newStep = {
          id: uuid(), type: 'tool_call' as const,
          toolName: step.toolName, toolArgs: step.toolArgs,
          content: step.content, success: step.success,
          timestamp: Date.now(), imageUrl: step.imageUrl,
          callId: step.callId,
        }
        setLiveSteps(prev => [...prev, newStep])

        // Заменяем pending-карточку той же генерации in-place, вместо того
        // чтобы добавлять второй блок — pendingCallId проставлен в Agent.ts
        // и совпадает с callId, который был у tool_call_pending.
        let replacedPending = false
        if (step.pendingCallId) {
          const itersForReplace = liveItersRef.current.map(iter => {
            const stepIdx = iter.steps.findIndex(s => s.type === 'tool_call' && s.callId === step.pendingCallId)
            if (stepIdx === -1) return iter
            replacedPending = true
            const nextSteps = [...iter.steps]
            nextSteps[stepIdx] = newStep
            return { ...iter, steps: nextSteps }
          })
          if (replacedPending) {
            liveItersRef.current = itersForReplace
            setLiveIters(itersForReplace)
          }
        }

        if (!replacedPending) {
          const iters = [...liveItersRef.current]
          const last = iters[iters.length - 1]
          const textBetween = liveTextAfterRef.current
          const thinkingNow = pendingThinkingRef.current
          const thinkingMsNow = pendingThinkingMsRef.current
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
          liveItersRef.current = newIters
          setLiveIters(newIters)
        }
        liveTextAfterRef.current = ''
        setLiveTextAfter('')
        // Сбрасываем pending thinking — он прикреплён к итерации
        pendingThinkingRef.current = ''
        pendingThinkingMsRef.current = undefined
        setLiveThinking(null)
      } else if (step.type === 'tool_result') {
        setIsAgentRunning(true)
        const newStep = {
          id: uuid(), type: 'tool_result' as const,
          toolName: step.toolName, toolArgs: step.toolArgs,
          content: step.content, success: step.success,
          timestamp: Date.now(), imageUrl: step.imageUrl,
          diff: (step as { diff?: string }).diff,
          callId: step.callId,
        }
        setLiveSteps(prev => [...prev, newStep])
        if (liveItersRef.current.length === 0) return
        const iters = [...liveItersRef.current]

        // Матчим result в правильную итерацию по callId или toolName
        // а не просто в последнюю — это фикс для параллельных тулов
        let targetIterIdx = iters.length - 1  // fallback: последняя
        if (step.callId) {
          // Ищем итерацию где есть tool_call с тем же callId
          const idx = iters.findIndex(iter =>
            iter.steps.some(s => s.type === 'tool_call' && s.callId === step.callId)
          )
          if (idx !== -1) targetIterIdx = idx
        } else if (step.toolName) {
          // Fallback: ищем итерацию с tool_call того же toolName без result
          const idx = iters.findIndex(iter =>
            iter.steps.some(s => s.type === 'tool_call' && s.toolName === step.toolName) &&
            !iter.steps.some(s => s.type === 'tool_result' && s.toolName === step.toolName)
          )
          if (idx !== -1) targetIterIdx = idx
        }

        iters[targetIterIdx] = { ...iters[targetIterIdx], steps: [...iters[targetIterIdx].steps, newStep] }
        liveItersRef.current = iters
        setLiveIters(iters)
      }
    })

    const offStatus = window.syntee.on('agent:status', (data: { msgId: string; chatId: string; text: string }) => {
      if (!streamMsgIdRef.current) return
      // Принимаем статус если chatId совпадает — msgId может быть 'streaming-pending' в начале
      if (data.chatId && data.chatId !== currentChatIdRef.current) return
      setAgentStatus(data.text)
    })

    return () => { offToken(); offDone(); offError(); offRateLimit(); offStep(); offStatus() }
  }, []) // [] — listener создаётся один раз, currentChatId читается через ref

  // ── АВТОСКРОЛЛ — плавный 60fps через rAF + ResizeObserver ──────────────────
  const autoScrollRef    = useRef(true)   // true = следим за низом
  const scrollRafRef     = useRef<number | null>(null)
  const lastScrollHeight = useRef(0)

  // Плавно анимируем скролл к низу через rAF (не через CSS smooth — контролируем сами)
  const smoothScrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current)

    const animate = () => {
      if (!el) return
      const target = el.scrollHeight - el.clientHeight
      const current = el.scrollTop
      const diff = target - current
      if (Math.abs(diff) < 1) { el.scrollTop = target; scrollRafRef.current = null; return }
      // Easing: двигаемся на 18% разницы за кадр → ~60fps плавно
      el.scrollTop += diff * 0.18
      scrollRafRef.current = requestAnimationFrame(animate)
    }
    scrollRafRef.current = requestAnimationFrame(animate)
  }, [])

  const scrollToBottomInstant = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current)
    el.scrollTop = el.scrollHeight - el.clientHeight
  }, [])

  // Детект ручного скролла вверх — отпускаем автоскролл
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    // Если пользователь ушёл > 80px от низа — отпускаем
    // Если вернулся < 20px — снова цепляемся
    if (distFromBottom > 80) autoScrollRef.current = false
    if (distFromBottom < 20) autoScrollRef.current = true
  }, [])

  // ResizeObserver на контейнер виртуализатора — ловит раскрытие тулчейнов
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const newHeight = el.scrollHeight
      if (newHeight !== lastScrollHeight.current) {
        lastScrollHeight.current = newHeight
        if (autoScrollRef.current) smoothScrollToBottom()
      }
    })
    // Наблюдаем за внутренним контентом а не за самим контейнером
    const inner = el.firstElementChild
    if (inner) ro.observe(inner as Element)
    return () => ro.disconnect()
  }, [smoothScrollToBottom])

  // ── Динамический отступ под ChatInput ───────────────────────────────
  // .chat-input-wrap абсолютно позиционирован (bottom:0). .chat-input-main
  // — flex column с justify-content:flex-end, внутри него todo-zone +
  // status-row + инпут. Высота wrap уже включает всё (todo в потоке),
  // поэтому достаточно наблюдать только wrap. Чтобы последние сообщения
  // не перекрывались ни инпут-баром, ни todo, --chat-input-h = высота
  // wrap. Меняется при auto-resize textarea / появлении бейджей / todo.
  useEffect(() => {
    const holder = chatInputWrapRef.current
    const container = holder?.parentElement
    // .chat-input-wrap позиционирован absolute — реальный узел с высотой
    // это первый ребёнок holder-обёртки (у holder 0 высоты).
    const wrap = holder?.firstElementChild as HTMLElement | undefined
    if (!wrap || !container) return
    const apply = () => {
      container.style.setProperty('--chat-input-h', `${wrap.offsetHeight}px`)
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  // Скролл при новых сообщениях / начале стриминга
  useEffect(() => {
    if (isLoadingMessages || displayMessages.length === 0) return
    if (isInitialScrollRef.current) {
      // Первый рендер чата — мгновенно без анимации
      requestAnimationFrame(() => { scrollToBottomInstant(); isInitialScrollRef.current = false })
      autoScrollRef.current = true
    } else if (autoScrollRef.current) {
      smoothScrollToBottom()
    }
  }, [messages.length, isTyping, isLoadingMessages, smoothScrollToBottom, scrollToBottomInstant])

  const selectChat = async (id: string) => {
    setIsLoadingMessages(true)
    isInitialScrollRef.current = true
    autoScrollRef.current = true
    if (scrollRafRef.current) { cancelAnimationFrame(scrollRafRef.current); scrollRafRef.current = null }
    // показываем скелетон только если грузится дольше 120мс
    skeletonTimerRef.current = setTimeout(() => setShowSkeleton(true), 120)
    setCurrentChat(id)
    const msgs: Message[] = await window.syntee.chat.getMessages(id)
    setMessages(msgs)
    if (skeletonTimerRef.current) clearTimeout(skeletonTimerRef.current)
    setShowSkeleton(false)
    setIsLoadingMessages(false)
  }

  const createNewChat = async (projectId?: string) => {
    // projectId может прийти из Sidebar (кнопка + на проекте) или из активного проекта.
    // Если не передан и нет activeProjectId — предлагаем создать проект через пикер.
    let pid = projectId ?? activeProjectId
    if (!pid) {
      // Нет активного проекта — спросим папку и создадим проект.
      const picked = await window.syntee.projects.pickWorkdir()
      if (!picked) return  // отмена
      const project: Project = await window.syntee.projects.create(picked)
      const allProjects: Project[] = await window.syntee.projects.getAll()
      setProjects(allProjects)
      setActiveProject(project.id)
      pid = project.id
    }
    const chat: Chat = await window.syntee.chat.create(isIncognito, activeMode, pid)
    const all: Chat[] = await window.syntee.chat.getAll()
    setChats(all)
    setCurrentChat(chat.id)
    setMessages([])
    autoScrollRef.current = true
    isInitialScrollRef.current = true
  }

  const createNewProject = async (mode: 'empty' | 'existing' = 'existing') => {
    const picked = mode === 'empty'
      ? await window.syntee.projects.pickNewWorkdir()
      : await window.syntee.projects.pickWorkdir()
    if (!picked) return
    const project: Project = await window.syntee.projects.create(picked)
    const allProjects: Project[] = await window.syntee.projects.getAll()
    setProjects(allProjects)
    setActiveProject(project.id)
  }

  // Создание чата без привязки к проекту — без пикера папки, без workdir.
  // Чат попадёт в раздел «Без проекта» в сайдбаре.
  const createChatWithoutProject = async () => {
    const chat: Chat = await window.syntee.chat.create(isIncognito, activeMode, undefined)
    const all: Chat[] = await window.syntee.chat.getAll()
    setChats(all)
    setCurrentChat(chat.id)
    setMessages([])
    autoScrollRef.current = true
    isInitialScrollRef.current = true
  }

  const handleSend = async (text: string) => {
    const raw = text.trim()
    const slash = parseSlashCommand(raw)

    // ── Локальные команды (без AI) ──────────────────────────────
    if (slash?.command.name === 'clear') {
      if (currentChatId) { setMessages([]); toast('Чат очищен', 'info') }
      return
    }
    if (slash?.command.name === 'sys') {
      if (!slash.args) { toast('Укажи промпт: /sys ты поэт', 'info'); return }
      await window.syntee.models.setParams({ systemPrompt: slash.args })
      toast('Системный промпт обновлён', 'success')
      return
    }
    if (slash?.command.name === 'image') {
      if (!slash.args) { toast('Укажи описание: /image красивый закат', 'info'); return }
      // Просто отправляем в AI — он сам вызовет tool generate_image
      // Никакой прямой генерации здесь
    }

    // ── Создаём чат если нет ────────────────────────────────────
    let chatId = currentChatId
    if (!chatId) {
      // Если есть активный проект — создаём чат в нём. Иначе — пикер папки
      // и создание проекта, как в createNewChat.
      let pid = activeProjectId
      if (!pid) {
        const picked = await window.syntee.projects.pickWorkdir()
        if (!picked) return
        const project: Project = await window.syntee.projects.create(picked)
        const allProjects: Project[] = await window.syntee.projects.getAll()
        setProjects(allProjects)
        setActiveProject(project.id)
        pid = project.id
      }
      const chat: Chat = await window.syntee.chat.create(isIncognito, activeMode, pid)
      chatId = chat.id
      setCurrentChat(chatId)
      setMessages([])
      const all: Chat[] = await window.syntee.chat.getAll()
      setChats(all)
    }

    // ── Формируем контент ────────────────────────────────────────
    // Пользователь видит "/image sunset"
    // AI получает systemPrompt команды (скрыт от пользователя)
    let displayContent = raw
    let aiContent = raw

    if (slash) {
      const sysPrompt = slash.command.systemPrompt(slash.args)
      if (sysPrompt) aiContent = sysPrompt
    }

    // Добавляем цитаты reply
    if (replyTo.length > 0) {
      const quotes = replyTo.map(r => {
        const who = r.role === 'user' ? 'Пользователь' : 'Syntee'
        return `> [${who}]: ${r.content.slice(0, 300)}${r.content.length > 300 ? '…' : ''}`
      }).join('\n')
      aiContent = `${quotes}\n\n${aiContent}`
    }

    // ── Сообщение пользователя ───────────────────────────────────
    const userMsg: Message = {
      id: uuid(), chatId,
      role: 'user',
      content: displayContent,
      createdAt: Date.now(),
      isPinned: 0,
      slashCommand: slash ? { name: slash.command.name, args: slash.args } : undefined,
    }
    addMessage(userMsg)
    setTyping(true)
    setReplyTo([])
    // Временный id сразу — чтобы пузырь появился до ответа chat.send
    streamMsgIdRef.current = 'streaming-pending'
    setStreamMsgId('streaming-pending')

    const result = await window.syntee.chat.send({
      chatId,
      content: aiContent,
      displayContent: displayContent !== aiContent ? displayContent : undefined,
      slashCommand: slash ? { name: slash.command.name, args: slash.args } : undefined,
      userMsgId: userMsg.id,
      planningMode,
      imageMode,
      mode: activeMode,
    })
    // Обновляем на реальный id из БД
    if (result?.assistantMsgId) {
      streamMsgIdRef.current = result.assistantMsgId
    }
  }

  const handlePin = useCallback(async (id: string) => {
    await window.syntee.chat.pin(id)
    pinMessage(id)
    toast('Сообщение закреплено', 'info')
  }, [pinMessage, toast])

  const handleCopy = useCallback(() => toast('Скопировано', 'success'), [toast])

  const handleReply = useCallback((msg: Message) => {
    setReplyTo(prev => prev.find(r => r.id === msg.id) ? prev : [...prev, msg])
  }, [])

  // Собираем отображаемые сообщения (включая стриминг)
  const hasLiveContent = !!streamingText || !!liveThinking || liveSteps.length > 0 ||
    liveIters.length > 0 || !!liveTextAfter
  // Показываем пузырь сразу при отправке (isTyping), не ждём первого токена
  const showLiveBubble = (hasLiveContent || isTyping) && !!streamMsgId
  const isStreaming = showLiveBubble

  // Workdir текущего чата — для бейджа над инпут-баром (как в Codex CLI).
  // Источник: chat.workdir (денормализованный кэш из projects).
  const currentWorkdir = useMemo(() => {
    if (!currentChatId || isIncognito) return undefined
    return chats.find(c => c.id === currentChatId)?.workdir
  }, [chats, currentChatId, isIncognito])

  // Активный проект для отображения в бейдже
  const activeProject = useMemo(() => {
    if (!currentChatId) return undefined
    const chat = chats.find(c => c.id === currentChatId)
    if (!chat?.projectId) return undefined
    return projects.find(p => p.id === chat.projectId)
  }, [chats, currentChatId, projects])
  const displayMessages = useMemo(() => showLiveBubble
    ? [...messages, {
        id: streamMsgId || 'streaming',
        chatId: currentChatId || '',
        role: 'assistant' as const,
        content: streamingText || '',
        createdAt: Date.now(),
        isPinned: 0,
        toolSteps: liveSteps.length > 0 ? liveSteps as Message['toolSteps'] : undefined,
        liveIters,
        liveTextAfter,
        liveTodo,
        agentStatus,
        rateLimitSec: rateLimitSec > 0 ? rateLimitSec : undefined,
      }]
    : messages
  // eslint-disable-next-line react-hooks/exhaustive-deps
  , [messages, showLiveBubble, streamingText, liveSteps, liveIters, liveTextAfter, liveTodo])

  // Virtualizer — рендерим только видимые сообщения
  const virtualizer = useVirtualizer({
    count: displayMessages.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 120,
    overscan: 5,
    measureElement: (el) => el.getBoundingClientRect().height,
  })

  return (
    <div className={`chat-layout ${embedded ? 'chat-layout--embedded' : ''}`}>
      {!embedded && <AnimatedBackground />}
      {!embedded && <TitleBar onSettingsClick={() => {}} />}
      <div className="chat-body">
        <Sidebar
          chats={chats}
          projects={projects}
          activeProjectId={activeProjectId}
          currentChatId={currentChatId}
          onSelectChat={selectChat}
          onNewChat={createNewChat}
          onNewChatWithoutProject={createChatWithoutProject}
          onNewProject={createNewProject}
          onChatsUpdate={setChats}
          onProjectsUpdate={setProjects}
          onSelectProject={setActiveProject}
        />
        <main className="chat-main">
          {/* Live-план задач — компактный pill вверху чата по центру.
              Разворачивается по клику, авто-сворачивается когда всё готово. */}
          <LiveTodoBar items={isTyping ? liveTodo : []} active={isTyping} />

          {/* Поиск по чату */}
          <AnimatePresence>
            {showSearch && (
              <motion.div key="search" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.15 }}>
                <ChatSearch
                  messages={messages}
                  onMatchIds={(ids, q) => { setSearchMatchIds(ids); setSearchQuery(q) }}
                  onClose={() => { setShowSearch(false); setSearchQuery(''); setSearchMatchIds([]) }}
                />
              </motion.div>
            )}
          </AnimatePresence>
          {showSkeleton ? (
            <motion.div
              key="skeleton"
              className="chat-skeleton"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
            >
              {[0.4, 0.7, 0.5, 0.9, 0.6, 0.8, 0.45, 0.75].map((w, i) => (
                <div key={i} className={`chat-skeleton-row ${i % 3 === 0 ? 'chat-skeleton-row--user' : ''}`}>
                  <div className="chat-skeleton-bubble" style={{ width: `${w * 100}%` }} />
                </div>
              ))}
            </motion.div>
          ) : displayMessages.length === 0 && !isTyping ? (
            <div className="chat-empty-state">
              <div className="chat-empty-icon">
                <svg width="52" height="52" viewBox="0 0 52 52" fill="none">
                  <polygon points="26,2 50,14 50,38 26,50 2,38 2,14"
                    fill="none" stroke="var(--accent)" strokeWidth="1.5" opacity="0.5"/>
                  <polygon points="26,10 42,18 42,34 26,42 10,34 10,18"
                    fill="var(--accent)" opacity="0.05"/>
                  <polygon points="26,18 34,22 34,30 26,34 18,30 18,22"
                    fill="var(--accent)" opacity="0.15"/>
                </svg>
              </div>
              <h2>Привет! Я Syntee.</h2>
              <p>Чем могу помочь сегодня?</p>
              {isIncognito && (
                <div className="incognito-hint">
                  <AppIcon name="lock" size="sm" tone="accent" />
                  <span>Режим инкогнито — чат не сохраняется</span>
                </div>
              )}
              {/* Подсказка о рабочей директории проекта */}
              {!isIncognito && activeProject && currentWorkdir && (
                <div className="chat-empty-workdir-hint">
                  <AppIcon name="folder" size="sm" tone="accent" />
                  <span>Проект: <strong>{activeProject.name}</strong> · {currentWorkdir}</span>
                </div>
              )}
              {!isIncognito && !activeProject && currentChatId && (
                <div className="chat-empty-workdir-hint chat-empty-workdir-hint--warn">
                  <AppIcon name="folder" size="sm" />
                  <span>Чат без проекта. Файловые операции работают относительно текущей директории процесса.</span>
                </div>
              )}
            </div>
          ) : (
            <div
              className="chat-messages"
              ref={scrollContainerRef}
              onScroll={handleScroll}
            >
              <div
                style={{
                  height: virtualizer.getTotalSize(),
                  width: '100%',
                  position: 'relative',
                }}
              >
                {virtualizer.getVirtualItems().map(vItem => {
                  const msg = displayMessages[vItem.index]
                  const isLive = msg.id === (streamMsgId || 'streaming')
                  return (
                    <div
                      key={msg.id}
                      data-index={vItem.index}
                      ref={virtualizer.measureElement}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${vItem.start}px)`,
                      }}
                    >
                      <MessageBubble
                        message={msg}
                        toolOutputMode={toolOutputMode}
                        onPin={handlePin}
                        onCopy={handleCopy}
                        onReply={handleReply}
                        searchQuery={searchMatchIds.includes(msg.id) ? searchQuery : undefined}
                        liveThinking={isLive ? liveThinking ?? undefined : undefined}
                        isStreaming={isLive && isTyping}
                        isWaiting={isLive && isTyping}
                        rateLimitSec={isLive ? rateLimitSec : undefined}
                      />
                    </div>
                  )
                })}
              </div>
              <div ref={bottomRef} />
            </div>
          )}

          <div ref={chatInputWrapRef} style={{ display: 'contents' }}>
            <ChatInput
              onSend={handleSend}
              disabled={isTyping}
              isIncognito={isIncognito}
              replyTo={replyTo}
              onCancelReply={(id) => setReplyTo(prev => prev.filter(r => r.id !== id))}
              isGenerating={isTyping || isAgentRunning}
              onStop={() => window.syntee.chat.stop()}
              contextInfo={contextInfo}
              showContextRing={showContextRing}
              onInputChange={setInputText}
              mainModelId={mainModelId}
              onMainModelChange={handleMainModelChange}
              reasoningValue={reasoningValue}
              onReasoningChange={handleReasoningChange}
              planningMode={planningMode}
              onPlanningModeChange={setPlanningMode}
              imageMode={imageMode}
              onImageModeChange={setImageMode}
              workdir={currentWorkdir}
            />
          </div>

          {/* Selection reply popup — через portal чтобы fixed работал правильно */}
          {selectionPopup && createPortal(
            <div
              className="selection-reply-popup"
              style={{ left: selectionPopup.x, top: selectionPopup.y }}
              onMouseDown={e => e.preventDefault()}
            >
              <button
                className="selection-reply-btn"
                onClick={() => {
                  const syntheticMsg = { id: `sel-${Date.now()}`, role: 'user', content: selectionPopup.text, createdAt: Date.now() } as Message
                  setReplyTo(prev => [...prev, syntheticMsg])
                  setSelectionPopup(null)
                  window.getSelection()?.removeAllRanges()
                }}
              >
                ↩ Reply
              </button>
              <button
                className="selection-reply-copy"
                onClick={() => {
                  navigator.clipboard.writeText(selectionPopup.text)
                  setSelectionPopup(null)
                }}
              >
                Copy
              </button>
            </div>,
            document.body
          )}
        </main>
      </div>
      {!embedded && (
        <ToastContainer />
      )}
    </div>
  )
}
