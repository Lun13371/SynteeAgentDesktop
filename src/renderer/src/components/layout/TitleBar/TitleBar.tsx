import IconButton from '../../ui/IconButton/IconButton'
import Identicon from '../../ui/Identicon/Identicon'
import Logo from '../../ui/Logo/Logo'
import { useTerminalStore } from '../../../store/terminal.store'
import { useAuthStore } from '../../../store/auth.store'
import { useBillingStore } from '../../../store/billing.store'
import './TitleBar.css'

interface TitleBarProps {
  onSettingsClick?: () => void
  onAgentClick?: () => void
  onMemoryClick?: () => void
  onProfileClick?: () => void
  currentChatId?: string | null
}

export default function TitleBar({ onSettingsClick, onAgentClick, onMemoryClick, onProfileClick }: TitleBarProps) {
  const handleMinimize = () => window.syntee.window.minimize()
  const handleHide = () => window.syntee.window.hide()
  const dockOpen = useTerminalStore(s => s.dockOpen)
  const handleTerminalToggle = () => {
    useTerminalStore.getState().toggleDock()
  }
  const user = useAuthStore(s => s.user)
  const planUsage = useBillingStore(s => s.planUsage)

  // Индикатор дневного лимита — кольцевой прогресс вокруг аватара.
  const dailyLimitPct = planUsage && planUsage.usage.today_total_tokens > 0
    ? Math.min(100, (planUsage.usage.today_tokens / planUsage.usage.today_total_tokens) * 100)
    : null
  const limitCritical = dailyLimitPct !== null && dailyLimitPct >= 90
  const limitWarning = dailyLimitPct !== null && dailyLimitPct >= 70 && dailyLimitPct < 90

  return (
    <div className="titlebar drag-region">
      <div className="titlebar-left no-drag">
        <div className="titlebar-logo">
          <Logo size={22} />
        </div>
        <span className="titlebar-title">Syntee</span>
      </div>

      <div className="titlebar-right no-drag">
        {onMemoryClick && <IconButton icon="brain" label="Память" onClick={onMemoryClick} />}
        <IconButton
          icon="terminal"
          label="Терминал"
          active={dockOpen}
          onClick={handleTerminalToggle}
        />
        {onAgentClick && <IconButton icon="panelRight" label="Панель" onClick={onAgentClick} />}
        {onSettingsClick && <IconButton icon="settings" label="Настройки" onClick={onSettingsClick} />}
        {user && onProfileClick && (
          <button
            type="button"
            className={`titlebar-avatar-btn ${limitCritical ? 'titlebar-avatar-btn--critical' : limitWarning ? 'titlebar-avatar-btn--warning' : ''}`}
            onClick={onProfileClick}
            title={
              dailyLimitPct !== null
                ? `${user.display_name || user.email} · дневной лимит: ${Math.round(dailyLimitPct)}%`
                : user.display_name || user.email
            }
            aria-label="Профиль"
          >
            <Identicon
              seed={user.id || user.email}
              src={user.avatar_url}
              size={26}
              alt={user.display_name || user.email}
            />
            {dailyLimitPct !== null && (
              <span
                className={`titlebar-limit-ring ${limitCritical ? 'titlebar-limit-ring--critical' : limitWarning ? 'titlebar-limit-ring--warning' : ''}`}
                style={{
                  background: `conic-gradient(currentColor ${dailyLimitPct * 3.6}deg, transparent 0deg)`,
                }}
              />
            )}
          </button>
        )}
        <IconButton icon="minus" label="Свернуть" onClick={handleMinimize} />
        <IconButton icon="x" label="В трей" onClick={handleHide} danger className="titlebar-btn titlebar-btn--close" />
      </div>
    </div>
  )
}
