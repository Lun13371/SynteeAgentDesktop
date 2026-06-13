import { useState, useEffect, useRef } from 'react'
import './ThinkingBlock.css'

interface ThinkingBlockProps {
  text?: string
  liveText?: string
  thinkingMs?: number
  isLive?: boolean
}

const THINKING_WORDS = [
  'Анализирую', 'Размышляю', 'Обдумываю', 'Ищу решение',
  'Рассуждаю', 'Взвешиваю', 'Изучаю', 'Формулирую',
]

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}мс`
  return `${(ms / 1000).toFixed(1)}с`
}

export default function ThinkingBlock({ text, liveText, thinkingMs, isLive }: ThinkingBlockProps) {
  const [open, setOpen] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [wordIdx, setWordIdx] = useState(0)
  const [wordVisible, setWordVisible] = useState(true)
  const startRef = useRef<number>(Date.now())
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const wordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isLive) {
      startRef.current = Date.now()
      timerRef.current = setInterval(() => setElapsed(Date.now() - startRef.current), 100)
      wordTimerRef.current = setInterval(() => {
        setWordVisible(false)
        setTimeout(() => {
          setWordIdx(i => (i + 1) % THINKING_WORDS.length)
          setWordVisible(true)
        }, 300)
      }, 1800)
    } else {
      if (timerRef.current) clearInterval(timerRef.current)
      if (wordTimerRef.current) clearInterval(wordTimerRef.current)
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      if (wordTimerRef.current) clearInterval(wordTimerRef.current)
    }
  }, [isLive])

  useEffect(() => {
    if (open && isLive && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [liveText, open, isLive])

  const displayText = typeof liveText === 'string' ? liveText : typeof text === 'string' ? text : ''
  const displayMs = thinkingMs ?? (isLive ? elapsed : undefined)
  if (!displayText && !isLive) return null

  const charCount = displayText.length
  const lineCount = displayText.split('\n').length

  return (
    <div className={`tb ${open ? 'tb--open' : ''} ${isLive ? 'tb--live' : 'tb--done'}`}>

      {/* Прогресс-линия сверху */}
      {isLive && <div className="tb-progress"><div className="tb-progress-bar" /></div>}

      {/* Шапка */}
      <button className="tb-header" onClick={() => setOpen(v => !v)}>

        {/* Иконка */}
        <span className="tb-icon">
          {isLive ? (
            <span className="tb-dots">
              <span /><span /><span />
            </span>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z"
                stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round"/>
              <path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z"
                stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round"/>
            </svg>
          )}
        </span>

        {/* Лейбл */}
        <span className="tb-label">
          {isLive ? (
            <span className={`tb-word ${wordVisible ? 'tb-word--in' : 'tb-word--out'}`}>
              {THINKING_WORDS[wordIdx]}
            </span>
          ) : (
            <span className="tb-word tb-word--in">Размышление</span>
          )}
        </span>

        {/* Мета-инфо */}
        <span className="tb-meta">
          {displayMs !== undefined && (
            <span className="tb-time">{formatMs(displayMs)}</span>
          )}
          {!isLive && charCount > 0 && (
            <span className="tb-stats">{lineCount} строк</span>
          )}
        </span>

        {/* Шеврон */}
        <span className={`tb-chevron ${open ? 'tb-chevron--open' : ''}`}>
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.6"
              strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>
      </button>

      {/* Тело */}
      {open && (
        <div className="tb-body" ref={bodyRef}>
          <div className="tb-text">
            {displayText.split('\n').map((line, i) => (
              <p key={i} className={line.trim() === '' ? 'tb-line--empty' : 'tb-line'}>
                {line || '\u00A0'}
              </p>
            ))}
            {isLive && <span className="tb-cursor" />}
          </div>
        </div>
      )}
    </div>
  )
}
