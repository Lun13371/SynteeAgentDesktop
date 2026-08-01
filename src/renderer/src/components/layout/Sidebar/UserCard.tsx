import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import AppIcon from '../../ui/AppIcon/AppIcon'
import Identicon from '../../ui/Identicon/Identicon'
import { useAuthStore } from '../../../store/auth.store'
import { useNavStore } from '../../../store/nav.store'
import { useBillingStore } from '../../../store/billing.store'
import './UserCard.css'

export default function UserCard() {
  const user = useAuthStore(s => s.user)
  const logout = useAuthStore(s => s.logout)
  const openSettings = useNavStore(s => s.openSettings)
  const [panelOpen, setPanelOpen] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [panelPos, setPanelPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)

  const planUsage = useBillingStore(s => s.planUsage)

  const dailyLimit = planUsage?.plan?.daily_token_limit ?? 0
  const dailyUsed = planUsage?.usage?.today_tokens ?? 0
  const dailyLimitPct = planUsage && dailyLimit > 0
    ? Math.min(100, (dailyUsed / dailyLimit) * 100)
    : null
  const dailyCritical = dailyLimitPct !== null && dailyLimitPct >= 90
  const dailyWarning = dailyLimitPct !== null && dailyLimitPct >= 70 && dailyLimitPct < 90

  const weeklyLimit = planUsage?.plan?.weekly_token_limit ?? 0
  const weeklyUsed = planUsage?.usage?.week_tokens ?? 0
  const weeklyLimitPct = planUsage && weeklyLimit > 0
    ? Math.min(100, (weeklyUsed / weeklyLimit) * 100)
    : null
  const weeklyCritical = weeklyLimitPct !== null && weeklyLimitPct >= 90
  const weeklyWarning = weeklyLimitPct !== null && weeklyLimitPct >= 70 && weeklyLimitPct < 90

  const balanceVal = planUsage?.balance?.balance
  const heldVal = planUsage?.balance?.held ?? 0

  // После рендера панели — измеряем её высоту и позиционируем над карточкой.
  useLayoutEffect(() => {
    if (!panelOpen || !panelRef.current || !cardRef.current) return
    const panelH = panelRef.current.offsetHeight
    const cardRect = cardRef.current.getBoundingClientRect()
    const top = Math.max(8, cardRect.top - panelH - 4)
    setPanelPos(prev => prev ? { ...prev, top, maxHeight: cardRect.top - 12 } : prev)
  }, [panelOpen])

  useEffect(() => {
    if (!panelOpen) return
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (cardRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setPanelOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [panelOpen])

  useEffect(() => {
    if (!panelOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPanelOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [panelOpen])

  const openPanel = () => {
    if (!cardRef.current) return
    const rect = cardRef.current.getBoundingClientRect()
    // Начальная позиция — чуть выше карточки, уточнится в useLayoutEffect
    setPanelPos({
      left: rect.left,
      width: rect.width,
      top: Math.max(8, rect.top - 300),
      maxHeight: rect.top - 12,
    })
    setPanelOpen(v => !v)
  }

  const handleProfile = () => {
    setPanelOpen(false)
    openSettings('profile')
  }

  const handleSettings = () => {
    setPanelOpen(false)
    openSettings('general')
  }

  const handleLogout = async () => {
    setPanelOpen(false)
    await logout()
  }

  if (!user) {
    return (
      <div className="usercard usercard--guest" ref={cardRef}>
        <button
          type="button"
          className="usercard-signin"
          onClick={() => openSettings('profile')}
          title="Нажмите, чтобы войти в Syntee-Gateway"
        >
          <div className="usercard-avatar-placeholder">
            <AppIcon name="user" size="sm" />
          </div>
          <div className="usercard-info">
            <div className="usercard-name">Гость</div>
            <div className="usercard-email">Нажмите, чтобы войти</div>
          </div>
        </button>
      </div>
    )
  }

  const handle = user.username ? `@${user.username}` : user.email.split('@')[0]
  const displayName = user.display_name || handle
  const planName = planUsage?.plan?.name

  return (
    <>
      <div className="usercard" ref={cardRef}>
        <button
          type="button"
          className="usercard-btn"
          onClick={() => openPanel()}
        >
          <Identicon
            seed={user.id || user.email}
            src={user.avatar_url}
            size={30}
            alt={displayName}
          />
          <div className="usercard-info">
            <div className="usercard-name">{displayName}</div>
            <div className="usercard-email">{handle}</div>
          </div>
          <AppIcon name={panelOpen ? 'chevronDown' : 'chevronRight'} size="xs" tone="muted" />
        </button>
      </div>

      {createPortal(
        <AnimatePresence>
          {panelOpen && panelPos && (
            <motion.div
              ref={panelRef}
              className="usercard-panel"
              style={{
                position: 'fixed',
                left: panelPos.left,
                width: panelPos.width,
                top: panelPos.top,
                zIndex: 10001,
                maxHeight: panelPos.maxHeight,
              }}
              initial={{ opacity: 0, y: 24, scale: 0.92 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 24, scale: 0.92 }}
              transition={{ type: 'spring', stiffness: 380, damping: 26, mass: 0.8 }}
            >
              <div className="usercard-panel-header">
                <Identicon
                  seed={user.id || user.email}
                  src={user.avatar_url}
                  size={40}
                  alt={displayName}
                />
                <div className="usercard-panel-user">
                  <div className="usercard-panel-name">{displayName}</div>
                  <div className="usercard-panel-email">{handle}</div>
                  {planName && (
                    <span className="usercard-panel-plan">{planName}</span>
                  )}
                  {balanceVal !== undefined && (
                    <div className="usercard-panel-balance">
                      <span className="usercard-panel-balance-value">${balanceVal.toFixed(4)}</span>
                      {heldVal > 0 && (
                        <span className="usercard-panel-balance-held">· холд ${heldVal.toFixed(4)}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {dailyLimitPct !== null && (
                <div className="usercard-panel-limit">
                  <div className="usercard-panel-limit-header">
                    <span className="usercard-panel-limit-label">Дневной лимит</span>
                    <span
                      className={`usercard-panel-limit-pct ${
                        dailyCritical ? 'usercard-panel-limit-pct--critical' :
                        dailyWarning ? 'usercard-panel-limit-pct--warning' : ''
                      }`}
                    >
                      {Math.round(dailyLimitPct)}%
                    </span>
                  </div>
                  <div className="usercard-panel-limit-bar">
                    <div
                      className={`usercard-panel-limit-fill ${
                        dailyCritical ? 'usercard-panel-limit-fill--critical' :
                        dailyWarning ? 'usercard-panel-limit-fill--warning' : ''
                      }`}
                      style={{ width: `${dailyLimitPct}%` }}
                    />
                  </div>
                  <div className="usercard-panel-limit-foot">
                    <span>{fmtTokens(dailyUsed)} / {fmtTokens(dailyLimit)}</span>
                    {planUsage?.usage?.today_reset_at && (
                      <span className="usercard-panel-limit-reset">
                        сброс {fmtReset(planUsage.usage.today_reset_at)}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {weeklyLimitPct !== null && (
                <div className="usercard-panel-limit usercard-panel-limit--last">
                  <div className="usercard-panel-limit-header">
                    <span className="usercard-panel-limit-label">Недельный лимит</span>
                    <span
                      className={`usercard-panel-limit-pct ${
                        weeklyCritical ? 'usercard-panel-limit-pct--critical' :
                        weeklyWarning ? 'usercard-panel-limit-pct--warning' : ''
                      }`}
                    >
                      {Math.round(weeklyLimitPct)}%
                    </span>
                  </div>
                  <div className="usercard-panel-limit-bar">
                    <div
                      className={`usercard-panel-limit-fill ${
                        weeklyCritical ? 'usercard-panel-limit-fill--critical' :
                        weeklyWarning ? 'usercard-panel-limit-fill--warning' : ''
                      }`}
                      style={{ width: `${weeklyLimitPct}%` }}
                    />
                  </div>
                  <div className="usercard-panel-limit-foot">
                    <span>{fmtTokens(weeklyUsed)} / {fmtTokens(weeklyLimit)}</span>
                    {planUsage?.usage?.week_reset_at && (
                      <span className="usercard-panel-limit-reset">
                        сброс {fmtReset(planUsage.usage.week_reset_at)}
                      </span>
                    )}
                  </div>
                </div>
              )}

              <div className="usercard-panel-actions">
                <button className="usercard-panel-action" onClick={handleProfile}>
                  <AppIcon name="user" size="sm" />
                  <span>Профиль</span>
                </button>
                <button className="usercard-panel-action" onClick={handleSettings}>
                  <AppIcon name="settings" size="sm" />
                  <span>Настройки</span>
                </button>
                <div className="usercard-panel-divider" />
                <button
                  className="usercard-panel-action usercard-panel-action--danger"
                  onClick={handleLogout}
                >
                  <AppIcon name="power" size="sm" />
                  <span>Выйти</span>
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  )
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtReset(iso: string): string {
  return new Date(iso).toLocaleString('ru', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
