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
  add: (message, type = 'default', duration = 3000) => {
    const id = Math.random().toString(36).slice(2)
    set(s => ({ toasts: [...s.toasts, { id, message, type, duration }] }))
    setTimeout(() => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })), duration)
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
  const { toasts } = useToast()

  return (
    <div className="toast-container">
      <AnimatePresence>
        {toasts.map(toast => (
          <motion.div
            key={toast.id}
            className={`toast toast--${toast.type}`}
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 350, damping: 28 }}
          >
            <span className="toast-icon">{getToastIcon(toast.type)}</span>
            <span className="toast-message">{toast.message}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
