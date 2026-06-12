import { motion } from 'framer-motion'
import AppIcon from '../../ui/AppIcon/AppIcon'
import IconButton from '../../ui/IconButton/IconButton'
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
        {onMemoryClick && <IconButton icon="brain" label="Память" onClick={onMemoryClick} />}
        {onAgentClick && <IconButton icon="bot" label="Агент" onClick={onAgentClick} />}
        {onSettingsClick && <IconButton icon="settings" label="Настройки" onClick={onSettingsClick} />}
        <IconButton icon="minus" label="Свернуть" onClick={handleMinimize} />
        <IconButton icon="x" label="В трей" onClick={handleHide} danger className="titlebar-btn titlebar-btn--close" />
      </div>
    </div>
  )
}
