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

  // Живой таймер пока стримит
  useEffect(() => {
    if (isLive) {
      startRef.current = Date.now()
      timerRef.current = setInterval(() => setElapsed(Date.now() - startRef.current), 100)
      // Меняем слово каждые 1.8с с fade
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

  // Автоскролл внутри body при живом стриминге
  useEffect(() => {
    if (open && isLive && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [liveText, open, isLive])

  const displayText = liveText || text || ''
  const displayMs = thinkingMs ?? (isLive ? elapsed : undefined)
  if (!displayText && !isLive) return null

  return (
    <div className={`thinking-block ${open ? 'thinking-block--open' : ''} ${isLive ? 'thinking-block--live' : ''}`}>
      <button className="thinking-header" onClick={() => setOpen(v => !v)}>

        {/* Иконка — пульс или мозг */}
        <span className="thinking-icon-wrap">
          {isLive ? (
            <span className="thinking-dots">
              <span /><span /><span />
            </span>
          ) : (
            <svg className="thinking-brain-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M9 3C6.8 3 5 4.8 5 7c0 .9.3 1.7.7 2.4C4.7 10 4 11.1 4 12.5c0 1.8 1.2 3.3 2.9 3.8C7 17.5 7 18.7 7 19h10c0-.3 0-1.5.1-2.7 1.7-.5 2.9-2 2.9-3.8 0-1.4-.7-2.5-1.7-3.1.4-.7.7-1.5.7-2.4 0-2.2-1.8-4-4-4-.7 0-1.4.2-2 .5-.6-.3-1.3-.5-2-.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            </svg>
          )}
        </span>

        {/* Текст — меняющиеся слова или "Размышлял" */}
        <span className="thinking-label">
          {isLive ? (
            <span className={`thinking-word ${wordVisible ? 'thinking-word--in' : 'thinking-word--out'}`}>
              {THINKING_WORDS[wordIdx]}
            </span>
          ) : (
            <span className="thinking-word thinking-word--in">
              Размышлял {displayMs !== undefined ? formatMs(displayMs) : ''}
            </span>
          )}
        </span>

        {/* Таймер при live */}
        {isLive && displayMs !== undefined && (
          <span className="thinking-time">{formatMs(displayMs)}</span>
        )}

        {/* Шеврон */}
        <span className={`thinking-chevron ${open ? 'thinking-chevron--open' : ''}`}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>
      </button>

      {open && (
        <div className="thinking-body" ref={bodyRef}>
          <pre className="thinking-text">{displayText}</pre>
        </div>
      )}
    </div>
  )
}
