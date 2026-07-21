import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import './LiveTodoBar.css'

export interface LiveTodoItem {
  text: string
  status: 'pending' | 'in_progress' | 'done' | 'skipped'
}

interface LiveTodoBarProps {
  items: LiveTodoItem[]
  /** Показывать ли бар (обычно пока стримится ответ). */
  active?: boolean
}

// Easing'и для "пузыря":
//  - overshoot: лёгкий пружинистый отскок для scale/y при появлении
//  - smooth: плавный для всего остального (borderRadius, opacity, height)
const EASE_OVERSHOOT = [0.34, 1.56, 0.64, 1] as const
const EASE_SMOOTH = [0.4, 0, 0.2, 1] as const
// Единая длительность для всех анимаций раскрытия — borderRadius и
// items height идут синхронно, иначе контейнер "плано трансформируется"
// (сначала меняет форму, потом контент появляется).
const EXPAND_MS = 0.32

export default function LiveTodoBar({ items, active = true }: LiveTodoBarProps) {
  const [expanded, setExpanded] = useState(false)

  const done = items.filter(i => i.status === 'done').length
  const total = items.length
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const hasInProgress = items.some(i => i.status === 'in_progress')

  // Авто-сворачивание когда план завершён (все пункты done/skipped).
  useEffect(() => {
    if (!active || total === 0) return
    const allDone = items.every(i => i.status === 'done' || i.status === 'skipped')
    if (allDone && expanded) {
      const t = setTimeout(() => setExpanded(false), 1200)
      return () => clearTimeout(t)
    }
    return undefined
  }, [items, active, total, expanded])

  return (
    <div className="live-todo-bar-wrap">
      <AnimatePresence>
        {active && total > 0 && (
          <motion.div
            key="live-todo-bar"
            className={`live-todo-bar${expanded ? ' live-todo-bar--expanded' : ''}`}
            // Появление/исчезновение пузыря — с лёгким отскоком scale.
            // borderRadius анимируется тут же при expand/collapse —
            // плавно 999px → 14px синхронно с items height.
            initial={{ opacity: 0, y: -12, scale: 0.82 }}
            animate={{
              opacity: 1,
              y: 0,
              scale: 1,
              borderRadius: expanded ? 14 : 999,
            }}
            exit={{ opacity: 0, y: -12, scale: 0.82 }}
            transition={{
              // default — для opacity/y (появление пузыря), с отскоком
              duration: 0.34,
              ease: EASE_OVERSHOOT,
              // borderRadius — синхронно с items height, smooth
              borderRadius: { duration: EXPAND_MS, ease: EASE_SMOOTH },
              // scale при exit — быстрее, без отскока
              scale: { duration: 0.26, ease: EASE_SMOOTH },
            }}
          >
          <div
            className="live-todo-bar__header"
            onClick={() => setExpanded(v => !v)}
          >
            <span className="live-todo-bar__icon-wrap">
              {hasInProgress ? (
                <span className="live-todo-bar__icon-spinner" />
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 11l3 3L22 4"/>
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
                </svg>
              )}
            </span>
            <span className="live-todo-bar__title">План</span>
            <span className="live-todo-bar__progress">{done}/{total}</span>
            <div className="live-todo-bar__bar">
              <motion.div
                className="live-todo-bar__bar-fill"
                animate={{ width: `${pct}%` }}
                transition={{ duration: 0.35, ease: EASE_SMOOTH }}
              />
            </div>
            <motion.svg
              className="live-todo-bar__chevron"
              width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              animate={{ rotate: expanded ? 180 : 0 }}
              transition={{ duration: EXPAND_MS, ease: EASE_SMOOTH }}
            >
              <polyline points="6 9 12 15 18 9"/>
            </motion.svg>
          </div>

          <AnimatePresence initial={false}>
            {expanded && (
              <motion.div
                className="live-todo-bar__items"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                // Тот же timing что у borderRadius — синхронно.
                transition={{ duration: EXPAND_MS, ease: EASE_SMOOTH }}
              >
                {items.map((item, i) => (
                  <motion.div
                    key={i}
                    className={`live-todo-bar__item live-todo-bar__item--${item.status}`}
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.22, ease: EASE_SMOOTH, delay: i * 0.04 }}
                  >
                    <span className="live-todo-bar__item-icon">
                      {item.status === 'done' && (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      )}
                      {item.status === 'in_progress' && <span className="live-todo-bar__spinner" />}
                      {item.status === 'pending' && <span className="live-todo-bar__circle" />}
                      {item.status === 'skipped' && (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="5" y1="12" x2="19" y2="12"/>
                        </svg>
                      )}
                    </span>
                    <span className="live-todo-bar__item-text">{item.text}</span>
                  </motion.div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
