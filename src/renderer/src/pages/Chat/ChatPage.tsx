import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useVirtualizer } from '@tanstack/react-virtual'
import { v4 as uuid } from 'uuid'
import { useContextCounter } from '../../hooks/useContextCounter'
import { initChatSend, hydrateFromMain, enqueuePendingUserMsg } from '../../hooks/useChatRunSubscription'
import TitleBar from '../../components/layout/TitleBar/TitleBar'
import Sidebar from '../../components/layout/Sidebar/Sidebar'
import { playDoneSound } from '../../utils/sounds'
import MessageBubble from '../../components/ui/MessageBubble/MessageBubble'
import ChatInput from '../../components/ui/ChatInput/ChatInput'
import LiveTodoBar from '../../components/ui/LiveTodoBar/LiveTodoBar'
import AnimatedBackground from '../../components/ui/AnimatedBackground/AnimatedBackground'
import AppIcon from '../../components/ui/AppIcon/AppIcon'
import ToastContainer, { useToast } from '../../components/ui/Toast/Toast'
import ChatSearch from '../../components/ui/ChatSearch/ChatSearch'
import { useChatStore, EMPTY_LIVE } from '../../store/chat.store'
import { parseSlashCommand } from '../../../../shared/slashCommands'
import type { Chat, Message, ToolOutputMode, Project, QueueItemMeta } from '../../../../shared/types'
import './ChatPage.css'

export default function ChatPage({ embedded = false }: { embedded?: boolean }) {
  const {
    chats, currentChatId, messages,
    setChats, setCurrentChat, setMessages, addMessage,
    pinMessage,
    isIncognito,
    activeMode,
    projects, setProjects, activeProjectId, setActiveProject,
    liveByChat, runStatusByChat, markChatRead,
  } = useChatStore()
  // Live-состояние текущего чата. Раньше было в useState ChatPage и было
  // общим для всех чатов — при переключении утекало в чужой чат. Теперь
  // читаем из store по currentChatId — каждый чат имеет свой LiveState.
  const live = (currentChatId ? liveByChat[currentChatId] : undefined) ?? EMPTY_LIVE
  const isTyping = live.isTyping
  const isAgentRunning = live.isAgentRunning
  const streamingText = live.text

  const { add: toast } = useToast()
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const chatInputWrapRef = useRef<HTMLDivElement>(null)
  const [rateLimitSec, setRateLimitSec] = useState(0)
  const [toolOutputMode, setToolOutputMode] = useState<ToolOutputMode>('normal')
  const [isLoadingMessages, setIsLoadingMessages] = useState(false)
  const [showSkeleton, setShowSkeleton] = useState(false)
  const isInitialScrollRef = useRef(true)
  const skeletonTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatchIds, setSearchMatchIds] = useState<string[]>([])
  const [replyTo, setReplyTo] = useState<Message[]>([])
  const [selectionPopup, setSelectionPopup] = useState<{ x: number; y: number; text: string } | null>(null)
  const [inputText, setInputText] = useState('')
  const [planningMode, setPlanningMode] = useState(false)
  const [imageMode, setImageMode] = useState(false)

  const [showContextRing, setShowContextRing] = useState(true)
  const [mainModelId, setMainModelId] = useState('claude-sonnet-4-6')
  const [reasoningValue, setReasoningValue] = useState('')

  const handleReasoningChange = (value: string) => {
    setReasoningValue(value)
    window.syntee.settings.set('reasoningValue', value).catch(() => {})
  }

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

  // Слежение за rateLimitSec из live-состояния (для WaitingIndicator)
  useEffect(() => {
    setRateLimitSec(live.rateLimitSec)
  }, [live.rateLimitSec])

  // Тосты при терминальных статусах запуска (ошибка/отмена) — только для текущего чата
  const prevRunStatusRef = useRef<string | undefined>(undefined)
  const runStatus = currentChatId ? runStatusByChat[currentChatId] : undefined
  useEffect(() => {
    if (!runStatus) return
    const prev = prevRunStatusRef.current
    // Показываем тост только при переходе в error (не при cancel — это штатная остановка)
    if (runStatus.status === 'error' && prev !== 'error') {
      toast('Ошибка: ' + (runStatus.error ?? 'неизвестная'), 'error')
    }
    prevRunStatusRef.current = runStatus.status
  }, [runStatus, toast])

  // Звук завершения — при переходе running → done/error для текущего чата
  const prevIsTypingRef = useRef(false)
  useEffect(() => {
    if (prevIsTypingRef.current && !isTyping) {
      playDoneSound()
    }
    prevIsTypingRef.current = isTyping
  }, [isTyping])

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

  useEffect(() => {
    window.syntee.agent.getSettings().then((s: { toolOutputMode?: ToolOutputMode }) => {
      if (s.toolOutputMode) setToolOutputMode(s.toolOutputMode)
    }).catch(() => {})
  }, [])

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
      if (all.length > 0) {
        selectChat(all[0].id)
      }
    })
  }, [])

  // АВТОСКРОЛЛ — один источник истины (autoScrollRef), плавный RAF-loop
  // АВТОСКРОЛЛ — максимально простая и надёжная модель.
  //
  // autoScrollRef меняется ТОЛЬКО в трёх случаях:
  //   1. onWheel с deltaY < 0 (колесо вверх) → false (пользователь ушёл вверх)
  //   2. handleSend / selectChat / initial scroll → true (принудительное закрепление)
  //   3. handleScroll когда distFromBottom < 24 → true (пользователь сам доехал до низа)
  //
  // onScroll НЕ отключает autoScroll при отходе от низа — это была главная
  // причина багов: virtualizer перемеряет элементы → scrollHeight меняется →
  // scroll event → ложное отключение. Теперь отключение только через onWheel.
  // onScroll используется исключительно для показа/скрытия кнопки "вниз".
  const autoScrollRef           = useRef(true)
  const scrollRafRef            = useRef<number | null>(null)
  const [showScrollDownBtn, setShowScrollDownBtn] = useState(false)

  const hasScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return false
    return el.scrollHeight - el.clientHeight > 24
  }, [])

  const smoothScrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    // Если loop уже активен — не перезапускаем. Loop в каждом кадре читает
    // свежий scrollHeight и сам двигается к актуальному низу. Перезапуск
    // (cancel + start) создавал "покадровый" дёрганый скролл.
    if (scrollRafRef.current !== null) return

    const animate = () => {
      if (!el) return
      // Пользователь скроллил вверх (onWheel выставил false) — останавливаемся.
      if (!autoScrollRef.current) {
        scrollRafRef.current = null
        return
      }
      const target = el.scrollHeight - el.clientHeight
      const current = el.scrollTop
      const diff = target - current
      if (diff <= 1) {
        if (diff > 0) el.scrollTop = target
        scrollRafRef.current = null
        return
      }
      // Если отставание большое (>40px — контент вырос быстрее) — прыгаем
      // мгновенно к низу. Это убирает "не успевает за ответом": при быстром
      // стриминге скролл следует за контентом без отставания.
      // Если diff маленький — плавный шаг для мягкого сближения у низа.
      if (diff > 40) {
        el.scrollTop = target
      } else {
        // Плавный шаг: Math.max(diff * 0.5, 4) — быстро сходится, минимум 4px.
        const step = Math.max(diff * 0.5, 4)
        el.scrollTop = current + Math.min(step, diff)
      }
      scrollRafRef.current = requestAnimationFrame(animate)
    }
    scrollRafRef.current = requestAnimationFrame(animate)
  }, [])

  const scrollToBottomInstant = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    if (scrollRafRef.current) {
      cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = null
    }
    el.scrollTop = el.scrollHeight - el.clientHeight
  }, [])

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    // onScroll используется ТОЛЬКО для кнопки и закрепления у низа.
    // НЕ отключаем autoScroll здесь — это вызывало ложные отключения из-за
    // virtualizer reflow (scrollHeight меняется после перемера элементов).
    // Отключение только через onWheel (100% пользовательский сигнал).
    if (!hasScroll()) {
      setShowScrollDownBtn(false)
      return
    }
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    // Закрепление: пользователь сам доехал до низа (drag scrollbar, тач).
    if (distFromBottom < 24) {
      autoScrollRef.current = true
      setShowScrollDownBtn(false)
      return
    }
    // Кнопку показываем если отошли от низа.
    setShowScrollDownBtn(true)
  }, [hasScroll])

  // Колесо вверх → мгновенно отключаем авто-скролл.
  // onWheel срабатывает ТОЛЬКО от пользователя, никогда от scrollTop=.
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0) {
      autoScrollRef.current = false
      setShowScrollDownBtn(true)
    }
  }, [])

  // Плавный скролл вниз по клику на floating-кнопку + закрепление.
  const handleScrollDownClick = useCallback(() => {
    autoScrollRef.current = true
    setShowScrollDownBtn(false)
    smoothScrollToBottom()
  }, [smoothScrollToBottom])

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (autoScrollRef.current) smoothScrollToBottom()
    })
    const inner = el.firstElementChild
    if (inner) ro.observe(inner as Element)
    return () => ro.disconnect()
  }, [smoothScrollToBottom])

  // Динамический отступ под ChatInput
  useEffect(() => {
    const holder = chatInputWrapRef.current
    const container = holder?.parentElement
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
      requestAnimationFrame(() => { scrollToBottomInstant(); isInitialScrollRef.current = false })
      autoScrollRef.current = true
      setShowScrollDownBtn(false)
    } else if (autoScrollRef.current) {
      smoothScrollToBottom()
    }
  }, [messages.length, isTyping, isLoadingMessages, smoothScrollToBottom, scrollToBottomInstant])

  // Автоскролл при стриминге — единый путь через smoothScrollToBottom.
  // (Раньше тут был прямой прыжок el.scrollTop = ... — конкурировал с
  // RAF-loop из ResizeObserver и вызывал рывки/джиттер.)
  useEffect(() => {
    if (!autoScrollRef.current || !isTyping) return
    smoothScrollToBottom()
  }, [streamingText, live.iters, live.steps, isTyping, smoothScrollToBottom])

  const selectChat = async (id: string) => {
    setIsLoadingMessages(true)
    isInitialScrollRef.current = true
    autoScrollRef.current = true
    if (scrollRafRef.current) { cancelAnimationFrame(scrollRafRef.current); scrollRafRef.current = null }
    skeletonTimerRef.current = setTimeout(() => setShowSkeleton(true), 120)
    setCurrentChat(id)
    // Сбрасываем unread-бейдж этого чата (пользователь его увидел)
    markChatRead(id)
    // Гидрируем live-состояние из main — если в чате работает агент,
    // показываем накопленный прогресс (текст/шаги/thinking), а не пустой пузырь.
    // hydrateFromMain также подтягивает meta активного запуска для панели очереди.
    await hydrateFromMain(id)
    // Подтягиваем очередь ожидающих запросов из main — чтобы бейдж очереди
    // сразу показал счётчик при возврате в чат с queued-запросами.
    try {
      const queue = await window.syntee.chat.getQueue(id) as QueueItemMeta[]
      useChatStore.getState().setQueue(id, queue)
    } catch { /* ok — очередь пуста или ещё не загружена */ }
    const msgs: Message[] = await window.syntee.chat.getMessages(id)
    setMessages(msgs)
    if (skeletonTimerRef.current) clearTimeout(skeletonTimerRef.current)
    setShowSkeleton(false)
    setIsLoadingMessages(false)
  }

  const createNewChat = async (projectId?: string) => {
    let pid = projectId ?? activeProjectId
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

    // При отправке сообщения — принудительно закрепляем авто-скролл.
    // Пользователь ожидает увидеть своё сообщение и ответ, даже если до этого
    // скроллил вверх по истории.
    autoScrollRef.current = true
    setShowScrollDownBtn(false)

    if (slash?.command.name === 'clear') {
      if (currentChatId) { setMessages([]); toast('Чат очищен', 'info') }
      return
    }
    if (slash?.command.name === 'sys') {
      if (!slash.args) { toast('Укажи промпт: /sys ты поэт', 'info'); return }
      await window.syntee.models.setParams({ systemPrompt: slash.args })
      toast('Системный промпт обновлен', 'success')
      return
    }
    if (slash?.command.name === 'image') {
      if (!slash.args) { toast('Укажи описание: /image красивый закат', 'info'); return }
    }

    let chatId = currentChatId
    if (!chatId) {
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

    const displayContent = raw
    let aiContent: string = raw

    if (slash) {
      const sysPrompt = slash.command.systemPrompt(slash.args)
      if (sysPrompt) aiContent = sysPrompt
    }

    if (replyTo.length > 0) {
      const quotes = replyTo.map(r => {
        const who = r.role === 'user' ? 'Пользователь' : 'Syntee'
        return `> [${who}]: ${r.content.slice(0, 300)}${r.content.length > 300 ? '…' : ''}`
      }).join('\n')
      aiContent = `${quotes}\n\n${aiContent}`
    }

    const userMsg: Message = {
      id: uuid(), chatId,
      role: 'user',
      content: displayContent,
      createdAt: Date.now(),
      isPinned: 0,
      slashCommand: slash ? { name: slash.command.name, args: slash.args } : undefined,
    }
    setReplyTo([])

    // Отправляем запрос. Если в чате уже идёт генерация — main поставит
    // в очередь и вернёт { queued: true }. В этом случае НЕ добавляем
    // user-сообщение сразу и НЕ инициализируем live-буфер — иначе все
    // queued-сообщения появятся в чате подряд (user1 user2 user3), а
    // ответы придут позже (assistant1 assistant2 assistant3). Вместо этого
    // откладываем до статуса 'running' (когда запрос реально стартует) —
    // порядок будет нормальным: user1 → assistant1 → user2 → assistant2.
    const result = await window.syntee.chat.send({
      chatId,
      content: aiContent,
      displayContent: displayContent !== aiContent ? displayContent : undefined,
      slashCommand: slash ? { name: slash.command.name, args: slash.args } : undefined,
      userMsgId: userMsg.id,
      planningMode,
      imageMode,
      mode: activeMode,
    }) as { queued?: boolean; assistantMsgId?: string }

    if (result.queued && result.assistantMsgId) {
      // Запрос поставлен в очередь — откладываем user-сообщение до старта.
      enqueuePendingUserMsg(result.assistantMsgId, userMsg)
    } else {
      // Запрос стартовал сразу — показываем user-сообщение и live-пузырь.
      addMessage(userMsg)
      initChatSend(chatId)
      // Принудительно скроллим вниз в следующем кадре — addMessage обновит
      // DOM, и scrollHeight станет актуальным. Без этого в новом чате
      // (где isInitialScrollRef=true) эффект мог не сработать вовремя.
      requestAnimationFrame(() => {
        autoScrollRef.current = true
        setShowScrollDownBtn(false)
        scrollToBottomInstant()
      })
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

  // Собираем отображаемые сообщения (включая live-пузырь текущего чата)
  const hasLiveContent = !!streamingText || !!live.thinking || live.steps.length > 0 ||
    live.iters.length > 0 || !!live.text
  const showLiveBubble = (hasLiveContent || isTyping) && !!live.msgId

  const currentWorkdir = useMemo(() => {
    if (!currentChatId || isIncognito) return undefined
    return chats.find(c => c.id === currentChatId)?.workdir
  }, [chats, currentChatId, isIncognito])

  const activeProject = useMemo(() => {
    if (!currentChatId) return undefined
    const chat = chats.find(c => c.id === currentChatId)
    if (!chat?.projectId) return undefined
    return projects.find(p => p.id === chat.projectId)
  }, [chats, currentChatId, projects])

  // ── Оверлей-план (LiveTodoBar): показываем последний актуальный todo.
  // Приоритет:
  //  1) live.todo — текущий стримящийся план (или только что завершённый,
  //     пока clearLiveState не сбросил состояние).
  //  2) Самый свежий todo из истории сообщений (message.todo), сканируем
  //     с конца. Берём ПЕРВЫЙ найденный todo — более свежий перекрывает
  //     старые (решение "Заменить на новый" при конфликте). Если этот
  //     todo незавершённый — показываем. Если завершён (все done/skipped)
  //     — оверлей скрываем, даже если более старые todo висят незавершёнными.
  //     Это исправляет баг: AI закрыл todo в новом сообщении, но оверлей
  //     продолжал показывать старый незавершённый.
  const overlayTodo = useMemo(() => {
    type TodoItem = { text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }
    if (live.todo.length > 0) return live.todo as TodoItem[]
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'assistant' || !m.todo?.length) continue
      // Нашли самый свежий todo. Если незавершён — показываем.
      // Если завершён — оверлей не нужен (возвращаем пустой массив,
      // более старые todo перекрыты этим).
      const unfinished = m.todo.some(it => it.status === 'pending' || it.status === 'in_progress')
      return unfinished ? m.todo : []
    }
    return []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.todo, messages])

  const overlayActive = isTyping || overlayTodo.length > 0

  const displayMessages = useMemo(() => showLiveBubble
    ? [...messages, {
        // Фиксированный id/key для live-пузыря на весь период стриминга.
        // Раньше id = live.msgId, который менялся 'streaming-pending' →
        // реальному uuid при приходе первого токена/step — это вызывало
        // размонтирование/монтирование элемента и скачок перемера высоты
        // → рывок скролла в начале ответа. Фиксированный id сохраняет
        // React-элемент между фазами, перемер проходит гладко.
        id: 'live-streaming-bubble',
        chatId: currentChatId || '',
        role: 'assistant' as const,
        content: streamingText || '',
        createdAt: Date.now(),
        isPinned: 0,
        toolSteps: live.steps.length > 0 ? live.steps as Message['toolSteps'] : undefined,
        // liveIters/liveTextAfter/liveTodo/agentStatus передаются через
        // расширение объекта — MessageBubble читает их через cast.
        liveIters: live.iters,
        liveTextAfter: live.text,
        liveTodo: live.todo,
        agentStatus: live.agentStatus,
        rateLimitSec: rateLimitSec > 0 ? rateLimitSec : undefined,
      } as Message & Record<string, unknown>]
    : messages
  // eslint-disable-next-line react-hooks/exhaustive-deps
  , [messages, showLiveBubble, streamingText, live.steps, live.iters, live.text, live.todo, live.msgId, rateLimitSec])

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
          <LiveTodoBar items={overlayTodo} active={overlayActive} />

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
              onWheel={handleWheel}
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
                  const isLive = msg.id === 'live-streaming-bubble'
                  const liveThinking = isLive && live.thinking
                    ? { text: live.thinking, isLive: live.isThinkingLive, ms: live.thinkingMs }
                    : undefined
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
                        liveThinking={liveThinking}
                        isStreaming={isLive && isTyping}
                        isWaiting={isLive && isTyping}
                        rateLimitSec={isLive ? rateLimitSec : undefined}
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Floating-кнопка «прокрутить вниз» — компактная, по центру,
              чуть выше инпут-бара. Появляется когда пользователь отошёл
              от низа (autoScroll=false). Клик — плавный скролл + закрепление. */}
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
              chatId={currentChatId ?? undefined}
              onSend={handleSend}
              disabled={isTyping}
              isIncognito={isIncognito}
              replyTo={replyTo}
              onCancelReply={(id) => setReplyTo(prev => prev.filter(r => r.id !== id))}
              isGenerating={isTyping || isAgentRunning}
              onStop={() => currentChatId && window.syntee.chat.stop(currentChatId)}
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
