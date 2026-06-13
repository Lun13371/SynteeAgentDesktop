import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { v4 as uuid } from 'uuid'
import { useContextCounter } from '../../hooks/useContextCounter'
import TitleBar from '../../components/layout/TitleBar/TitleBar'
import Sidebar from '../../components/layout/Sidebar/Sidebar'
import MessageBubble from '../../components/ui/MessageBubble/MessageBubble'
import ChatInput from '../../components/ui/ChatInput/ChatInput'
import TypingIndicator from '../../components/ui/TypingIndicator/TypingIndicator'
import AnimatedBackground from '../../components/ui/AnimatedBackground/AnimatedBackground'
import AppIcon from '../../components/ui/AppIcon/AppIcon'
import ToastContainer, { useToast } from '../../components/ui/Toast/Toast'
import ToolChain from '../../components/ui/ToolChain/ToolChain'
import ChatSearch from '../../components/ui/ChatSearch/ChatSearch'
import { useChatStore } from '../../store/chat.store'
import { IPC_EVENTS } from '../../../../shared/constants'
import type { Chat, Message, ToolOutputMode } from '../../../../shared/types'
import './ChatPage.css'

export default function ChatPage({ embedded = false }: { embedded?: boolean }) {
  const {
    chats, currentChatId, messages, isTyping, streamingText,
    setChats, setCurrentChat, setMessages, addMessage,
    appendStreamToken, clearStream, setTyping, pinMessage,
    isIncognito, toggleIncognito,
  } = useChatStore()

  const { add: toast } = useToast()
  const bottomRef = useRef<HTMLDivElement>(null)
  const streamMsgIdRef = useRef<string | null>(null)
  const [rateLimitSec, setRateLimitSec] = useState(0)
  const [toolOutputMode, setToolOutputMode] = useState<ToolOutputMode>('normal')
  const [isAgentRunning, setIsAgentRunning] = useState(false)
  const [isLoadingMessages, setIsLoadingMessages] = useState(false)
  const [showSkeleton, setShowSkeleton] = useState(false)
  const isInitialScrollRef = useRef(true)
  const skeletonTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [liveSteps, setLiveSteps] = useState<import('../../components/ui/ToolChain/ToolChain').ToolStep[]>([])
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatchIds, setSearchMatchIds] = useState<string[]>([])
  const [replyTo, setReplyTo] = useState<Message[]>([])
  const [selectionPopup, setSelectionPopup] = useState<{ x: number; y: number; text: string } | null>(null)
  const [inputText, setInputText] = useState('')

  // Настройка показа счётчика контекста
  const [showContextRing, setShowContextRing] = useState(true)
  const [mainModelId, setMainModelId] = useState('claude-sonnet-4-6')

  useEffect(() => {
    window.syntee.settings.get('showContextRing').then((v: unknown) => {
      if (v !== null && v !== undefined) setShowContextRing(v as boolean)
    }).catch(() => {})
    window.syntee.settings.get('modelAssignments').then((v: unknown) => {
      if (Array.isArray(v)) {
        const main = (v as Array<{ role: string; modelId: string }>).find(a => a.role === 'main')
        if (main?.modelId) setMainModelId(main.modelId)
      }
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
      setSelectionPopup({ x: e.clientX, y: e.clientY - 48, text })
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

  // Загрузка чатов при старте
  useEffect(() => {
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

  useEffect(() => {
    const offToken = window.syntee.on(IPC_EVENTS.CHAT_STREAM_TOKEN, (data: {
      chatId: string; msgId: string; token?: string
      thinkingToken?: string; thinkingDone?: boolean; thinkingMs?: number
    }) => {
      if (data.chatId !== currentChatId) return
      streamMsgIdRef.current = data.msgId

      if (data.thinkingToken) {
        const tok = typeof data.thinkingToken === 'string' ? data.thinkingToken : String(data.thinkingToken ?? '')
        setLiveThinking(prev => ({ text: (prev?.text ?? '') + tok, isLive: true }))
        return
      }
      if (data.thinkingDone) {
        setLiveThinking(prev => prev ? { ...prev, isLive: false, ms: data.thinkingMs } : null)
        return
      }
      if (data.token) {
        appendStreamToken(data.token)
      }
    })

    const offDone = window.syntee.on(IPC_EVENTS.CHAT_STREAM_DONE, (data: { chatId: string; message: Message }) => {
      if (data.chatId !== currentChatId) return
      addMessage(data.message)
      clearStream()
      setTyping(false)
      setLiveThinking(null)
      streamMsgIdRef.current = null
      setLiveThinking(null)
      setIsAgentRunning(false)
      setLiveSteps([])
      window.syntee.chat.getAll().then((all: Chat[]) => setChats(all))
    })

    const offError = window.syntee.on(IPC_EVENTS.CHAT_STREAM_ERROR, (data: { error: string }) => {
      clearStream()
      setTyping(false)
      setLiveThinking(null)
      setIsAgentRunning(false)
      setToolSteps([])
      toast('Ошибка: ' + data.error, 'error')
    })

    const offRateLimit = window.syntee.on(IPC_EVENTS.RATE_LIMIT, (data: { waitSec: number }) => {
      setRateLimitSec(data.waitSec)
      toast(`Rate limit — ожидание ${data.waitSec}с`, 'info', 4000)
      setTimeout(() => setRateLimitSec(0), data.waitSec * 1000)
    })

    // Шаги агента
    const offStep = window.syntee.on('agent:step', (step: {
      type: string; toolName?: string; toolArgs?: Record<string, unknown>; content: string; success?: boolean
    }) => {
      if (step.type === 'tool_call' || step.type === 'tool_result') {
        setIsAgentRunning(true)
        setLiveSteps(prev => [...prev, {
          id: uuid(),
          type: step.type as 'tool_call' | 'tool_result',
          toolName: step.toolName,
          toolArgs: step.toolArgs,
          content: step.content,
          success: step.success,
          timestamp: Date.now(),
        }])
      }
    })

    return () => { offToken(); offDone(); offError(); offRateLimit(); offStep() }
  }, [currentChatId])

  // Автоскролл — instant при переключении, smooth при новых сообщениях
  useEffect(() => {
    if (isLoadingMessages) return
    const behavior = isInitialScrollRef.current ? 'instant' : 'smooth'
    // двойной rAF — гарантирует что layout + paint завершены
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: behavior as ScrollBehavior })
        isInitialScrollRef.current = false
      })
    })
  }, [messages, streamingText, isTyping, isLoadingMessages])

  const selectChat = async (id: string) => {
    setIsLoadingMessages(true)
    isInitialScrollRef.current = true
    // показываем скелетон только если грузится дольше 120мс
    skeletonTimerRef.current = setTimeout(() => setShowSkeleton(true), 120)
    setCurrentChat(id)
    const msgs: Message[] = await window.syntee.chat.getMessages(id)
    setMessages(msgs)
    if (skeletonTimerRef.current) clearTimeout(skeletonTimerRef.current)
    setShowSkeleton(false)
    setIsLoadingMessages(false)
  }

  const createNewChat = async () => {
    const chat: Chat = await window.syntee.chat.create(isIncognito)
    const all: Chat[] = await window.syntee.chat.getAll()
    setChats(all)
    setCurrentChat(chat.id)
    setMessages([])
  }

  const handleSend = async (text: string) => {
    let chatId = currentChatId

    // Если нет активного чата — создаём
    if (!chatId) {
      const chat: Chat = await window.syntee.chat.create(isIncognito)
      chatId = chat.id
      setCurrentChat(chatId)
      setMessages([])
      const all: Chat[] = await window.syntee.chat.getAll()
      setChats(all)
    }

    // Формируем контент с цитатами reply
    let fullContent = text
    if (replyTo.length > 0) {
      const quotes = replyTo.map(r => {
        const who = r.role === 'user' ? 'Пользователь' : 'Syntee'
        return `> [${who}]: ${r.content.slice(0, 300)}${r.content.length > 300 ? '…' : ''}`
      }).join('\n')
      fullContent = `${quotes}\n\n${text}`
    }

    // Показываем сообщение пользователя сразу
    const userMsg: Message = {
      id: uuid(), chatId,
      role: 'user', content: fullContent,
      createdAt: Date.now(), isPinned: 0,
    }
    addMessage(userMsg)
    setTyping(true)
    setReplyTo([]) // очищаем reply после отправки

    // Отправляем в main process
    await window.syntee.chat.send({ chatId, content: fullContent, incognito: isIncognito })
  }

  const handlePin = async (id: string) => {
    await window.syntee.chat.pin(id)
    pinMessage(id)
    toast('Сообщение закреплено', 'info')
  }

  const handleCopy = () => toast('Скопировано', 'success')

  // Собираем отображаемые сообщения (включая стриминг)
  const displayMessages = streamingText || liveThinking || liveSteps.length > 0
    ? [...messages, {
        id: streamMsgIdRef.current || 'streaming',
        chatId: currentChatId || '',
        role: 'assistant' as const,
        content: streamingText || '',
        createdAt: Date.now(),
        isPinned: 0,
        // liveSteps едут прямо в пузырь — не исчезают а переезжают
        toolSteps: liveSteps.length > 0 ? liveSteps as Message['toolSteps'] : undefined,
      }]
    : messages

  return (
    <div className={`chat-layout ${embedded ? 'chat-layout--embedded' : ''}`}>
      {!embedded && <AnimatedBackground />}
      {!embedded && <TitleBar onSettingsClick={() => {}} />}
      <div className="chat-body">
        <Sidebar
          chats={chats}
          currentChatId={currentChatId}
          onSelectChat={selectChat}
          onNewChat={createNewChat}
          onChatsUpdate={setChats}
        />
        <main className="chat-main">
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
            </div>
          ) : (
            <div className="chat-messages">
                {displayMessages.map(msg => (
                  <div key={msg.id} data-msg-id={msg.id}>
                    <MessageBubble
                      message={msg}
                      toolOutputMode={toolOutputMode}
                      onPin={handlePin}
                      onCopy={handleCopy}
                      onReply={(msg) => setReplyTo(prev => prev.find(r => r.id === msg.id) ? prev : [...prev, msg])}
                      searchQuery={searchMatchIds.includes(msg.id) ? searchQuery : undefined}
                      liveThinking={msg.id === (streamMsgIdRef.current || 'streaming') ? liveThinking ?? undefined : undefined}
                      isStreaming={msg.id === (streamMsgIdRef.current || 'streaming') && isTyping}
                    />
                  </div>
                ))}
                {isTyping && !streamingText && !liveThinking && liveSteps.length === 0 && <TypingIndicator key="typing" />}
              <div ref={bottomRef} />
            </div>
          )}

          {rateLimitSec > 0 && (
            <div className="rate-limit-bar">
              <AppIcon name="loader" size="sm" tone="warning" animation="spin" />
              <span>Ожидание rate limit: {rateLimitSec}с</span>
            </div>
          )}

          <ChatInput
            onSend={handleSend}
            disabled={isTyping}
            isIncognito={isIncognito}
            replyTo={replyTo}
            onCancelReply={(id) => setReplyTo(prev => prev.filter(r => r.id !== id))}
            isGenerating={isTyping}
            onStop={() => window.syntee.chat.stop()}
            contextInfo={contextInfo}
            showContextRing={showContextRing}
            onInputChange={setInputText}
          />

          {/* Selection reply popup */}
          {selectionPopup && (
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
            </div>
          )}
        </main>
      </div>
      {!embedded && (
        <ToastContainer />
      )}
    </div>
  )
}
