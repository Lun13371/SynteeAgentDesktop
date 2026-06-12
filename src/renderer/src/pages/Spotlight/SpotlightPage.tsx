import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import './SpotlightPage.css'

interface SuggestionItem {
  id: string
  icon: string
  label: string
  sub?: string
  action: () => void
}

export default function SpotlightPage() {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [results, setResults] = useState<SuggestionItem[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
      if (e.key === 'ArrowDown') setSelected(s => Math.min(s + 1, results.length - 1))
      if (e.key === 'ArrowUp') setSelected(s => Math.max(s - 1, 0))
      if (e.key === 'Enter' && results[selected]) results[selected].action()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [results, selected])

  useEffect(() => {
    setSelected(0)
    if (!query.trim()) {
      setResults(getDefaultSuggestions())
      return
    }
    setResults(getSearchResults(query))
  }, [query])

  const handleClose = () => {
    setQuery('')
    window.syntee.spotlight.hide()
  }

  const handleSend = () => {
    if (!query.trim()) return
    // Отправляем в главное окно как чат запрос
    window.syntee.spotlight.expand()
    handleClose()
  }

  return (
    <div className="spotlight-root" onClick={e => { if (e.target === e.currentTarget) handleClose() }}>
      <motion.div
        className="spotlight-box glass"
        initial={{ y: -20, opacity: 0, scale: 0.96 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: -20, opacity: 0, scale: 0.96 }}
        transition={{ type: 'spring', stiffness: 420, damping: 32 }}
      >
        {/* Поле ввода */}
        <div className="spotlight-input-row">
          <svg className="spotlight-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
            <polygon points="8,1 15,4.5 15,11.5 8,15 1,11.5 1,4.5"
              fill="none" stroke="var(--accent)" strokeWidth="1.3"/>
          </svg>
          <input
            ref={inputRef}
            className="spotlight-input"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !results.length) handleSend() }}
            placeholder="Спросить Syntee..."
          />
          {query && (
            <motion.button
              className="spotlight-clear"
              onClick={() => setQuery('')}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              whileTap={{ scale: 0.88 }}
            >
              ✕
            </motion.button>
          )}
        </div>

        {/* Результаты */}
        <AnimatePresence>
          {results.length > 0 && (
            <motion.div
              className="spotlight-results"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
            >
              {results.map((item, i) => (
                <motion.button
                  key={item.id}
                  className={`spotlight-result-item ${i === selected ? 'spotlight-result-item--active' : ''}`}
                  onClick={item.action}
                  onMouseEnter={() => setSelected(i)}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.03 }}
                >
                  <span className="spotlight-result-icon">{item.icon}</span>
                  <div className="spotlight-result-text">
                    <span className="spotlight-result-label">{item.label}</span>
                    {item.sub && <span className="spotlight-result-sub">{item.sub}</span>}
                  </div>
                  <span className="spotlight-result-enter">↵</span>
                </motion.button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Подсказки */}
        <div className="spotlight-footer">
          <span>↑↓ навигация</span>
          <span>↵ выбрать</span>
          <span>ESC закрыть</span>
        </div>
      </motion.div>
    </div>
  )
}

function getDefaultSuggestions(): SuggestionItem[] {
  return [
    { id: 'chat', icon: '💬', label: 'Новый чат', sub: 'Открыть главное окно', action: () => window.syntee.window.show() },
    { id: 'voice', icon: '🎤', label: 'Голосовой режим', sub: 'Ctrl+Shift+V', action: () => window.syntee.voice?.start() },
    { id: 'overlay', icon: '🔍', label: 'Circle to Search', sub: 'Ctrl+Shift+S', action: () => window.syntee.overlay.show() },
    { id: 'settings', icon: '⚙️', label: 'Настройки', sub: 'Открыть настройки', action: () => { window.syntee.window.show() } },
  ]
}

function getSearchResults(query: string): SuggestionItem[] {
  const q = query.toLowerCase()
  const all: SuggestionItem[] = [
    { id: 'ask', icon: '✨', label: `Спросить: "${query}"`, sub: 'Отправить в чат', action: () => { window.syntee.window.show() } },
    { id: 'calc', icon: '🧮', label: 'Калькулятор', sub: query, action: () => {} },
    { id: 'translate', icon: '🌐', label: `Перевести: "${query}"`, sub: 'Перевод текста', action: () => {} },
  ]
  if (q.includes('настр') || q.includes('sett')) {
    all.push({ id: 'settings', icon: '⚙️', label: 'Настройки', sub: 'Открыть настройки', action: () => {} })
  }
  if (q.includes('чат') || q.includes('chat')) {
    all.push({ id: 'chat', icon: '💬', label: 'Новый чат', sub: '', action: () => window.syntee.window.show() })
  }
  return all.slice(0, 6)
}
