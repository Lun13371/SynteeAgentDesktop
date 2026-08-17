import { useEffect, useRef, useCallback, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { useNotificationStore } from '../../store/notification.store'
import { useActivityStore } from '../../store/activity.store'
import { useSettingsStore } from '../../store/settings.store'
import { applyAccentToDOM, applyGlassToDOM } from '../../App'
import NotificationCard from './NotificationCard'
import ActivityWidget from './ActivityWidget'
import './NotificationPage.css'

export default function NotificationPage() {
  const { notifications, add, dismissAll } = useNotificationStore()
  const activityVisible = useActivityStore(s => s.visible)
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
  // Собираем bounds ВСЕХ интерактивных элементов: карточки + activity-виджет.
  // ВАЖНО: updateBounds — стабильный (без deps), читает activityVisible из store
  // напрямую через getState(). Это НЕ вызывает пересоздание callback при смене
  // activityVisible → effect не перезапускается → tracking НЕ сбрасывается.
  // Без этого был баг: при пропадании виджета stopTracking→startTracking
  // сбрасывал cardBounds → клики шли сквозь карточки ~100ms.
  const updateBounds = useCallback(() => {
    const bounds: Array<{ x: number; y: number; w: number; h: number }> = []
    for (const [, el] of cardRefs.current) {
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        bounds.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height })
      }
    }
    // Включаем activity-виджет в bounds ТОЛЬКО когда он виден.
    if (useActivityStore.getState().visible) {
      const widgetEl = document.querySelector('.activity-widget')
      if (widgetEl) {
        const rect = widgetEl.getBoundingClientRect()
        const computed = window.getComputedStyle(widgetEl)
        if (rect.width > 0 && rect.height > 0 && computed.opacity !== '0') {
          bounds.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height })
        }
      }
    }
    window.syntee.notification.updateBounds(bounds)
  }, [])

  useEffect(() => {
    // Если есть уведомления ИЛИ activity-виджет виден — нужен tracking + bounds polling.
    const hasInteractiveContent = notifications.length > 0 || activityVisible

    if (!hasInteractiveContent) {
      window.syntee.notification.stopTracking()
      const hideTimer = setTimeout(() => {
        window.syntee.notification.hide()
      }, 200)
      return () => clearTimeout(hideTimer)
    }
    window.syntee.notification.startTracking()
    updateBounds()
    const boundsTimer = setInterval(updateBounds, 200)
    // НЕ останавливаем tracking в cleanup — следующий запуск effect'а
    // сам решит нужен ли tracking. Это убирает gap stopTracking→startTracking
    // когда activityVisible меняется но уведомления ещё есть.
    return () => {
      clearInterval(boundsTimer)
    }
  }, [notifications.length, activityVisible, updateBounds])

  // Захват экрана для блюра — ТОЛЬКО для карточек уведомлений.
  // Activity-виджет использует CSS backdrop-filter (без desktopCapturer)
  // чтобы избежать DXGI warnings и лага при появлении.
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
        {/* Activity widget — ПЕРВЫМ в стеке, по центру сверху.
            Показывается сразу при старте запроса когда окно неактивно/свёрнуто.
            Адаптируется к стеку: если есть уведомления — они ниже.
            AnimatePresence внутри самого ActivityWidget — управляет exit-анимацией. */}
        <ActivityWidget />
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
