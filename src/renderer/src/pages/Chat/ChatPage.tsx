import { useEffect, useRef, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { v4 as uuid } from 'uuid'
import TitleBar from '../../components/layout/TitleBar/TitleBar'
import Sidebar from '../../components/layout/Sidebar/Sidebar'
import MessageBubble from '../../components/ui/MessageBubble/MessageBubble'
import ChatInput from '../../components/ui/ChatInput/ChatInput'
import TypingIndicator from '../../components/ui/TypingIndicator/TypingIndicator'
import AnimatedBackground from '../../components/ui/AnimatedBackground/AnimatedBackground'
import AgentPanel from '../../components/ui/AgentPanel/AgentPanel'
import '../../components/ui/AgentPanel/AgentPanel.css'
import ToastContainer, { useToast } from '../../components/ui/Toast/Toast'
import { useChatStore } from '../../store/chat.store'
import { IPC_EVENTS } from '../../../../shared/constants'
import type { Chat, Message } from '../../../../shared/types'
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
  const [showAgent, setShowAgent] = useState(false)

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
      // Обновляем список чатов (новое название)
      window.syntee.chat.getAll().then((all: Chat[]) => setChats(all))
    })

    const offError = window.syntee.on(IPC_EVENTS.CHAT_STREAM_ERROR, (data: { error: string }) => {
      clearStream()
      toast('Ошибка: ' + data.error, 'error')
    })

    const offRateLimit = window.syntee.on(IPC_EVENTS.RATE_LIMIT, (data: { waitSec: number }) => {
      setRateLimitSec(data.waitSec)
      toast(`⏳ Rate limit — ожидание ${data.waitSec}с`, 'info', 4000)
      setTimeout(() => setRateLimitSec(0), data.waitSec * 1000)
    })

    return () => { offToken(); offDone(); offError(); offRateLimit() }
  }, [currentChatId])

  // Автоскролл
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText, isTyping])

  const selectChat = async (id: string) => {
    setCurrentChat(id)
    const msgs: Message[] = await window.syntee.chat.getMessages(id)
    setMessages(msgs)
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
    toast('📌 Сообщение закреплено', 'info')
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
      {!embedded && <TitleBar onSettingsClick={() => {}} onAgentClick={() => setShowAgent(p => !p)} />}
      <div className="chat-body">
        <Sidebar
          chats={chats}
          currentChatId={currentChatId}
          onSelectChat={selectChat}
          onNewChat={createNewChat}
          isIncognito={isIncognito}
          onToggleIncognito={toggleIncognito}
        />
        <main className="chat-main">
          {displayMessages.length === 0 && !isTyping ? (
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
                <p style={{ color: 'rgba(150,100,255,0.8)', fontSize: 12, marginTop: -8 }}>
                  🔒 Режим инкогнито — чат не сохраняется
                </p>
              )}
            </div>
          ) : (
            <div className="chat-messages">
              <AnimatePresence initial={false}>
                {displayMessages.map(msg => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    onPin={handlePin}
                    onCopy={handleCopy}
                  />
                ))}
                {isTyping && !streamingText && <TypingIndicator key="typing" />}
              </AnimatePresence>
              <div ref={bottomRef} />
            </div>
          )}

          {rateLimitSec > 0 && (
            <div className="rate-limit-bar">
              ⏳ Ожидание rate limit: {rateLimitSec}с
            </div>
          )}

          <ChatInput
            onSend={handleSend}
            disabled={isTyping}
            isIncognito={isIncognito}
          />
        </main>
        <AnimatePresence>
          {showAgent && <AgentPanel onClose={() => setShowAgent(false)} />}
        </AnimatePresence>
      </div>
      {!embedded && (
        <ToastContainer />
      )}
    </div>
  )
}
