import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { ApprovalMode } from '../../../../../shared/types'
import AppIcon from '../AppIcon/AppIcon'
import './ApprovalModeSelector.css'

const MODES: { value: ApprovalMode; label: string; icon: string; desc: string }[] = [
  { value: 'ask',  label: 'Спрашивать',    icon: 'alertCircle', desc: 'Подтверждать каждое действие' },
  { value: 'auto', label: 'Авто',          icon: 'zap',         desc: 'Авто для безопасных, спрашивать для опасных' },
  { value: 'full', label: 'Полный доступ', icon: 'shield',      desc: 'Выполнять всё без подтверждений' },
]

interface ApprovalModeSelectorProps {
  value: ApprovalMode
  onChange: (mode: ApprovalMode) => void
  compact?: boolean
}

export default function ApprovalModeSelector({ value, onChange, compact }: ApprovalModeSelectorProps) {
  const [open, setOpen] = useState(false)
  const current = MODES.find(m => m.value === value) || MODES[0]

  useEffect(() => {
    if (!open) return
    const handler = () => setOpen(false)
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className={`approval-selector ${compact ? 'approval-selector--compact' : ''}`}>
      <motion.button
        className={`approval-btn approval-btn--${value}`}
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o) }}
        whileTap={{ scale: 0.95 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        title={current.desc}
      >
        <AppIcon name={current.icon as 'zap'} size="xs" />
        {!compact && <span className="approval-btn-label">{current.label}</span>}
        <AppIcon name={open ? 'chevronUp' : 'chevronDown'} size="xs" />
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="approval-dropdown glass"
            initial={{ opacity: 0, y: 6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 420, damping: 30 }}
            onClick={e => e.stopPropagation()}
          >
            {MODES.map(mode => (
              <motion.button
                key={mode.value}
                className={`approval-option ${value === mode.value ? 'approval-option--active' : ''}`}
                onClick={() => { onChange(mode.value); setOpen(false) }}
                whileHover={{ x: 3 }}
                transition={{ type: 'spring', stiffness: 400, damping: 25 }}
              >
                <div className={`approval-option-icon approval-option-icon--${mode.value}`}>
                  <AppIcon name={mode.icon as 'zap'} size="xs" />
                </div>
                <div className="approval-option-text">
                  <span className="approval-option-label">{mode.label}</span>
                  <span className="approval-option-desc">{mode.desc}</span>
                </div>
                {value === mode.value && <AppIcon name="check" size="xs" tone="accent" />}
              </motion.button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
