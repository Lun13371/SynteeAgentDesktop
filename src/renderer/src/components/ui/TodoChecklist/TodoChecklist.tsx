import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import './TodoChecklist.css'

export interface TodoItem {
  text: string
  status: 'pending' | 'in_progress' | 'done' | 'skipped'
}

export default function TodoChecklist({ items }: { items: TodoItem[] }) {
  if (!items || items.length === 0) return null
  const done = items.filter(i => i.status === 'done').length
  const total = items.length
  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  return (
    <div className="todo-checklist">
      <div className="todo-header">
        <AppIcon name="listChecks" size="sm" />
        <span className="todo-title">План задачи</span>
        <span className="todo-progress">{done}/{total} · {pct}%</span>
      </div>
      <div className="todo-bar">
        <motion.div
          className="todo-bar-fill"
          animate={{ width: `${pct}%` }}
          transition={{ type: 'spring', stiffness: 200, damping: 24 }}
        />
      </div>
      <div className="todo-items">
        <AnimatePresence mode="popLayout">
          {items.map((item, i) => (
            <motion.div
              key={i}
              className={`todo-item todo-item--${item.status}`}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={{ duration: 0.2 }}
            >
              <span className="todo-item-icon">
                {item.status === 'done' && <AppIcon name="check" size="sm" />}
                {item.status === 'in_progress' && <span className="todo-spinner" />}
                {item.status === 'pending' && <span className="todo-circle" />}
                {item.status === 'skipped' && <AppIcon name="minus" size="sm" />}
              </span>
              <span className="todo-item-text">{item.text}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}
