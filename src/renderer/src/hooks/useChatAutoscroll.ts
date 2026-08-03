import { useCallback, useEffect, useRef, useState } from 'react'

// ── Умный плавный автоскролл чата ───────────────────────────────────────────
// Модель «прилип/отлип» (как в ChatGPT):
//   • pinnedRef=true («прилип» к низу) — постоянный rAF-loop каждый кадр
//     догоняет низ шагом clamp(diff × 0.22, 1.5, 90px): экспоненциальное
//     сближение с капом скорости, БЕЗ телепортов. Следит за любым ростом
//     контента (токены, тулы, todo, mermaid-ресайз) — loop читает scrollHeight
//     каждый кадр, отдельный ResizeObserver не нужен.
//   • Отлип: колесо вверх / touch-drag вверх — мгновенно; перетаскивание
//     скроллбара — по уменьшению scrollTop в handleScroll (наши записи его
//     только увеличивают, поэтому уменьшение = пользователь).
//   • Прилип обратно: только когда пользователь ДВИЖЕТСЯ ВНИЗ и доехал до
//     низа (dist < 8px). НЕ «любое событие рядом с низом» — старая модель
//     перезакрепляла на каждом scroll-событии в 24px от низа и боролась с
//     отлипом колесом → «баганый» скролл.
//   • Плюс явный pin(): отправка запроса, кнопка «вниз», смена чата.
//
// Loop живёт только пока pinned (отлип → tick видит pinned=false → loop
// умирает; прилип → ensureLoop будит). Никаких гейтов по isTyping — рост
// после стрима (дорисовка тулов/картинок) тоже догоняется.
//
// Защита от ложного отлипа при СЖАТИИ контента: если scrollHeight уменьшился
// (схлопнулся шаг/картинка), Chromium клампит scrollTop вниз и стреляет
// scroll-событие с уменьшением — такое событие игнорируем (sh < prevSh − 1).

const REPIN_DIST = 8    // px от низа — прилип при ручном доезде
const BTN_DIST = 24     // px от низа — порог показа floating-кнопки «вниз»
const MAX_STEP = 90     // px/кадр — кап скорости догона (без телепортов)
const SMOOTH_FACTOR = 0.22 // доля отставания за кадр (быстрый отклик)
const MIN_STEP = 1.5    // px/кадр — минимальный шаг, чтобы не залипать

export interface UseChatAutoscrollOptions {
  /** Скролл-контейнер ленты (.chat-messages). */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  /** Доп. логика в rAF-throttled scroll-хендлере (догрузка старых у верха). */
  onScrollExtra?: () => void
}

export interface ChatAutoscroll {
  /** true = «прилип» к низу. Менять снаружи только через pin()/handleWheel. */
  pinnedRef: React.MutableRefObject<boolean>
  showScrollDownBtn: boolean
  setShowScrollDownBtn: (v: boolean) => void
  /** Закрепить и доехать до низа. instant=true — мгновенный прыжок
   *  (отправка запроса, смена чата, первая загрузка). */
  pin: (instant?: boolean) => void
  /** Отлепить от низа (pinned=false). Гасит rAF-loop догона — нужно при
   *  среднем клике колесика (браузерный autoscroll-жест) и при прыжке по
   *  минимапе, иначе loop мгновенно тащит обратно к низу. */
  unpin: () => void
  /** Мгновенный скролл к низу без смены pinned (для initial-scroll). */
  scrollToBottomInstant: () => void
  /** Перечитать scrollTop/scrollHeight в refs после ВНЕШНЕЙ записи scrollTop
   *  (prepend-компенсация старых сообщений) — иначе handleScroll воспримет
   *  её как пользовательский скролл. */
  syncScrollState: () => void
  handleScroll: () => void
  handleWheel: (e: React.WheelEvent<HTMLDivElement>) => void
  /** Средний клик колесика (button===1) → отлеп. Браузерный autoscroll-жест
   *  (кружок-курсор) сам по себе работает, но пока pinned=true rAF-loop
   *  каждый кадр тащит обратно к низу — жест «багается». preventDefault НЕ
   *  зовём: нам нужен сам жест, только гасим loop. */
  handleMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void
  handleTouchStart: (e: React.TouchEvent<HTMLDivElement>) => void
  handleTouchMove: (e: React.TouchEvent<HTMLDivElement>) => void
}

export function useChatAutoscroll({ scrollContainerRef, onScrollExtra }: UseChatAutoscrollOptions): ChatAutoscroll {
  const pinnedRef = useRef(true)
  const [showScrollDownBtn, setShowScrollDownBtn] = useState(false)

  const rafRef = useRef<number | null>(null)
  const scrollPendingRef = useRef(false)
  const lastScrollTopRef = useRef(0)
  const lastScrollHeightRef = useRef(0)
  const touchYRef = useRef<number | null>(null)

  // Свежая ссылка на onScrollExtra без пересоздания handleScroll.
  // Запись в ref — только в эффекте (правило React Compiler).
  const onScrollExtraRef = useRef(onScrollExtra)
  useEffect(() => { onScrollExtraRef.current = onScrollExtra })

  // rAF-loop догона: живёт пока pinned. Каждый кадр — плавный шаг к низу.
  // tick в ref: loop самоперезапускается через rAF, а React Compiler
  // запрещает самоссылку useCallback — ref-обёртка снимает проблему.
  const tickRef = useRef<() => void>(() => {})
  useEffect(() => {
    tickRef.current = () => {
      rafRef.current = null
      if (!pinnedRef.current) return // отлип — loop умирает
      const el = scrollContainerRef.current
      if (!el) return
      const target = el.scrollHeight - el.clientHeight
      const current = el.scrollTop
      const diff = target - current
      if (diff > 0.5) {
        const step = Math.min(Math.max(diff * SMOOTH_FACTOR, MIN_STEP), MAX_STEP, diff)
        el.scrollTop = current + step
        // Наши записи только увеличивают scrollTop — синхронизируем refs,
        // чтобы handleScroll не считал это пользовательским событием.
        lastScrollTopRef.current = el.scrollTop
        lastScrollHeightRef.current = el.scrollHeight
      }
      rafRef.current = requestAnimationFrame(() => tickRef.current())
    }
  }, [scrollContainerRef])

  const ensureLoop = useCallback(() => {
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(() => tickRef.current())
  }, [])

  // Loop при монтировании (pinned стартует true) + очистка при размонтировании.
  useEffect(() => {
    ensureLoop()
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [ensureLoop])

  const scrollToBottomInstant = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight - el.clientHeight
    lastScrollTopRef.current = el.scrollTop
    lastScrollHeightRef.current = el.scrollHeight
  }, [scrollContainerRef])

  const syncScrollState = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    lastScrollTopRef.current = el.scrollTop
    lastScrollHeightRef.current = el.scrollHeight
  }, [scrollContainerRef])

  const pin = useCallback((instant = false) => {
    pinnedRef.current = true
    setShowScrollDownBtn(false)
    if (instant) scrollToBottomInstant()
    ensureLoop()
  }, [ensureLoop, scrollToBottomInstant])

  const unpin = useCallback(() => {
    pinnedRef.current = false
    setShowScrollDownBtn(true)
  }, [])

  // Средний клик колесика → отлеп (браузерный autoscroll-жест не должен
  // конкурировать с rAF-loop'ом догона). preventDefault НЕ зовём — жест нужен.
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button === 1) unpin()
  }, [unpin])

  const handleScroll = useCallback(() => {
    if (scrollPendingRef.current) return
    scrollPendingRef.current = true
    requestAnimationFrame(() => {
      scrollPendingRef.current = false
      onScrollExtraRef.current?.()
      const el = scrollContainerRef.current
      if (!el) return
      const st = el.scrollTop
      const sh = el.scrollHeight
      const prevSt = lastScrollTopRef.current
      const prevSh = lastScrollHeightRef.current
      lastScrollTopRef.current = st
      lastScrollHeightRef.current = sh

      const hasScroll = sh - el.clientHeight > BTN_DIST
      if (!hasScroll) {
        setShowScrollDownBtn(false)
        return
      }
      const dist = sh - st - el.clientHeight

      // Движение ВНИЗ + доехали до низа — прилип (только ручной доезд:
      // у низа больше нет перезакрепления «по любому событию»).
      if (st > prevSt + 0.5 && dist < REPIN_DIST) {
        pinnedRef.current = true
        setShowScrollDownBtn(false)
        ensureLoop()
        return
      }
      // Движение ВВЕРХ не из-за сжатия контента — отлип.
      if (st < prevSt - 2 && sh >= prevSh - 1) {
        pinnedRef.current = false
        setShowScrollDownBtn(true)
        return
      }
      // Кнопка «вниз»: видна когда отлипли и не у низа.
      if (!pinnedRef.current && dist > BTN_DIST) setShowScrollDownBtn(true)
      else if (dist < BTN_DIST && pinnedRef.current) setShowScrollDownBtn(false)
    })
  }, [ensureLoop, scrollContainerRef])

  // Колесо вверх → мгновенный отлип (не ждём scroll-событие).
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0 && pinnedRef.current) {
      pinnedRef.current = false
      setShowScrollDownBtn(true)
    }
  }, [])

  // Touch: палец тянет ВНИЗ (контент скроллится вверх) → отлип.
  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    touchYRef.current = e.touches[0]?.clientY ?? null
  }, [])
  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const startY = touchYRef.current
    if (startY === null) return
    const y = e.touches[0]?.clientY
    if (y !== undefined && y > startY + 6 && pinnedRef.current) {
      pinnedRef.current = false
      setShowScrollDownBtn(true)
    }
  }, [])

  return {
    pinnedRef,
    showScrollDownBtn,
    setShowScrollDownBtn,
    pin,
    unpin,
    scrollToBottomInstant,
    syncScrollState,
    handleScroll,
    handleWheel,
    handleMouseDown,
    handleTouchStart,
    handleTouchMove,
  }
}
