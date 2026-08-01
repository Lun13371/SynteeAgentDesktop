import { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import type { Message } from '../../../../../shared/types'
import AppIcon from '../AppIcon/AppIcon'
import { useChatRemeasure } from './remeasure'

// Module-level кэш redo-статуса. Виртуализатор монтирует/демонтирует
// разделители при скролле — без кэша каждый remount дёргал IPC canRedo.
// Инвалидируется целиком при chat:rewound (событие редкое).
const redoStatusCache = new Map<string, boolean>()

// System-разделитель — полоса поперёк чата для system-сообщений (откаты,
// сжатие контекста и т.д.). Для rewind-сообщений с активной redo-точкой
// показывает кнопку "Отменить откат". Для compact-сообщений — кнопку
// "Развернуть"/"Свернуть" для раскрытия резюме (compactSummary).
export function SystemDivider({ message, isRewind, isCompact, isCompacting, timeEl, liveSummary }: {
  message: Message
  isRewind: boolean
  isCompact: boolean
  isCompacting: boolean
  timeEl: React.ReactNode
  liveSummary?: string
}) {
  const [canRedo, setCanRedo] = useState(false)
  const [redoing, setRedoing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  // Перемер ряда виртуализатора после settle. Анимация height:0→'auto' ниже
  // может оставить в кэше промежуточную высоту → следующий ряд налезает на этот.
  // onAnimationComplete форсит resizeItem с финальной высотой. Вне провайдера
  // (превью/сайдчат без виртуализатора) — null, просто noop.
  const remeasure = useChatRemeasure()

  // Проверяем — доступна ли отмена отката (есть redo-точка в БД).
  useEffect(() => {
    if (!isRewind || !message.chatId) { setCanRedo(false); return }
    let cancelled = false
    const key = `${message.chatId}:${message.id}`
    const check = async () => {
      const cached = redoStatusCache.get(key)
      if (cached !== undefined) { if (!cancelled) setCanRedo(cached); return }
      const result = await window.syntee.chat.canRedo(message.chatId, message.id) as boolean
      redoStatusCache.set(key, result)
      if (!cancelled) setCanRedo(result)
    }
    check()
    // Проверяем снова при получении события CHAT_REWOUND (redo мог быть отменён).
    const off = window.syntee.on('chat:rewound', () => { redoStatusCache.clear(); if (!cancelled) check() })
    return () => { cancelled = true; off() }
  }, [isRewind, message.chatId, message.id])

  const handleRedo = useCallback(async () => {
    if (!message.chatId || redoing) return
    const confirmed = window.confirm('Отменить откат? Сообщения и файлы будут возвращены.')
    if (!confirmed) return
    setRedoing(true)
    try {
      const result = await window.syntee.chat.redo(message.chatId, message.id) as { messages?: Message[]; error?: string }
      if (result.error) {
        window.alert(result.error)
      }
      // CHAT_REWOUND event обновит messages в store
    } catch (e) {
      window.alert(String((e as Error)?.message ?? e))
    } finally {
      setRedoing(false)
    }
  }, [message.chatId, message.id, redoing])

  const variantClass = isRewind ? 'message-system-divider--rewind'
    : isCompact ? 'message-system-divider--compact'
    : isCompacting ? 'message-system-divider--compact message-system-divider--compacting'
    : ''
  const iconName = isRewind ? 'rewind' : (isCompact || isCompacting) ? 'layers' : 'info'
  const iconTone = isRewind ? 'warning' : (isCompact || isCompacting) ? 'accent' : 'muted'

  return (
    <motion.div
      className={`message-system-divider ${variantClass}`}
      initial={{ opacity: 0, scaleY: 0 }}
      animate={{ opacity: 1, scaleY: 1 }}
      transition={{ duration: 0.25 }}
    >
      <div className="message-system-divider__line" />
      <div className="message-system-divider__badge">
        {isCompacting
          ? <AppIcon name="refreshCw" size="xs" tone="accent" animation="spin" />
          : <AppIcon name={iconName} size="xs" tone={iconTone} />}
        <span className="message-system-divider__text">
          {isCompacting && liveSummary ? 'AI пишет резюме контекста…' : message.content}
        </span>
        {timeEl}
        {isCompact && message.compactSummary && (
          <button
            className="message-system-divider__expand"
            onClick={() => setExpanded(v => !v)}
            title={expanded ? 'Свернуть резюме' : 'Развернуть резюме сжатия'}
          >
            <AppIcon name={expanded ? 'chevronUp' : 'chevronDown'} size="xs" />
            <span>{expanded ? 'Свернуть' : 'Развернуть'}</span>
          </button>
        )}
        {isRewind && canRedo && (
          <button
            className="message-system-divider__redo"
            onClick={handleRedo}
            disabled={redoing}
            title="Отменить откат — вернуть сообщения и файлы"
          >
            <AppIcon name="refreshCw" size="xs" animation={redoing ? 'spin' : 'none'} />
            <span>Отменить откат</span>
          </button>
        )}
      </div>
      <div className="message-system-divider__line" />

      {isCompact && expanded && message.compactSummary && (
        <motion.div
          className="message-system-divider__summary"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
          onAnimationComplete={() => remeasure?.()}
        >
          <div className="message-system-divider__summary-head">
            <AppIcon name="layers" size="xs" tone="accent" />
            <span>Резюме сжатого контекста</span>
          </div>
          <div className="message-system-divider__summary-content selectable">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
            >
              {message.compactSummary}
            </ReactMarkdown>
          </div>
        </motion.div>
      )}

      {isCompacting && liveSummary && (
        <motion.div
          className="message-system-divider__summary message-system-divider__summary--live"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          onAnimationComplete={() => remeasure?.()}
        >
          <div className="message-system-divider__summary-head">
            <AppIcon name="layers" size="xs" tone="accent" animation="spin" />
            <span>AI пишет резюме контекста</span>
          </div>
          <div className="message-system-divider__summary-content message-system-divider__summary-content--streaming selectable">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {liveSummary}
            </ReactMarkdown>
          </div>
        </motion.div>
      )}
    </motion.div>
  )
}
