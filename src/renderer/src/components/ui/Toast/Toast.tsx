import { motion, AnimatePresence } from 'framer-motion'
import { create } from 'zustand'
import AppIcon from '../AppIcon/AppIcon'
import { playToastSound } from '../../../utils/sounds'
import './Toast.css'

interface ToastItem {
  id: string
  message: string
  type?: 'default' | 'success' | 'error' | 'info'
  duration?: number
}

interface ToastStore {
  toasts: ToastItem[]
  add: (msg: string, type?: ToastItem['type'], duration?: number) => void
  remove: (id: string) => void
}

export const useToast = create<ToastStore>((set) => ({
  toasts: [],
  add: (message, type = 'default', duration) => {
    const id = Math.random().toString(36).slice(2)
    // Error-тосты живут 8с (раньше 3с — пользователь не успевал прочитать),
    // остальные — 3с. Можно передать duration явно для кастома.
    const actualDuration = duration ?? (type === 'error' ? 8000 : 3000)
    set(s => ({ toasts: [...s.toasts, { id, message, type, duration: actualDuration }] }))
    setTimeout(() => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })), actualDuration)
    playToastSound(type)
  },
  remove: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
}))

function getToastIcon(type: ToastItem['type']) {
  switch (type) {
    case 'success':
      return <AppIcon name="check" tone="success" size="md" />
    case 'error':
      return <AppIcon name="alertCircle" tone="danger" size="md" />
    case 'info':
      return <AppIcon name="info" tone="accent" size="md" />
    default:
      return <AppIcon name="sparkles" tone="muted" size="md" />
  }
}

export default function ToastContainer() {
  const { toasts, remove } = useToast()

  return (
    <div className="toast-container">
      <AnimatePresence>
        {toasts.map(toast => (
          <motion.div
            key={toast.id}
            className={`toast toast--${toast.type}`}
            initial={{ opacity: 0, y: 14, scale: 0.94, filter: 'blur(8px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -8, scale: 0.97, filter: 'blur(6px)' }}
            // filter — tween (как в NotificationCard): пружина проскакивает
            // ниже blur(0px), и Chromium ругается на blur(-0.0xpx) keyframes.
            transition={{
              type: 'spring',
              stiffness: 420,
              damping: 30,
              mass: 0.75,
              filter: { duration: 0.3, ease: 'easeOut' },
            }}
            layout
          >
            <span className="toast-icon">{getToastIcon(toast.type)}</span>
            <span className="toast-message">{toast.message}</span>
            <button className="toast-close" onClick={() => remove(toast.id)} title="Закрыть" aria-label="Закрыть">✕</button>
            <span
              className="toast-progress"
              aria-hidden="true"
              style={{ animationDuration: `${toast.duration ?? 3000}ms` }}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
