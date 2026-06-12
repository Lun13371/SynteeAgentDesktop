import { useState, useRef, useEffect, KeyboardEvent } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import IconButton from '../IconButton/IconButton'
import ApprovalModeSelector from '../ApprovalModeSelector/ApprovalModeSelector'
import type { ApprovalMode } from '../../../../../shared/types'
import './ChatInput.css'

interface ChatInputProps {
  onSend: (text: string) => void
  onAttach?: () => void
  disabled?: boolean
  isIncognito?: boolean
  replyTo?: { role: string; content: string } | null
  onCancelReply?: () => void
}

export default function ChatInput({ onSend, onAttach, disabled, isIncognito, replyTo, onCancelReply }: ChatInputProps) {
  const [value, setValue] = useState('')
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('ask')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Загружаем сохранённый режим
  useEffect(() => {
    window.syntee.agent.getSettings().then((s: { approvalMode: ApprovalMode }) => {
      setApprovalMode(s.approvalMode)
    }).catch(() => {})
  }, [])

  const handleApprovalChange = (mode: ApprovalMode) => {
    setApprovalMode(mode)
    window.syntee.agent.setSettings({ approvalMode: mode }).catch(() => {})
  }

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
      {replyTo && (
        <div className="chat-input-reply">
          <div className="chat-input-reply-content">
            <span className="chat-input-reply-role">{replyTo.role === 'user' ? 'Вы' : 'Syntee'}</span>
            <span className="chat-input-reply-text">{replyTo.content.slice(0, 100)}{replyTo.content.length > 100 ? '…' : ''}</span>
          </div>
          <button className="chat-input-reply-cancel" onClick={onCancelReply}>✕</button>
        </div>
      )}
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

        {/* Селектор режима подтверждения */}
        {!isIncognito && (
          <ApprovalModeSelector
            value={approvalMode}
            onChange={handleApprovalChange}
            compact
          />
        )}

        {/* Кнопка mic → send — анимированная */}
        <motion.button
          className={`chat-input-action-btn ${value.trim() ? 'chat-input-action-btn--send' : 'chat-input-action-btn--mic'}`}
          onClick={value.trim() ? handleSend : undefined}
          disabled={disabled}
          whileTap={{ scale: 0.88 }}
          whileHover={{ scale: 1.08 }}
          transition={{ type: 'spring', stiffness: 400, damping: 25 }}
          title={value.trim() ? 'Отправить (Enter)' : 'Голосовой ввод'}
          aria-label={value.trim() ? 'Отправить' : 'Голосовой ввод'}
        >
          <AnimatePresence mode="wait" initial={false}>
            {value.trim() ? (
              <motion.span
                key="send"
                initial={{ rotate: -90, opacity: 0, scale: 0.5 }}
                animate={{ rotate: 0, opacity: 1, scale: 1 }}
                exit={{ rotate: 90, opacity: 0, scale: 0.5 }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              >
                <AppIcon name="send" size="md" />
              </motion.span>
            ) : (
              <motion.span
                key="mic"
                initial={{ rotate: 90, opacity: 0, scale: 0.5 }}
                animate={{ rotate: 0, opacity: 1, scale: 1 }}
                exit={{ rotate: -90, opacity: 0, scale: 0.5 }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              >
                <AppIcon name="mic" size="md" />
              </motion.span>
            )}
          </AnimatePresence>
        </motion.button>
      </div>

      <p className="chat-input-hint">Enter — отправить · Shift+Enter — новая строка</p>
    </div>
  )
}
