import { useCallback } from 'react'
import { motion } from 'framer-motion'
import type { NotificationItem } from '../../store/notification.store'
import { useNotificationStore } from '../../store/notification.store'
import AppIcon from '../../components/ui/AppIcon/AppIcon'
import './NotificationPage.css'

const TYPE_ICON: Record<string, string> = {
  ai_response: 'sparkles',
  agent_done: 'checkCircle',
  permission: 'shieldAlert',
  ask_user: 'helpCircle',
  messenger: 'messageCircle',
  updates: 'download',
  system: 'info',
}

const TYPE_TONE: Record<string, 'accent' | 'success' | 'warning' | 'danger'> = {
  ai_response: 'accent',
  agent_done: 'success',
  permission: 'warning',
  ask_user: 'accent',
  messenger: 'accent',
  updates: 'accent',
  system: 'accent',
}

const PRIORITY_BORDER: Record<string, string> = {
  info: 'notif-card--info',
  success: 'notif-card--success',
  warning: 'notif-card--warning',
  urgent: 'notif-card--urgent',
}

interface Props {
  item: NotificationItem
  index: number
  screenImg?: string | null
}

const NOTIFICATION_SPRING = { type: 'spring' as const, stiffness: 360, damping: 30, mass: 0.8 }

export default function NotificationCard({ item, index, screenImg }: Props) {
  const { remove, pauseTimer, resumeTimer } = useNotificationStore()

  const handleAction = useCallback(
    (actionId: string) => {
      // Все действия идут через notification:action IPC → main процесс →
      // NotificationManager.handleAction → resolveConfirm/resolveQuestion
      // (прямой callback в том же main процессе, без IPC round-trip).
      window.syntee.notification.action({
        id: item.id,
        actionId,
        type: item.type,
        chatId: item.chatId,
        reqId: item.reqId,
      })
      remove(item.id)
    },
    [item.id, item.type, item.chatId, item.reqId, remove],
  )

  // ── Hover: пауза таймера авто-закрытия ──
  // Click-through переключается ЦЕНТРАЛИЗОВАННО в useOverlayHitTesting
  // (mousemove → elementFromPoint → data-interactive). Здесь только
  // pause-on-hover: mouseenter/mouseleave синтезируются Chromium из
  // форварднутых mousemove — работают и в click-through режиме.
  const handleMouseEnter = useCallback(() => {
    pauseTimer(item.id)
  }, [item.id, pauseTimer])

  const handleMouseLeave = useCallback(() => {
    resumeTimer(item.id)
  }, [item.id, resumeTimer])

  const iconName = item.icon ?? TYPE_ICON[item.type] ?? 'bell'
  const tone = TYPE_TONE[item.type] ?? 'accent'

  return (
    <motion.div
      className={`notif-card ${PRIORITY_BORDER[item.priority] ?? 'notif-card--info'}`}
      data-interactive="true"
      // layout — плавный сдвиг соседних карточек.
      // Карточка больше не морфится из «капли»: мягкое glass-появление
      // выглядит спокойнее и не создаёт ощущения прыжка интерфейса.
      layout
      initial={{ opacity: 0, y: -18, scale: 0.94, filter: 'blur(10px)' }}
      animate={{
        opacity: 1,
        y: 0,
        scale: 1,
        filter: 'blur(0px)',
        transition: {
          ...NOTIFICATION_SPRING,
          opacity: { duration: 0.22, ease: 'easeOut' },
          filter: { duration: 0.28, ease: 'easeOut' },
        },
      }}
      exit={{
        opacity: 0,
        y: -10,
        scale: 0.96,
        filter: 'blur(8px)',
        transition: {
          duration: 0.24,
          ease: [0.4, 0, 0.2, 1],
        },
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{ zIndex: 100 - index, originX: 0.5, originY: 0 }}
    >
      {screenImg && (
        <div className="notif-blur-bg" style={{ backgroundImage: `url(${screenImg})` }} />
      )}

      {index > 0 && (
        <motion.div
          className="notif-droplet-link"
          initial={{ scaleY: 0, opacity: 0, height: 0 }}
          animate={{ scaleY: 1, opacity: 1, height: 8 }}
          exit={{ scaleY: 0, opacity: 0, height: 0 }}
          transition={{ delay: 0.2, duration: 0.3, ease: 'easeOut' }}
        />
      )}

      <motion.div
        className="notif-card-inner"
        initial={{ opacity: 0, y: 5 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08, duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="notif-icon-wrap">
          <AppIcon name={iconName as any} size="sm" tone={tone} strokeWidth={2} />
        </div>

        <div className="notif-content">
          <div className="notif-title">{item.title}</div>
          {item.body && <div className="notif-body">{item.body}</div>}
          {item.actions.length > 0 && (
            <div className="notif-actions">
              {item.actions.map((action) => (
                <button
                  key={action.id}
                  className="notif-action-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleAction(action.id)
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          className="notif-close"
          onClick={(e) => {
            e.stopPropagation()
            remove(item.id)
          }}
          title="Закрыть"
        >
          <AppIcon name="x" size="xs" tone="muted" strokeWidth={2.2} />
        </button>
      </motion.div>
      {item.duration && item.duration > 0 && (
        <span
          className="notif-progress"
          aria-hidden="true"
          style={{
            animationDuration: `${item.duration}ms`,
            animationPlayState: item.paused ? 'paused' : 'running',
          }}
        />
      )}
    </motion.div>
  )
}
