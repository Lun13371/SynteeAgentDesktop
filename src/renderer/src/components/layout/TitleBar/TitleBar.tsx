import { motion } from 'framer-motion'
import './TitleBar.css'

export default function TitleBar() {
  const handleMinimize = () => window.syntee.window.minimize()
  const handleHide = () => window.syntee.window.hide()

  return (
    <div className="titlebar drag-region">
      <div className="titlebar-left no-drag">
        <div className="titlebar-logo">
          {/* Кристалл SVG — заглушка */}
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
