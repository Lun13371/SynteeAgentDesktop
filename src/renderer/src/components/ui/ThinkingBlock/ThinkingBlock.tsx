import { useState, useEffect, useRef } from 'react'
import './ThinkingBlock.css'

interface ThinkingBlockProps {
  text?: string           // сохранённый thinking
  liveText?: string       // live стриминг thinking
  thinkingMs?: number     // сколько думал
  isLive?: boolean        // идёт стриминг прямо сейчас
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}мс`
  return `${(ms / 1000).toFixed(1)}с`
}

export default function ThinkingBlock({ text, liveText, thinkingMs, isLive }: ThinkingBlockProps) {
  const [open, setOpen] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef<number>(Date.now())
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Живой таймер пока стримит
  useEffect(() => {
    if (isLive) {
      startRef.current = Date.now()
      timerRef.current = setInterval(() => {
        setElapsed(Date.now() - startRef.current)
      }, 100)
    } else {
      if (timerRef.current) clearInterval(timerRef.current)
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [isLive])

  const displayText = liveText || text || ''
  const displayMs = thinkingMs ?? (isLive ? elapsed : undefined)

  return (
    <div className={`thinking-block ${open ? 'thinking-block--open' : ''} ${isLive ? 'thinking-block--live' : ''}`}>
      <button className="thinking-header" onClick={() => setOpen(v => !v)}>
        <span className="thinking-icon">
          {isLive ? (
            <span className="thinking-pulse">
              <span /><span /><span />
            </span>
          ) : '🧠'}
        </span>
        <span className="thinking-label">
          {isLive ? 'Размышляет...' : 'Размышление'}
        </span>
        {displayMs !== undefined && (
          <span className="thinking-time">{formatMs(displayMs)}</span>
        )}
        <span className="thinking-chevron">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="thinking-body" ref={bodyRef}>
          <pre className="thinking-text">{displayText}</pre>
        </div>
      )}
    </div>
  )
}
