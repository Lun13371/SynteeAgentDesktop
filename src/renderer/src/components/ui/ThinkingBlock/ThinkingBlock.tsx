import { useState, useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import './ThinkingBlock.css'

interface ThinkingBlockProps {
  text?: string
  liveText?: string
  thinkingMs?: number
  isLive?: boolean
}

const THINKING_WORDS = [
  'Думаю', 'Анализирую', 'Размышляю', 'Планирую',
  'Обдумываю', 'Исследую', 'Взвешиваю', 'Формулирую',
]

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}мс`
  return `${(ms / 1000).toFixed(1)}с`
}

export default function ThinkingBlock({ text, liveText, thinkingMs, isLive }: ThinkingBlockProps) {
  // Live-блок (стримится сейчас) — открыт сразу при монтировании.
  // Persisted-блок (из БД) — свёрнут по умолчанию, раскрывается по клику.
  const [open, setOpen] = useState(!!isLive)
  const [elapsed, setElapsed] = useState(0)
  const [wordIdx, setWordIdx] = useState(0)
  const [wordVisible, setWordVisible] = useState(true)
  const startRef = useRef<number>(Date.now())
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const wordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const prevLiveRef = useRef<boolean>(!!isLive)
  // Запоминаем, что пользователь сам закрыл/открыл — не перебиваем его выбор
  const userToggledRef = useRef(false)

  useEffect(() => {
    if (isLive) {
      startRef.current = Date.now()
      setElapsed(0)
      timerRef.current = setInterval(() => setElapsed(Date.now() - startRef.current), 100)
      wordTimerRef.current = setInterval(() => {
        setWordVisible(false)
        setTimeout(() => {
          setWordIdx(i => (i + 1) % THINKING_WORDS.length)
          setWordVisible(true)
        }, 250)
      }, 2000)
    } else {
      if (timerRef.current) clearInterval(timerRef.current)
      if (wordTimerRef.current) clearInterval(wordTimerRef.current)
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      if (wordTimerRef.current) clearInterval(wordTimerRef.current)
    }
  }, [isLive])

  // Авто-раскрытие при появлении live текста — чтобы стримящийся текст был виден сразу
  useEffect(() => {
    if (isLive && liveText && !userToggledRef.current) {
      setOpen(true)
    }
  }, [isLive, liveText])

  // Авто-сворачивание при завершении стриминга (переход true → false)
  useEffect(() => {
    if (prevLiveRef.current && !isLive) {
      setOpen(false)
      userToggledRef.current = false
    }
    prevLiveRef.current = !!isLive
  }, [isLive])

  // Автоскролл текста при стриминге
  useEffect(() => {
    if (open && isLive && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [liveText, open, isLive])

  const displayText = typeof liveText === 'string' ? liveText : typeof text === 'string' ? text : ''
  const displayMs = thinkingMs ?? (isLive ? elapsed : undefined)
  if (!displayText && !isLive) return null

  const label = isLive ? THINKING_WORDS[wordIdx] : 'Размышление'
  const timeStr = displayMs !== undefined ? ` · ${formatMs(displayMs)}` : ''

  const handleToggle = () => {
    userToggledRef.current = true
    setOpen(v => !v)
  }

  return (
    <div className={`tb ${isLive ? 'tb--live' : 'tb--done'} ${open ? 'tb--open' : ''}`}>

      {/* Заголовок — кликабельный */}
      <button className="tb-header" onClick={handleToggle}>

        {/* Иконка — три точки live / искра done */}
        <span className="tb-icon">
          {isLive ? (
            <span className="tb-dots"><span /><span /><span /></span>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
              <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z"
                stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round"/>
              <path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z"
                stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round"/>
            </svg>
          )}
        </span>

        {/* Текст — переливание слева направо в live режиме */}
        <span className={`tb-label ${isLive ? 'tb-label--live' : ''}`}>
          <span className={`tb-word ${wordVisible ? 'tb-word--in' : 'tb-word--out'}`}>
            {label}
          </span>
          <span className="tb-time">{timeStr}</span>
        </span>

        {/* Стрелка раскрытия */}
        <span className={`tb-chevron ${open ? 'tb-chevron--open' : ''}`}>
          <svg width="10" height="10" viewBox="0 0 10 6" fill="none">
            <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>
      </button>

      {/* Раскрытый текст — плавная height-анимация через framer-motion */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="tb-body"
            className={`tb-body ${isLive ? 'tb-body--live' : ''}`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.4, 0, 0.2, 1] }}
          >
            <div className="tb-body-inner" ref={bodyRef}>
              <div className={`tb-text ${isLive ? 'tb-text--shimmer' : ''}`}>
                {displayText.split('\n').map((line, i) => (
                  <p key={i} className={line.trim() === '' ? 'tb-line--empty' : 'tb-line'}>
                    {line || '\u00A0'}
                  </p>
                ))}
              </div>
              {isLive && <span className="tb-cursor" />}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
