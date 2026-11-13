import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import './AssistantsBanner.css'

type Phase = { phase: string; percent: number; error?: string }

const LABELS: Record<string, string> = {
  binary: 'Скачиваю движок',
  model: 'Скачиваю модель',
  starting: 'Запускаю сервер',
  ready: 'Помощники готовы',
  error: 'Ошибка настройки',
}

export default function AssistantsBanner() {
  const [phase, setPhase] = useState<Phase | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const unsub = window.syntee.assistants.onSetupProgress((p) => {
      setPhase(p)
      setVisible(true)
      if (p.phase === 'ready') setTimeout(() => setVisible(false), 3000)
      if (p.phase === 'error') setTimeout(() => setVisible(false), 6000)
    })
    return unsub
  }, [])

  return (
    <AnimatePresence>
      {visible && phase && (
        <motion.div
          className={`assistants-banner-bar assistants-banner-bar--${phase.phase}`}
          initial={{ opacity: 0, y: -8, height: 0 }}
          animate={{ opacity: 1, y: 0, height: 'auto' }}
          exit={{ opacity: 0, y: -8, height: 0 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        >
          <div className="assistants-banner-bar-inner">
            {phase.phase !== 'ready' && phase.phase !== 'error' && (
              <span className="assistants-banner-spinner" />
            )}
            {phase.phase === 'ready' && <span className="assistants-banner-check">✓</span>}
            {phase.phase === 'error' && <span className="assistants-banner-err">!</span>}
            <span className="assistants-banner-label">
              {LABELS[phase.phase] ?? 'Настройка помощников'}
              {phase.error ? `: ${phase.error}` : ''}
            </span>
            {phase.phase !== 'ready' && phase.phase !== 'error' && (
              <div className="assistants-banner-track">
                <div className="assistants-banner-fill" style={{ width: `${phase.percent}%` }} />
              </div>
            )}
            {phase.phase !== 'ready' && phase.phase !== 'error' && (
              <span className="assistants-banner-pct">{phase.percent}%</span>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}