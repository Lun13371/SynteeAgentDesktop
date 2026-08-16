import { create } from 'zustand'
import type { NotificationPayload } from '../../../shared/types'

export interface NotificationItem extends NotificationPayload {
  /** Время добавления (для анимаций и дедупа) */
  addedAt: number
  /** ID таймера авто-закрытия */
  timerId?: ReturnType<typeof setTimeout>
  /** Оставшееся время при паузе (hover) */
  remainingMs?: number
  /** Приостановлен ли таймер */
  paused?: boolean
}

interface NotificationStore {
  notifications: NotificationItem[]
  add: (payload: NotificationPayload) => void
  remove: (id: string) => void
  pauseTimer: (id: string) => void
  resumeTimer: (id: string) => void
  clear: () => void
  dismissAll: () => void
}

const MAX_NOTIFICATIONS = 5

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  notifications: [],

  add: (payload) => {
    const id = payload.id
    // Дедуп: если уведомление с таким id уже есть — не дублируем
    if (get().notifications.some(n => n.id === id)) return

    const item: NotificationItem = {
      ...payload,
      addedAt: Date.now(),
    }

    // Авто-закрытие
    if (payload.duration && payload.duration > 0) {
      item.timerId = setTimeout(() => {
        get().remove(id)
      }, payload.duration)
      item.remainingMs = payload.duration
    }

    set(state => {
      // Новые сверху, старые сползают вниз. Ограничиваем стек.
      const notifications = [item, ...state.notifications].slice(0, MAX_NOTIFICATIONS)
      // Если обрезали — очищаем таймеры вытесненных
      if (notifications.length < state.notifications.length + 1) {
        state.notifications.slice(MAX_NOTIFICATIONS - 1).forEach(n => {
          if (n.timerId) clearTimeout(n.timerId)
        })
      }
      return { notifications }
    })
  },

  remove: (id) => {
    set(state => {
      const item = state.notifications.find(n => n.id === id)
      if (item?.timerId) clearTimeout(item.timerId)
      return { notifications: state.notifications.filter(n => n.id !== id) }
    })
  },

  pauseTimer: (id) => {
    set(state => ({
      notifications: state.notifications.map(n => {
        if (n.id !== id || !n.timerId || n.paused) return n
        // Считаем оставшееся время
        const elapsed = n.duration ? n.duration - (n.remainingMs ?? n.duration) : 0
        const remaining = (n.remainingMs ?? n.duration ?? 0) - elapsed
        clearTimeout(n.timerId!)
        return { ...n, timerId: undefined, paused: true, remainingMs: remaining }
      }),
    }))
  },

  resumeTimer: (id) => {
    set(state => ({
      notifications: state.notifications.map(n => {
        if (n.id !== id || !n.paused) return n
        const remaining = n.remainingMs ?? n.duration ?? 0
        if (remaining <= 0) return n
        const timerId = setTimeout(() => {
          get().remove(id)
        }, remaining)
        return { ...n, timerId, paused: false }
      }),
    }))
  },

  clear: () => {
    set(state => {
      state.notifications.forEach(n => {
        if (n.timerId) clearTimeout(n.timerId)
      })
      return { notifications: [] }
    })
  },

  /** Плавно убрать все уведомления (renderer вызывает AnimatePresence exit) */
  dismissAll: () => {
    set(state => {
      state.notifications.forEach(n => {
        if (n.timerId) clearTimeout(n.timerId)
      })
      return { notifications: [] }
    })
  },
}))
