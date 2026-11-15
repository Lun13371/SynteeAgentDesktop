import { motion, AnimatePresence } from 'framer-motion'
import './ActivityStrip.css'

/** Одна активность в тонкой полоске под инпутом (помощники, индексация, …). */
export interface ActivityItem {
  id: string
  state: 'busy' | 'ready' | 'error'
  label: string
  /** Доп. сведения: проект, счётчики, остаток очереди, текст ошибки. */
  detail?: string
  percent?: number
  /** Показывать мини-полосу прогресса (только busy). */
  progress?: boolean
}

/**
 * Единая минималистичная полоска активности. Переиспользуется любыми
 * фоновыми процессами: рендерит переданные items в одну тонкую строку.
 * Высота фиксирована слотом снаружи — появление/исчезновение не двигает чат.
 * Всё содержимое сжимается через ellipsis, поэтому всегда влазит.
 */
export default function ActivityStrip({ items }: { items: ActivityItem[] }) {
  return (
    <AnimatePresence>
      {items.length > 0 && (
        <motion.div
          className="activity-strip"
          role="status"
          aria-live="polite"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          {items.map(it => (
            <div
              key={it.id}
              className={`activity-strip-item activity-strip-item--${it.state}`}
              title={it.detail ? `${it.label} · ${it.detail}` : it.label}
            >
              {it.state === 'busy' && <span className="activity-strip-spinner" />}
              {it.state === 'ready' && <span className="activity-strip-check">✓</span>}
              {it.state === 'error' && <span className="activity-strip-err">!</span>}
              <span className="activity-strip-label">{it.label}</span>
              {it.detail && <span className="activity-strip-detail">{it.detail}</span>}
              {it.state === 'busy' && it.progress && (
                <>
                  <span className="activity-strip-track">
                    <span className="activity-strip-fill" style={{ width: `${it.percent ?? 0}%` }} />
                  </span>
                  <span className="activity-strip-pct">{it.percent ?? 0}%</span>
                </>
              )}
            </div>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  )
}