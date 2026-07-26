import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './PlanCard.css'

interface PlanCardProps {
  title: string
  summary: string
  content: string
  filePath?: string
  /** true — план ещё стримится (нет </plan>). Скрывает кнопки действий, показывает shimmer. */
  partial?: boolean
}

const IconPlan = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <line x1="16" y1="13" x2="8" y2="13"/>
    <line x1="16" y1="17" x2="8" y2="17"/>
    <polyline points="10 9 9 9 8 9"/>
  </svg>
)

const IconCopy = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg>
)

const IconFolder = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
  </svg>
)

const IconChevronDown = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9"/>
  </svg>
)

const IconChevronUp = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="18 15 12 9 6 15"/>
  </svg>
)

export default function PlanCard({ title, summary, content, filePath, partial }: PlanCardProps) {
  // Во время стрима план развёрнут (видно как пишется). После — тоже развёрнут.
  // Сворачивает только пользователь. partial не в зависимостях — начальное
  // состояние берётся из пропса при первом монтировании.
  const [expanded, setExpanded] = useState(true)
  const [copied, setCopied] = useState(false)

  const handleOpen = () => {
    if (filePath) window.syntee.shell?.openPath(filePath)
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(`# ${title}\n\n> ${summary}\n\n${content}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <motion.div
      className={`plan-card${partial ? ' plan-card--streaming' : ''}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
    >
      <div className="plan-card-header">
        <div className="plan-card-icon">
          <IconPlan />
        </div>
        <div className="plan-card-meta">
          <div className="plan-card-title">{title || 'План'}</div>
          <div className="plan-card-summary">{summary || (partial ? 'Составляю план…' : '')}</div>
        </div>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            className="plan-card-body"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
          >
            <div className="plan-card-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
              {partial && (
                <div className="plan-card-streaming-indicator">
                  <motion.span
                    animate={{ opacity: [0.3, 1, 0.3] }}
                    transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
                  >
                    пишу план…
                  </motion.span>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="plan-card-footer">
        <button className="plan-card-btn plan-card-btn--expand" onClick={() => setExpanded(v => !v)}>
          {expanded ? <IconChevronUp /> : <IconChevronDown />}
          {expanded ? 'Свернуть' : 'Показать план'}
        </button>
        {!partial && (
          <div className="plan-card-actions">
            <button className="plan-card-btn" onClick={handleCopy}>
              <IconCopy />
              {copied ? 'Скопировано' : 'Копировать'}
            </button>
            {filePath && (
              <button className="plan-card-btn plan-card-btn--primary" onClick={handleOpen}>
                <IconFolder />
                Открыть файл
              </button>
            )}
          </div>
        )}
      </div>
    </motion.div>
  )
}
