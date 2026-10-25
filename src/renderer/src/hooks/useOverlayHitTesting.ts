import { useEffect, useRef } from 'react'
import { useNotificationStore } from '../store/notification.store'
import { useActivityStore } from '../store/activity.store'

/**
 * useOverlayHitTesting — renderer-side hit-testing для click-through overlay-окна.
 *
 * Окно в click-through режиме (setIgnoreMouseEvents(true, {forward:true}))
 * пропускает клики сквозь себя, но mousemove продолжают приходить в renderer.
 * На каждый mousemove (троттлинг через rAF — max 1 проверка на кадр) проверяем
 * document.elementFromPoint: если курсор над [data-interactive] элементом
 * (карточка уведомления, activity-виджет) — окно становится интерактивным
 * (ловит клики), иначе — обратно click-through. IPC уходит ТОЛЬКО на смену
 * состояния, не на каждый mousemove.
 *
 * Две оптимизации, без которых лагал курсор:
 *  1. ПРЕДОТСЕВ ПО ЗОНЕ. elementFromPoint форсит синхронный style/layout-flush.
 *     Окно полноэкранное (объединение всех мониторов), поэтому вызов на каждый
 *     mousemove в любом месте рабочего стола — это flush на каждом кадре.
 *     Стек overlay живёт в узкой полосе top-center: сначала дешёвая проверка
 *     координат по закэшированному rect стека, elementFromPoint — только внутри.
 *  2. ЗАМОРОЗКА НА ВРЕМЯ АНИМАЦИИ. Пока карточка появляется/уходит/морфит
 *     (width 48→340, height, borderRadius), её граница [data-interactive] ездит
 *     под курсором → setInteractive(true/false) флапал на каждом кадре →
 *     setIgnoreMouseEvents на полноэкранном окне → микро-стопоры композитора.
 *     На время анимации состояние не пересчитываем (после — пересчёт по
 *     последней позиции курсора).
 *
 * Это заменяет main-процесс polling (100ms курсор + 200ms bounds):
 *  - задержка клика = 1 IPC round-trip (~1-5ms) вместо до 100ms
 *  - точный хит-тест (elementFromPoint учитывает border-radius/transform/z-index)
 *  - ноль таймеров в main, setIgnoreMouseEvents дёргается только на hover enter/leave
 *
 * Safety: document mouseleave (курсор ушёл со всех экранов), конец анимации
 * (пере-проверка по последней позиции) и unmount сбрасывают в click-through.
 */

/** Запас зоны вокруг rect стека (карточка 340px + пружина scale). */
const ZONE_PAD_X = 320
const ZONE_PAD_Y = 48
/** Как часто перечитывать rect стека (мс). */
const ZONE_TTL_MS = 120
/** Заморозка hit-test после смены состава стека (длительность морфа). */
const ANIM_FREEZE_MS = 600

interface Zone {
  top: number
  bottom: number
  left: number
  right: number
}

export function useOverlayHitTesting(): void {
  const interactiveRef = useRef(false)
  const rafPending = useRef(false)
  const zoneRef = useRef<Zone | null>(null)
  const zoneAtRef = useRef(0)
  const freezeUntilRef = useRef(0)
  const recheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastPointRef = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const setInteractive = (v: boolean): void => {
      if (v === interactiveRef.current) return
      interactiveRef.current = v
      window.syntee.notification.setInteractive(v)
    }

    /** Rect стека (кэш на ZONE_TTL_MS): один layout-read вместо elementFromPoint. */
    const getZone = (now: number): Zone | null => {
      const cached = zoneRef.current
      if (cached && now - zoneAtRef.current < ZONE_TTL_MS) return cached
      const stack = document.querySelector('.notif-stack') as HTMLElement | null
      zoneAtRef.current = now
      if (!stack) {
        zoneRef.current = null
        return null
      }
      const r = stack.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) {
        zoneRef.current = null
        return null
      }
      const zone: Zone = {
        top: r.top - ZONE_PAD_Y,
        bottom: r.bottom + ZONE_PAD_Y,
        left: r.left - ZONE_PAD_X,
        right: r.right + ZONE_PAD_X,
      }
      zoneRef.current = zone
      return zone
    }

    /** Полная проверка точки: зона → (не анимируем) → elementFromPoint. */
    const evaluate = (x: number, y: number): void => {
      const now = performance.now()
      const zone = getZone(now)
      if (!zone || x < zone.left || x > zone.right || y < zone.top || y > zone.bottom) {
        // Вне зоны стека интерактивных элементов быть не может — сразу
        // click-through, без layout-flush.
        setInteractive(false)
        return
      }
      if (now < freezeUntilRef.current) return
      setInteractive(!!document.elementFromPoint(x, y)?.closest('[data-interactive]'))
    }

    /** Стек изменился → идёт анимация: не пересчитываем до её конца. */
    const freeze = (): void => {
      freezeUntilRef.current = performance.now() + ANIM_FREEZE_MS
      if (recheckTimer.current) clearTimeout(recheckTimer.current)
      // По завершении анимации пере-проверяем последнюю позицию курсора:
      // если он стоит неподвижно над карточкой — она станет интерактивной
      // без нового mousemove.
      recheckTimer.current = setTimeout(() => {
        recheckTimer.current = null
        const p = lastPointRef.current
        if (p) evaluate(p.x, p.y)
      }, ANIM_FREEZE_MS + 30)
    }

    // Смена состава стека = enter/exit/morph анимация карточки или виджета.
    const offNotifications = useNotificationStore.subscribe((s, prev) => {
      if (s.notifications.length !== prev.notifications.length) freeze()
    })
    const offActivity = useActivityStore.subscribe((s, prev) => {
      if (s.visible !== prev.visible) freeze()
    })

    const onMove = (e: MouseEvent): void => {
      lastPointRef.current = { x: e.clientX, y: e.clientY }
      if (rafPending.current) return
      rafPending.current = true
      requestAnimationFrame(() => {
        rafPending.current = false
        evaluate(e.clientX, e.clientY)
      })
    }

    // Курсор покинул документ (ушёл со всех экранов) — сброс в click-through
    const onLeave = (): void => setInteractive(false)

    window.addEventListener('mousemove', onMove, { passive: true })
    document.addEventListener('mouseleave', onLeave)
    return () => {
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseleave', onLeave)
      offNotifications()
      offActivity()
      if (recheckTimer.current) clearTimeout(recheckTimer.current)
      recheckTimer.current = null
      setInteractive(false)
    }
  }, [])
}
