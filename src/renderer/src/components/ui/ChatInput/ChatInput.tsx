import { useState, useRef, useEffect, KeyboardEvent } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import IconButton from '../IconButton/IconButton'
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
        <IconButton
          icon="paperclip"
          label="Прикрепить файл"
          className="chat-input-btn"
          onClick={onAttach}
        />

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
        <IconButton
          icon="mic"
          label="Голосовой ввод"
          className="chat-input-btn"
        />

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
              aria-label="Отправить"
            >
              <AppIcon name="send" size="md" tone="accent" />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      <p className="chat-input-hint">Enter — отправить · Shift+Enter — новая строка</p>
    </div>
  )
}
