import { memo, useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useVirtualizer } from '@tanstack/react-virtual'
import { v4 as uuid } from 'uuid'
import type { Message, Attachment, ToolOutputMode } from '../../../../../shared/types'
import type { SlashCommand } from '../../../../../shared/slashCommands'
import { initChatSend, hydrateFromMain, enqueuePendingUserMsg } from '../../../hooks/useChatRunSubscription'
import { useChatAutoscroll } from '../../../hooks/useChatAutoscroll'
import { useContextCounter } from '../../../hooks/useContextCounter'
import MessageBubble from '../MessageBubble/MessageBubble'
import { ChatRemeasureContext } from '../MessageBubble/remeasure'
import ChatInput from '../ChatInput/ChatInput'
import ChatMinimap from '../ChatMinimap/ChatMinimap'
import LiveTodoBar from '../LiveTodoBar/LiveTodoBar'
import AppIcon from '../AppIcon/AppIcon'
import Logo from '../Logo/Logo'
import { useChatStore, EMPTY_LIVE } from '../../../store/chat.store'
import { playDoneSound } from '../../../utils/sounds'
import { parseSlashCommandWithCustom } from '../../../../../shared/slashCommands'
// Общие классы чата (chat-main/chat-messages/chat-skeleton/chat-empty-state/
// chat-scroll-down-btn/chat-older-spin). ChatPage keep-alive и тоже импортирует
// этот CSS — Vite дедуплицирует, двойной загрузки нет.
import '../../../pages/Chat/ChatPage.css'
import './SplitChatPane.css'

const itemStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  width: '100%',
}

interface VirtualMessageItemProps {
  msg: Message
  vItemStart: number
  vItemIndex: number
  measureRef: (node: Element | null) => void
  toolOutputMode: ToolOutputMode
  onPin: (id: string) => void
  onCopy: (content: string) => void
  onReply: (message: Message) => void
  onRewind: (userMessageId: string) => void
  liveThinking?: { text: string; isLive: boolean; ms?: number }
  isStreaming: boolean
  isWaiting: boolean
  rateLimitSec?: number
  shouldAnimate: boolean
}

const VirtualMessageItem = memo(function VirtualMessageItem({
  msg, vItemStart, vItemIndex, measureRef, toolOutputMode,
  onPin, onCopy, onReply, onRewind, liveThinking,
  isStreaming, isWaiting, rateLimitSec, shouldAnimate,
}: VirtualMessageItemProps) {
  return (
    <div
      data-index={vItemIndex}
      data-msg-id={msg.id}
      ref={measureRef}
      style={{ ...itemStyle, transform: `translateY(${vItemStart}px)` }}
    >
      <MessageBubble
        message={msg}
        toolOutputMode={toolOutputMode}
        onPin={onPin}
        onCopy={onCopy}
        onReply={onReply}
        onRewind={onRewind}
        liveThinking={liveThinking}
        isStreaming={isStreaming}
        isWaiting={isWaiting}
        rateLimitSec={rateLimitSec}
        shouldAnimate={shouldAnimate}
      />
    </div>
  )
}, (prev, next) =>
  prev.msg === next.msg &&
  prev.vItemStart === next.vItemStart &&
  prev.vItemIndex === next.vItemIndex &&
  prev.toolOutputMode === next.toolOutputMode &&
  prev.onPin === next.onPin &&
  prev.onCopy === next.onCopy &&
  prev.onReply === next.onReply &&
  prev.onRewind === next.onRewind &&
  prev.liveThinking === next.liveThinking &&
  prev.isStreaming === next.isStreaming &&
  prev.isWaiting === next.isWaiting &&
  prev.rateLimitSec === next.rateLimitSec &&
  prev.shouldAnimate === next.shouldAnimate
)

// ── SplitChatPane — второй параллельный чат (сплит-панель) ──────────────────
// Полноценный чат рядом с основным: виртуализированная лента, reverse-infinite
// scroll, live-пузырь стриминга, autoscroll, свой ChatInput (draft/моды/reply/
// attachments/customCommands/модель/stop). Сообщения читаются из LRU-кеша
// messagesByChat[chatId] (не из messages — это окно ТЕКУЩЕГО чата), live-статус
// из liveByChat[chatId] (per-chat). Отправка — через тот же chat:send IPC с
// chatId = сплит-чат; main не знает про сплит, для него это обычный чат.
function SplitChatPane({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  // ── Сообщения из LRU-кеша (не из messages — то окно текущего чата) ──
  // Селектор возвращает запись messagesByChat[chatId]; ref меняется только при
  // setMessagesWindow/prependOlderMessages/addMessage ДЛЯ ЭТОГО chatId. Чужой
  // чат стримит → ref стабилен → без ре-рендера сплита.
  const cacheEntry = useChatStore(s => s.messagesByChat[chatId])
  const messages = useMemo(() => cacheEntry?.messages ?? [], [cacheEntry])
  const hasOlderMessages = cacheEntry?.hasOlder ?? false
  const live = useChatStore(s => s.liveByChat[chatId]) ?? EMPTY_LIVE
  const chats = useChatStore(s => s.chats)
  const setMessagesWindow = useChatStore(s => s.setMessagesWindow)
  const prependOlderMessages = useChatStore(s => s.prependOlderMessages)
  const addMessage = useChatStore(s => s.addMessage)
  const clearLiveState = useChatStore(s => s.clearLiveState)
  const chat = useMemo(() => chats.find(c => c.id === chatId), [chats, chatId])
  const isIncognito = !!chat?.isIncognito
  const currentWorkdir = chat?.workdir
  const activeMode = useChatStore(s => s.activeMode)
  const isTyping = live.isTyping
  const isAgentRunning = live.isAgentRunning
  const streamingText = live.text

  const [toolOutputMode] = useState<ToolOutputMode>('normal')
  const [isLoadingOlder, setIsLoadingOlder] = useState(false)
  const [showSkeleton, setShowSkeleton] = useState(false)
  const isInitialScrollRef = useRef(true)
  const skeletonTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const animatedMsgIdsRef = useRef(new Set<string>())

  const [draft, setDraft] = useState('')
  const [inputHistory, setInputHistory] = useState<string[]>([])
  const [planningMode, setPlanningMode] = useState(false)
  const [imageMode, setImageMode] = useState(false)
  const [askMode, setAskMode] = useState(false)
  const [draftAttachments, setDraftAttachments] = useState<Attachment[]>([])
  const draftAttachmentsRef = useRef<Attachment[]>([])
  const planningModeRef = useRef(false)
  const imageModeRef = useRef(false)
  const askModeRef = useRef(false)
  useEffect(() => { draftAttachmentsRef.current = draftAttachments }, [draftAttachments])
  useEffect(() => { planningModeRef.current = planningMode }, [planningMode])
  useEffect(() => { imageModeRef.current = imageMode }, [imageMode])
  useEffect(() => { askModeRef.current = askMode }, [askMode])

  const [replyTo, setReplyTo] = useState<Message[]>([])
  const [mainModelId, setMainModelId] = useState('claude-sonnet-4-6')
  const [reasoningValue, setReasoningValue] = useState('')
  const [showContextRing] = useState(true)
  const [customCommands, setCustomCommands] = useState<SlashCommand[]>([])

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const chatInputWrapRef = useRef<HTMLDivElement>(null)

  // ── Загрузка модели / reasoning при монтировании ──
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [assignments, reason] = await Promise.all([
          window.syntee.settings.get('modelAssignments'),
          window.syntee.settings.get('reasoningValue'),
        ])
        if (cancelled) return
        if (Array.isArray(assignments)) {
          const main = (assignments as Array<{ role: string; modelId: string }>).find(a => a.role === 'main')
          if (main) setMainModelId(main.modelId)
        }
        if (typeof reason === 'string' && reason) setReasoningValue(reason)
      } catch { /* ok */ }
    })()
    return () => { cancelled = true }
  }, [])

  // Загрузка кастомных команд и modes/draft для этого chatId
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const cmds = await window.syntee.commands.list({ projectWorkdir: currentWorkdir }) as SlashCommand[]
        if (!cancelled) setCustomCommands(cmds)
      } catch { /* ok */ }
      if (!chat || isIncognito) {
        setDraft('')
        setPlanningMode(false)
        setImageMode(false)
        setAskMode(false)
        setDraftAttachments([])
        return
      }
      try {
        const [modes, draftText, history, attachments] = await Promise.all([
          window.syntee.chat.getModes(chatId),
          window.syntee.chat.getDraft(chatId),
          window.syntee.chat.getInputHistory(chatId),
          window.syntee.draft.getAttachments(chatId),
        ])
        if (cancelled) return
        setPlanningMode(!!modes.planningMode)
        setImageMode(!!modes.imageMode)
        setAskMode(!!modes.askMode)
        setDraft(typeof draftText === 'string' ? draftText : '')
        setDraftAttachments(Array.isArray(attachments) ? attachments as Attachment[] : [])
        setInputHistory(Array.isArray(history) ? history.reverse() : [])
      } catch { /* ok */ }
    })()
    return () => { cancelled = true }
  }, [chatId, currentWorkdir, isIncognito, chat])

  // ── Загрузка сообщений (первая страница) + гидрация live ──
  useEffect(() => {
    let cancelled = false
    isInitialScrollRef.current = true
    animatedMsgIdsRef.current = new Set()
    ;(async () => {
      // Если уже в кеше — не дёргаем IPC, кеш актуален.
      const cached = useChatStore.getState().messagesByChat[chatId]
      if (cached) {
        setShowSkeleton(false)
        return
      }
      skeletonTimerRef.current = setTimeout(() => { if (!cancelled) setShowSkeleton(true) }, 120)
      await hydrateFromMain(chatId)
      try {
        const res = await window.syntee.chat.getMessagesPage(chatId, 20)
        if (cancelled) return
        setMessagesWindow(chatId, res.messages, res.hasMore)
        if (skeletonTimerRef.current) clearTimeout(skeletonTimerRef.current)
        setShowSkeleton(false)
      } catch {
        if (skeletonTimerRef.current) clearTimeout(skeletonTimerRef.current)
        setShowSkeleton(false)
      }
    })()
    return () => {
      cancelled = true
      if (skeletonTimerRef.current) clearTimeout(skeletonTimerRef.current)
    }
  }, [chatId, setMessagesWindow])

  // ── Autoscroll — общий движок «прилип/отлип» (useChatAutoscroll, как в
  // основном чате). Прилип → rAF-loop плавно догоняет любой рост; колесо/
  // touch/скроллбар вверх → мгновенный отлип; ручной доезд до низа → прилип.

  // Reverse-infinite scroll
  const prependingRef = useRef<{ oldScrollHeight: number; oldScrollTop: number } | null>(null)
  const loadOlderMessages = useCallback(async () => {
    const st = useChatStore.getState()
    if (st.messagesByChat[chatId]?.hasOlder === false || isLoadingOlder) return
    const entry = st.messagesByChat[chatId]
    const oldest = entry?.messages[0]
    if (!oldest) return
    const el = scrollContainerRef.current
    if (el) prependingRef.current = { oldScrollHeight: el.scrollHeight, oldScrollTop: el.scrollTop }
    setIsLoadingOlder(true)
    try {
      const res = await window.syntee.chat.getMessagesPage(chatId, 20, oldest.createdAt, oldest.id)
      prependOlderMessages(chatId, res.messages, res.hasMore)
    } catch {
      setIsLoadingOlder(false)
    }
  }, [chatId, isLoadingOlder, prependOlderMessages])
  const loadOlderRef = useRef(loadOlderMessages)
  loadOlderRef.current = loadOlderMessages

  const {
    showScrollDownBtn,
    pin: pinAutoscroll,
    syncScrollState,
    handleScroll,
    handleWheel,
    handleTouchStart,
    handleTouchMove,
  } = useChatAutoscroll({
    scrollContainerRef,
    onScrollExtra: () => {
      const el = scrollContainerRef.current
      if (!el) return
      if (el.scrollTop < 200 && hasOlderMessages && !isLoadingOlder) loadOlderRef.current()
    },
  })

  useLayoutEffect(() => {
    const snap = prependingRef.current
    if (!snap) return
    const el = scrollContainerRef.current
    prependingRef.current = null
    if (!el) return
    const delta = el.scrollHeight - snap.oldScrollHeight
    if (delta > 0) {
      el.scrollTop = snap.oldScrollTop + delta
      // Внешняя запись scrollTop — синхронизируем refs движка автоскролла.
      syncScrollState()
    }
  }, [messages.length, syncScrollState])

  // Плавный скролл вниз по клику на floating-кнопку + закрепление.
  const handleScrollDownClick = () => pinAutoscroll()

  // Первый скролл при открытии чата — мгновенно к низу + прилип. Дальнейшее
  // следование за ростом контента делает rAF-loop движка автоскролла.
  useEffect(() => {
    if (messages.length === 0) return
    if (isInitialScrollRef.current) {
      requestAnimationFrame(() => { pinAutoscroll(true); isInitialScrollRef.current = false })
    }
  }, [messages.length, isTyping, pinAutoscroll])

  // Отступ под ChatInput
  useEffect(() => {
    const holder = chatInputWrapRef.current
    const container = holder?.parentElement
    const wrap = holder?.firstElementChild as HTMLElement | null
    if (!wrap || !container) return
    const apply = () => container.style.setProperty('--chat-input-h', `${wrap.offsetHeight}px`)
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  // Звук завершения
  const prevIsTypingRef = useRef(false)
  useEffect(() => {
    if (prevIsTypingRef.current && !isTyping) playDoneSound()
    prevIsTypingRef.current = isTyping
  }, [isTyping])

  // ── Контекст-счётчик ──
  const contextInfo = useContextCounter({
    chatId,
    currentInput: draft,
    modelId: mainModelId,
    incognito: isIncognito,
    enabled: showContextRing && !isIncognito,
    messageCount: messages.length,
    isRunning: isTyping,
  })

  const persistModes = useCallback((p: boolean, i: boolean, a: boolean) => {
    if (!chatId || isIncognito) return
    window.syntee.chat.setModes(chatId, { planningMode: p, imageMode: i, askMode: a }).catch(() => {})
  }, [chatId, isIncognito])

  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleDraftChange = useCallback((text: string) => {
    setDraft(text)
    if (!chatId || isIncognito) return
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current)
    draftSaveTimerRef.current = setTimeout(() => {
      window.syntee.chat.setDraft(chatId, text).catch(() => {})
    }, 300)
  }, [chatId, isIncognito])

  const attTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleAttachmentsChange = useCallback((atts: Attachment[]) => {
    setDraftAttachments(atts)
    if (!chatId || isIncognito) return
    if (attTimerRef.current) clearTimeout(attTimerRef.current)
    attTimerRef.current = setTimeout(() => {
      window.syntee.draft.setAttachments(chatId, atts).catch(() => {})
    }, 300)
  }, [chatId, isIncognito])

  const handleReasoningChange = useCallback((value: string) => {
    setReasoningValue(value)
    window.syntee.settings.set('reasoningValue', value).catch(() => {})
  }, [])

  const handleMainModelChange = useCallback(async (modelId: string, providerId: string) => {
    try {
      await window.syntee.models.setAssignment({ role: 'main', modelId, providerId })
      setMainModelId(modelId)
    } catch (e) {
      console.error('[SplitChatPane] setAssignment', e)
    }
  }, [])

  const handleStop = useCallback(() => {
    clearLiveState(chatId)
    window.syntee.chat.stop(chatId)
  }, [chatId, clearLiveState])

  const handlePin = useCallback(() => {}, [])
  const handleCopy = useCallback(() => {}, [])
  const handleReply = useCallback((message: Message) => {
    setReplyTo(prev => prev.some(m => m.id === message.id) ? prev : [...prev, message])
  }, [])
  const handleCancelReply = useCallback((id: string) => {
    setReplyTo(prev => prev.filter(m => m.id !== id))
  }, [])

  const handleRewind = useCallback(async (userMessageId: string) => {
    const result = await window.syntee.chat.rewindTo(chatId, userMessageId) as { messages?: Message[]; error?: string }
    if (result.error) return
    if (result.messages) setMessagesWindow(chatId, result.messages, false)
  }, [chatId, setMessagesWindow])

  const compactSessionStats = useMemo(() => {
    let count = 0, totalTokensSaved = 0
    for (const m of messages) {
      if (m.slashCommand?.name === 'compact' && m.compactStats) {
        count++
        totalTokensSaved += m.compactStats.tokensSaved
      }
    }
    return { count, totalTokensSaved }
  }, [messages])

  const overlayTodo = useMemo(() => {
    if (live.todo.length > 0) return live.todo
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'assistant' || !m.todo?.length) continue
      const unfinished = m.todo.some(it => it.status === 'pending' || it.status === 'in_progress')
      return unfinished ? m.todo : []
    }
    return []
  }, [live.todo, messages])
  const overlayActive = isTyping || overlayTodo.length > 0

  const hasLiveContent = !!streamingText || !!live.thinking || live.steps.length > 0 ||
    live.iters.length > 0 || !!live.text || Object.keys(live.toolProgress).length > 0
  const showLiveBubble = (hasLiveContent || isTyping) && !!live.msgId

  const displayMessages = useMemo(() => {
    let result = messages
    if (showLiveBubble) {
      result = [...result, {
        id: 'split-live-streaming-bubble',
        chatId,
        role: 'assistant' as const,
        content: streamingText || '',
        createdAt: Date.now(),
        isPinned: 0,
        toolSteps: live.steps.length > 0 ? live.steps as Message['toolSteps'] : undefined,
        liveIters: live.iters,
        liveTextAfter: live.text,
        liveTodo: live.todo,
        agentStatus: live.agentStatus,
        toolProgress: live.toolProgress,
        livePlanningMode: planningMode,
        rateLimitSec: live.rateLimitSec > 0 ? live.rateLimitSec : undefined,
        retry: live.retry,
        lastError: live.lastError,
      } as Message & Record<string, unknown>]
    }
    return result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, showLiveBubble, streamingText, live.steps, live.iters, live.text, live.todo, live.toolProgress, live.rateLimitSec, planningMode])

  const getItemKey = useCallback(
    (index: number) => displayMessages[index]?.id ?? index,
    [displayMessages],
  )

  const virtualizer = useVirtualizer({
    count: displayMessages.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 120,
    getItemKey,
    overscan: 10,
    useAnimationFrameWithResizeObserver: true,
  })

  const requestRemeasure = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const rows = el.querySelectorAll('[data-index]')
    if (rows.length === 0) return
    rows.forEach((node) => {
      const idx = Number((node as HTMLElement).getAttribute('data-index'))
      if (!Number.isFinite(idx)) return
      virtualizer.resizeItem(idx, Math.ceil(node.getBoundingClientRect().height))
    })
  }, [virtualizer])

  // ── Отправка ──
  const handleSend = useCallback(async (text: string) => {
    const raw = text.trim()
    if (!raw) return
    const slash = parseSlashCommandWithCustom(raw, customCommands)
    // При отправке — принудительный прилип к низу (как в основном чате).
    pinAutoscroll()

    if (slash?.command.name === 'clear') {
      setMessagesWindow(chatId, [], false)
      return
    }
    if (slash?.command.name === 'sys') {
      if (!slash.args) return
      await window.syntee.models.setParams({ systemPrompt: slash.args })
      return
    }

    const displayContent = raw
    let aiContent: string = raw
    let oneShotSkill: { name: string; instructions: string } | undefined
    let oneShotAllowedTools: string[] | undefined
    let oneShotMode: 'ask' | 'plan' | 'code' | undefined

    if (slash) {
      const sysPrompt = slash.command.systemPrompt(slash.args)
      if (sysPrompt) aiContent = sysPrompt
      if (slash.command.custom) {
        if (slash.command.mode) oneShotMode = slash.command.mode
        if (slash.command.allowedTools?.length) oneShotAllowedTools = slash.command.allowedTools
        if (slash.command.skill) {
          try {
            const skills = await window.syntee.skills.getAll({ projectId: chat?.projectId }) as Array<{ name: string; instructions: string }>
            const found = skills.find(s => s.name === slash.command.skill)
            if (found) oneShotSkill = { name: found.name, instructions: found.instructions }
          } catch { /* ok */ }
        }
      }
    }

    if (replyTo.length > 0) {
      const quotes = replyTo.map(r => {
        const who = r.role === 'user' ? 'Пользователь' : 'Syntee'
        return `> [${who}]: ${r.content.slice(0, 300)}${r.content.length > 300 ? '…' : ''}`
      }).join('\n')
      aiContent = `${quotes}\n\n${aiContent}`
    }

    const userMsg: Message = {
      id: uuid(), chatId, role: 'user',
      content: displayContent, createdAt: Date.now(), isPinned: 0,
      slashCommand: slash ? { name: slash.command.name, args: slash.args } : undefined,
      attachments: draftAttachmentsRef.current.length > 0 ? draftAttachmentsRef.current : undefined,
    }
    setReplyTo([])
    const attachmentsToSend = [...draftAttachmentsRef.current]
    if (!isIncognito) {
      setDraftAttachments([])
      draftAttachmentsRef.current = []
      window.syntee.draft.clearAttachments(chatId).catch(() => {})
    }
    setDraft('')

    const result = await window.syntee.chat.send({
      chatId,
      content: aiContent,
      displayContent: displayContent !== aiContent ? displayContent : undefined,
      slashCommand: slash ? { name: slash.command.name, args: slash.args } : undefined,
      userMsgId: userMsg.id,
      planningMode,
      askMode: askMode || slash?.command.name === 'ask',
      imageMode,
      mode: activeMode,
      oneShotSkill, oneShotAllowedTools, oneShotMode,
      attachments: attachmentsToSend.length > 0 ? attachmentsToSend : undefined,
    }) as { queued?: boolean; assistantMsgId?: string }

    if (result.queued && result.assistantMsgId) {
      enqueuePendingUserMsg(result.assistantMsgId, userMsg)
    } else {
      addMessage(userMsg)
      initChatSend(chatId)
      requestAnimationFrame(() => pinAutoscroll(true))
    }
  }, [chatId, customCommands, replyTo, isIncognito, planningMode, askMode, imageMode, activeMode, addMessage, setMessagesWindow, pinAutoscroll, chat])

  const chatTitle = chat?.title ?? 'Чат'

  return (
    <main className="chat-main split-chat-pane">
      <div className="split-chat-header no-drag">
        <span className="split-chat-header-icon">
          <AppIcon name="columns" size="xs" tone="accent" />
        </span>
        <span className="split-chat-header-title" title={chatTitle}>{chatTitle}</span>
        <button className="split-chat-close" onClick={onClose} title="Закрыть сплит">
          <AppIcon name="x" size="sm" />
        </button>
      </div>
      <LiveTodoBar items={overlayTodo} active={overlayActive} />

      {showSkeleton ? (
        <motion.div key="skel" className="chat-skeleton" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          {[0.4, 0.7, 0.5, 0.9, 0.6, 0.8].map((w, i) => (
            <div key={i} className={`chat-skeleton-row ${i % 3 === 0 ? 'chat-skeleton-row--user' : ''}`}>
              <div className="chat-skeleton-bubble" style={{ width: `${w * 100}%` }} />
            </div>
          ))}
        </motion.div>
      ) : displayMessages.length === 0 && !isTyping ? (
        <div className="chat-empty-state">
          <div className="chat-empty-icon"><Logo size={40} /></div>
          <h2>{chatTitle}</h2>
          <p>Сплит-чат. Напишите сообщение…</p>
        </div>
      ) : (
        <div className="chat-messages" ref={scrollContainerRef} onScroll={handleScroll} onWheel={handleWheel} onTouchStart={handleTouchStart} onTouchMove={handleTouchMove}>
          {isLoadingOlder && (
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex', justifyContent: 'center', padding: '6px 0', zIndex: 2, pointerEvents: 'none' }}>
              <div style={{ width: 18, height: 18, borderRadius: '50%', border: '2px solid rgba(127,127,127,0.25)', borderTopColor: 'rgba(127,127,127,0.7)', animation: 'chat-older-spin 0.7s linear infinite' }} />
            </div>
          )}
          <ChatRemeasureContext.Provider value={requestRemeasure}>
            <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
              {virtualizer.getVirtualItems().map(vItem => {
                const msg = displayMessages[vItem.index]
                const isLive = msg.id === 'split-live-streaming-bubble'
                const liveThinking = isLive && live.thinking
                  ? { text: live.thinking, isLive: live.isThinkingLive, ms: live.thinkingMs }
                  : undefined
                const shouldAnimate = !animatedMsgIdsRef.current.has(msg.id)
                if (shouldAnimate) animatedMsgIdsRef.current.add(msg.id)
                return (
                  <VirtualMessageItem
                    key={msg.id}
                    msg={msg}
                    vItemStart={vItem.start}
                    vItemIndex={vItem.index}
                    measureRef={virtualizer.measureElement}
                    toolOutputMode={toolOutputMode}
                    onPin={handlePin}
                    onCopy={handleCopy}
                    onReply={handleReply}
                    onRewind={handleRewind}
                    liveThinking={liveThinking}
                    isStreaming={isLive && isTyping}
                    isWaiting={isLive && isTyping}
                    rateLimitSec={isLive ? live.rateLimitSec : undefined}
                    shouldAnimate={shouldAnimate}
                  />
                )
              })}
            </div>
          </ChatRemeasureContext.Provider>
        </div>
      )}

      {/* Миникарта сообщений — точки навигации справа по центру панели. */}
      <ChatMinimap
        virtualizer={virtualizer}
        messages={displayMessages}
        scrollContainerRef={scrollContainerRef}
      />

      <AnimatePresence>
        {showScrollDownBtn && (
          <motion.button
            className="chat-scroll-down-btn"
            onClick={handleScrollDownClick}
            initial={{ opacity: 0, y: 8, scale: 0.8 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.8 }}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            whileTap={{ scale: 0.9 }}
            whileHover={{ scale: 1.08 }}
            title="Прокрутить вниз"
          >
            <AppIcon name="chevronDown" size="sm" />
          </motion.button>
        )}
      </AnimatePresence>

      <div ref={chatInputWrapRef} style={{ display: 'contents' }}>
        <ChatInput
          chatId={chatId}
          onSend={handleSend}
          disabled={isTyping}
          isIncognito={isIncognito}
          replyTo={replyTo}
          onCancelReply={handleCancelReply}
          isGenerating={isTyping || isAgentRunning}
          onStop={handleStop}
          contextInfo={contextInfo}
          showContextRing={showContextRing}
          value={draft}
          onChangeValue={handleDraftChange}
          inputHistory={inputHistory}
          mainModelId={mainModelId}
          onMainModelChange={handleMainModelChange}
          reasoningValue={reasoningValue}
          onReasoningChange={handleReasoningChange}
          planningMode={planningMode}
          onPlanningModeChange={(v) => { setPlanningMode(v); persistModes(v, imageModeRef.current, askModeRef.current) }}
          imageMode={imageMode}
          onImageModeChange={(v) => { setImageMode(v); persistModes(planningModeRef.current, v, askModeRef.current) }}
          askMode={askMode}
          onAskModeChange={(v) => { setAskMode(v); persistModes(planningModeRef.current, imageModeRef.current, v) }}
          workdir={currentWorkdir}
          compactSessionStats={compactSessionStats}
          customCommands={customCommands}
          attachments={draftAttachments}
          onAttachmentsChange={handleAttachmentsChange}
        />
      </div>
    </main>
  )
}

export default memo(SplitChatPane)
