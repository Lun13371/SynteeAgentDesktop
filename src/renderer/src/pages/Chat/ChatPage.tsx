import { useEffect, useRef } from 'react'
import { AnimatePresence } from 'framer-motion'
import TitleBar from '../../components/layout/TitleBar/TitleBar'
import Sidebar from '../../components/layout/Sidebar/Sidebar'
import ChatInput from '../../components/ui/ChatInput/ChatInput'
import MessageBubble from '../../components/ui/MessageBubble/MessageBubble'
import TypingIndicator from '../../components/ui/TypingIndicator/TypingIndicator'
import AnimatedBackground from '../../components/ui/AnimatedBackground/AnimatedBackground'
import ToastContainer, { useToast } from '../../components/ui/Toast/Toast'
import { useChatStore } from '../../store/chat.store'
import type { Message } from '../../../../shared/types'
import { v4 as uuid } from 'uuid'
import './ChatPage.css'

export default function ChatPage() {
  const { messages, isTyping, addMessage, setTyping, pinMessage } = useChatStore()
  const { add: addToast } = useToast()
  const bottomRef = useRef<HTMLDivElement>(null)

  // Автоскролл к последнему сообщению
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isTyping])

  const handleSend = (text: string) => {
    const userMsg: Message = {
      id: uuid(),
      chatId: 'demo',
      role: 'user',
      content: text,
      createdAt: Date.now(),
      isPinned: 0,
    }
    addMessage(userMsg)
    setTyping(true)

    // Заглушка ответа — будет заменена в стадии 03 реальным AI
    setTimeout(() => {
      const reply: Message = {
        id: uuid(),
        chatId: 'demo',
        role: 'assistant',
        content: `Привет! Я Syntee — твой персональный ИИ-ассистент. Пока я работаю в демо-режиме без подключения к AI. В стадии 03 здесь появится настоящий ответ от **${text.length > 30 ? 'claude-sonnet-4-6' : 'gemini-3-flash'}**.`,
        createdAt: Date.now(),
        isPinned: 0,
        model: 'demo',
      }
      addMessage(reply)
      setTyping(false)
    }, 1200)
  }

  const handleCopy = () => {
    addToast('Скопировано', 'success')
  }

  const handlePin = (id: string) => {
    pinMessage(id)
    addToast('📌 Сообщение закреплено', 'info')
  }

  return (
    <div className="chat-layout">
      <AnimatedBackground />
      <TitleBar />
      <div className="chat-body">
        <Sidebar />
        <main className="chat-main">
          {messages.length === 0 ? (
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
            </div>
          ) : (
            <div className="chat-messages">
              <AnimatePresence initial={false}>
                {messages.map(msg => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    onPin={handlePin}
                    onCopy={handleCopy}
                  />
                ))}
                {isTyping && <TypingIndicator key="typing" />}
              </AnimatePresence>
              <div ref={bottomRef} />
            </div>
          )}

          <ChatInput onSend={handleSend} disabled={isTyping} />
        </main>
      </div>
      <ToastContainer />
    </div>
  )
}
