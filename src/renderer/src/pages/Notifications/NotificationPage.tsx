import { useEffect, useRef, useCallback, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { useNotificationStore } from '../../store/notification.store'
import { useSettingsStore } from '../../store/settings.store'
import { applyAccentToDOM, applyGlassToDOM } from '../../App'
import NotificationCard from './NotificationCard'
import './NotificationPage.css'

export default function NotificationPage() {
  const { notifications, add, dismissAll } = useNotificationStore()
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map())
  const settings = useSettingsStore()
  const [screenImg, setScreenImg] = useState<string | null>(null)

  // Загружаем настройки (overlay окно — отдельный JS context)
  useEffect(() => {
    if (!settings.loaded) {
      settings.load()
    }
  }, [settings])

  // Применяем тему/accent для overlay-окна
  useEffect(() => {
    if (!settings.loaded || !settings.settings) return
    const s = settings.settings
    const accent = (s['accentColor'] as string) || '#ffffff'
    applyAccentToDOM(accent)
    const glassBlur = s['glassBlur'] as number
    if (typeof glassBlur === 'number') applyGlassToDOM(glassBlur)
  }, [settings.loaded, settings.settings])

  // Подписка на входящие уведомления
  useEffect(() => {
    const off = window.syntee.notification.onPush((payload) => {
      add(payload)
    })
    return off
  }, [add])

  // Dismiss all когда главное окно становится активным
  useEffect(() => {
    const off = window.syntee.notification.onDismissAll(() => {
      dismissAll()
    })
    return off
  }, [dismissAll])

  // ── Polling backup ──
  // Основной механизм — mouseenter/mouseleave на карточке (в NotificationCard).
  // Polling — backup на случай если forward:true не работает.
  const updateBounds = useCallback(() => {
    const bounds: Array<{ x: number; y: number; w: number; h: number }> = []
    for (const [, el] of cardRefs.current) {
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        bounds.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height })
      }
    }
    window.syntee.notification.updateBounds(bounds)
  }, [])

  useEffect(() => {
    if (notifications.length === 0) {
      window.syntee.notification.stopTracking()
      return
    }
    window.syntee.notification.startTracking()
    let rafId = 0
    const loop = () => {
      updateBounds()
      rafId = requestAnimationFrame(loop)
    }
    rafId = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(rafId)
      window.syntee.notification.stopTracking()
    }
  }, [notifications.length, updateBounds])

  // Захват экрана для блюра
  const hasNotifications = notifications.length > 0
  useEffect(() => {
    if (!hasNotifications) return
    let cancelled = false
    window.syntee.notification.captureScreen().then((img) => {
      if (!cancelled && img) setScreenImg(img)
    })
    return () => { cancelled = true }
  }, [hasNotifications])

  useEffect(() => {
    if (!hasNotifications) {
      const r = requestAnimationFrame(() => setScreenImg(null))
      return () => cancelAnimationFrame(r)
    }
  }, [hasNotifications])

  // Регистрация карточки для polling bounds
  const registerCard = useCallback((id: string) => {
    return (el: HTMLElement | null) => {
      if (el) {
        cardRefs.current.set(id, el)
      } else {
        cardRefs.current.delete(id)
      }
    }
  }, [])

  return (
    <div className="notif-root">
      <div className="notif-stack">
        <AnimatePresence mode="popLayout">
          {notifications.map((item, index) => (
            <div key={item.id} ref={registerCard(item.id)} className="notif-card-wrapper">
              <NotificationCard item={item} index={index} screenImg={screenImg} />
            </div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}
