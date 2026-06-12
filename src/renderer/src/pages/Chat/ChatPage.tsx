import { useEffect, useRef, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { v4 as uuid } from 'uuid'
import TitleBar from '../../components/layout/TitleBar/TitleBar'
import Sidebar from '../../components/layout/Sidebar/Sidebar'
import MessageBubble from '../../components/ui/MessageBubble/MessageBubble'
import ChatInput from '../../components/ui/ChatInput/ChatInput'
import TypingIndicator from '../../components/ui/TypingIndicator/TypingIndicator'
import AnimatedBackground from '../../components/ui/AnimatedBackground/AnimatedBackground'
import AppIcon from '../../components/ui/AppIcon/AppIcon'
import ToastContainer, { useToast } from '../../components/ui/Toast/Toast'
import ToolChain from '../../components/ui/ToolChain/ToolChain'
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
  const isInitialScrollRef = useRef(true)
  const [liveSteps, setLiveSteps] = useState<import('../../components/ui/ToolChain/ToolChain').ToolStep[]>([])

  // Загружаем toolOutputMode
  useEffect(() => {
    window.syntee.agent.getSettings().then((s: { toolOutputMode?: ToolOutputMode }) => {
      if (s.toolOutputMode) setToolOutputMode(s.toolOutputMode)
    }).catch(() => {})
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
  useEffect(() => {
    const offToken = window.syntee.on(IPC_EVENTS.CHAT_STREAM_TOKEN, (data: { chatId: string; msgId: string; token: string }) => {
      if (data.chatId !== currentChatId) return
      streamMsgIdRef.current = data.msgId
      appendStreamToken(data.token)
    })

    const offDone = window.syntee.on(IPC_EVENTS.CHAT_STREAM_DONE, (data: { chatId: string; message: Message }) => {
      if (data.chatId !== currentChatId) return
      addMessage(data.message)
      clearStream()
      streamMsgIdRef.current = null
      setIsAgentRunning(false)
      // Сворачиваем live цепочку через 400мс
      setTimeout(() => setLiveSteps([]), 400)
      window.syntee.chat.getAll().then((all: Chat[]) => setChats(all))
    })

    const offError = window.syntee.on(IPC_EVENTS.CHAT_STREAM_ERROR, (data: { error: string }) => {
      clearStream()
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
    if (!bottomRef.current) return
    if (isLoadingMessages) return // ждём пока загрузится
    const behavior = isInitialScrollRef.current ? 'instant' : 'smooth'
    // requestAnimationFrame гарантирует что DOM уже отрендерен
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: behavior as ScrollBehavior })
      isInitialScrollRef.current = false
    })
  }, [messages, streamingText, isTyping, isLoadingMessages])

  const selectChat = async (id: string) => {
    setIsLoadingMessages(true)
    isInitialScrollRef.current = true
    setCurrentChat(id)
    const msgs: Message[] = await window.syntee.chat.getMessages(id)
    setMessages(msgs)
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

    // Показываем сообщение пользователя сразу
    const userMsg: Message = {
      id: uuid(), chatId,
      role: 'user', content: text,
      createdAt: Date.now(), isPinned: 0,
    }
    addMessage(userMsg)
    setTyping(true)

    // Отправляем в main process
    await window.syntee.chat.send({ chatId, content: text, incognito: isIncognito })
  }

  const handlePin = async (id: string) => {
    await window.syntee.chat.pin(id)
    pinMessage(id)
    toast('Сообщение закреплено', 'info')
  }

  const handleCopy = () => toast('Скопировано', 'success')

  // Собираем отображаемые сообщения (включая стриминг)
  const displayMessages = streamingText
    ? [...messages, {
        id: streamMsgIdRef.current || 'streaming',
        chatId: currentChatId || '',
        role: 'assistant' as const,
        content: streamingText,
        createdAt: Date.now(),
        isPinned: 0,
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
          <AnimatePresence mode="wait">
          {isLoadingMessages ? (
            <motion.div
              key="skeleton"
              className="chat-skeleton"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
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
              <AnimatePresence initial={false}>
                {displayMessages.map(msg => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    toolOutputMode={toolOutputMode}
                    onPin={handlePin}
                    onCopy={handleCopy}
                  />
                ))}
                {isTyping && !streamingText && <TypingIndicator key="typing" />}
              </AnimatePresence>
              {/* Live tool chain — пока агент работает */}
              {liveSteps.length > 0 && (
                <div className="chat-tool-chain-wrap">
                  <ToolChain steps={liveSteps} mode={toolOutputMode} isRunning={isAgentRunning} />
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
          </AnimatePresence>

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
          />
        </main>
      </div>
      {!embedded && (
        <ToastContainer />
      )}
    </div>
  )
}
