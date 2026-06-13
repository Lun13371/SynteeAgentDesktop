import { useState, useEffect, useRef } from 'react'
import './ThinkingBlock.css'

interface ThinkingBlockProps {
  text?: string
  liveText?: string
  thinkingMs?: number
  isLive?: boolean
}

const THINKING_WORDS = [
  'Анализирую...', 'Размышляю...', 'Обдумываю...', 'Ищу решение...',
  'Рассуждаю...', 'Взвешиваю...', 'Изучаю...', 'Формулирую...',
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

  return (
    <div className={`thinking-block ${open ? 'thinking-block--open' : ''} ${isLive ? 'thinking-block--live' : ''}`}>
      <button className="thinking-header" onClick={() => setOpen(v => !v)}>

        <span className="thinking-icon-wrap">
          {isLive ? (
            <span className="thinking-dots"><span /><span /><span /></span>
          ) : (
            /* Sparkles icon */
            <svg className="thinking-brain-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
              <path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round"/>
              <path d="M5 17l.5 1.5L7 19l-1.5.5L5 21l-.5-1.5L3 19l1.5-.5L5 17z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" strokeLinecap="round"/>
            </svg>
          )}
        </span>

        <span className="thinking-label">
          {isLive ? (
            <span className={`thinking-word ${wordVisible ? 'thinking-word--in' : 'thinking-word--out'}`}>
              {THINKING_WORDS[wordIdx]}
            </span>
          ) : (
            <span className="thinking-word thinking-word--in">
              Размышление {displayMs !== undefined ? `· ${formatMs(displayMs)}` : ''}
            </span>
          )}
        </span>

        {isLive && displayMs !== undefined && (
          <span className="thinking-time">{formatMs(displayMs)}</span>
        )}

        <span className={`thinking-chevron ${open ? 'thinking-chevron--open' : ''}`}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>
      </button>

      {open && (
        <div className="thinking-body" ref={bodyRef}>
          <div className="thinking-text">
            {displayText.split('\n').map((line, i) => (
              <p key={i} className={line.trim() === '' ? 'thinking-line--empty' : 'thinking-line'}>
                {line || '\u00A0'}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
