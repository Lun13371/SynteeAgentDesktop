import { motion } from 'framer-motion'
import './TitleBar.css'

interface TitleBarProps {
  onSettingsClick?: () => void
  onAgentClick?: () => void
  onMemoryClick?: () => void
}

export default function TitleBar({ onSettingsClick, onAgentClick, onMemoryClick }: TitleBarProps) {
  const handleMinimize = () => window.syntee.window.minimize()
  const handleHide = () => window.syntee.window.hide()

  return (
    <div className="titlebar drag-region">
      <div className="titlebar-left no-drag">
        <div className="titlebar-logo">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
            <polygon points="11,1 21,7 21,15 11,21 1,15 1,7"
              fill="none" stroke="var(--accent)" strokeWidth="1.5" opacity="0.9"/>
            <polygon points="11,4 18,8 18,14 11,18 4,14 4,8"
              fill="var(--accent)" opacity="0.12"/>
            <line x1="11" y1="1" x2="11" y2="21" stroke="var(--accent)" strokeWidth="0.8" opacity="0.4"/>
            <line x1="1" y1="7" x2="21" y2="15" stroke="var(--accent)" strokeWidth="0.8" opacity="0.4"/>
            <line x1="21" y1="7" x2="1" y2="15" stroke="var(--accent)" strokeWidth="0.8" opacity="0.4"/>
          </svg>
        </div>
        <span className="titlebar-title">Syntee</span>
      </div>

      <div className="titlebar-right no-drag">
        {onMemoryClick && (
          <motion.button
            className="titlebar-btn"
            whileTap={{ scale: 0.88 }}
            onClick={onMemoryClick}
            title="Память"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.3"/>
              <path d="M5 5.5c0-1.1.9-2 2-2s2 .9 2 2c0 .8-.5 1.5-1.2 1.8L7 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              <circle cx="7" cy="11" r="0.7" fill="currentColor"/>
            </svg>
          </motion.button>
        )}
        {onAgentClick && (
          <motion.button
            className="titlebar-btn"
            whileTap={{ scale: 0.88 }}
            onClick={onAgentClick}
            title="Агент"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="2" y="4" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
              <circle cx="5" cy="7.5" r="1" fill="currentColor"/>
              <circle cx="9" cy="7.5" r="1" fill="currentColor"/>
              <path d="M5 4V2.5a2 2 0 014 0V4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </motion.button>
        )}
        {onSettingsClick && (
          <motion.button
            className="titlebar-btn"
            whileTap={{ scale: 0.88 }}
            onClick={onSettingsClick}
            title="Настройки"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="2" stroke="currentColor" strokeWidth="1.3"/>
              <path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M2.57 2.57l1.06 1.06M10.37 10.37l1.06 1.06M2.57 11.43l1.06-1.06M10.37 3.63l1.06-1.06"
                stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </motion.button>
        )}
        <motion.button
          className="titlebar-btn"
          whileTap={{ scale: 0.88 }}
          onClick={handleMinimize}
          title="Свернуть"
        >
          <svg width="12" height="2" viewBox="0 0 12 2"><rect width="12" height="2" rx="1" fill="currentColor"/></svg>
        </motion.button>
        <motion.button
          className="titlebar-btn titlebar-btn--close"
          whileTap={{ scale: 0.88 }}
          onClick={handleHide}
          title="В трей"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </motion.button>
      </div>
    </div>
  )
}
