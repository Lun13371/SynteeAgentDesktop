import { motion } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import Logo from '../Logo/Logo'
import './BootScreen.css'

interface BootScreenProps {
  /** Текущий шаг загрузки — показывается shimmer-текстом под логотипом. */
  status?: string
}

/**
 * Экран загрузки при старте приложения.
 *
 * Показывается пока не готовы: visual settings, auth check, chats/projects/messages.
 * Переиспользует визуальный язык LoginScreen (hexagon-логотип + radial-gradient
 * backdrop + accent-цвета). Логотип дышит (pulse-ring), статусный текст —
 * shimmer-sweep (msg-shimmer keyframe). Spinner под логотипом.
 *
 * Анимация: только exit (fade + slight scale-up) — появляется мгновенно,
 * заменяя inline-splash из index.html без мигания, исчезает с crossfade
 * в основной UI.
 */
export default function BootScreen({ status }: BootScreenProps) {
  return (
    <motion.div
      className="boot-screen"
      exit={{ opacity: 0, scale: 1.03 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
    >
      <div className="boot-screen__bg" />
      <div className="boot-screen__content">
        <div className="boot-screen__logo">
          <Logo size={56} />
        </div>
        <div className="boot-screen__spinner">
          <AppIcon name="loader" size="sm" animation="spin" />
        </div>
        {status && <div className="boot-screen__status">{status}</div>}
      </div>
    </motion.div>
  )
}
