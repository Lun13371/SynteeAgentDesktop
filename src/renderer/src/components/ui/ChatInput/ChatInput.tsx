import { useState, useRef, useEffect, KeyboardEvent } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import './ChatInput.css'

interface ChatInputProps {
  onSend: (text: string) => void
  onAttach?: () => void
  disabled?: boolean
  isIncognito?: boolean
}

export default function ChatInput({ onSend, onAttach, disabled, isIncognito }: ChatInputProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Авто-ресайз textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }, [value])

  const handleSend = () => {
    const text = value.trim()
    if (!text || disabled) return
    onSend(text)
    setValue('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className={`chat-input-wrap ${isIncognito ? 'chat-input-wrap--incognito' : ''}`}>
      <div className="chat-input-box glass">
        {/* Кнопка прикрепить */}
        <motion.button
          className="chat-input-btn"
          whileTap={{ scale: 0.88 }}
          whileHover={{ scale: 1.05 }}
          onClick={onAttach}
          title="Прикрепить файл"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M15.5 8.5l-6.8 6.8a4.5 4.5 0 01-6.4-6.3L9 2.3a3 3 0 014.2 4.2L6.8 13a1.5 1.5 0 01-2.1-2.1L11 4.5"
              stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
        </motion.button>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          className="chat-input-textarea selectable"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isIncognito ? 'Режим инкогнито — чат не сохраняется...' : 'Сообщение Syntee...'}
          rows={1}
          disabled={disabled}
        />

        {/* Кнопка голос */}
        <motion.button
          className="chat-input-btn"
          whileTap={{ scale: 0.88 }}
          whileHover={{ scale: 1.05 }}
          title="Голосовой ввод"
        >
          <svg width="16" height="18" viewBox="0 0 16 18" fill="none">
            <rect x="5" y="1" width="6" height="10" rx="3" stroke="currentColor" strokeWidth="1.4"/>
            <path d="M2 8.5a6 6 0 0012 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            <line x1="8" y1="14.5" x2="8" y2="17" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
        </motion.button>

        {/* Кнопка отправить */}
        <AnimatePresence>
          {value.trim() && (
            <motion.button
              className="chat-input-send"
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 400, damping: 25 }}
              whileTap={{ scale: 0.88 }}
              onClick={handleSend}
              disabled={disabled}
              title="Отправить (Enter)"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 14V2M2 8l6-6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      <p className="chat-input-hint">Enter — отправить · Shift+Enter — новая строка</p>
    </div>
  )
}
