import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { Message } from '../../../../../shared/types'
import { useSettingsStore } from '../../../store/settings.store'
import { whileHoverTiny, whileTapTiny, springHover } from '../../../utils/motionPresets'
import './ChatMinimap.css'
// ── ChatMinimap — миникарта сообщений (точки справа по центру) ─────────────
// Вертикальная полоса точек: одна точка = одно сообщение. Клик — прыжок к
// сообщению (virtualizer.scrollToIndex, center). Ховер — превью (роль,
// сниппет, время). Активная точка — сообщение в центре вьюпорта (подсветка).
// Показывается только когда есть скролл и сообщений >= MIN_MESSAGES.
// Включается/выключается в настройках ('chatMinimap', по умолчанию вкл).

/** Псевдо-сообщения (live-пузырь стрима, compacting-индикатор) — не точки. */
const PSEUDO_IDS = new Set(['live-streaming-bubble', 'compacting-indicator', 'split-live-streaming-bubble'])

const MIN_MESSAGES = 3
/** Максимальная высота полосы — доля от высоты контейнера. */
const STRIP_MAX_RATIO = 0.45
const DOT_GAP = 6
const DOT_MAX = 10
const DOT_MIN = 4

/** Очистка markdown для сниппета (как cleanPreview в сайдбаре, короче). */
function snippet(text: string | undefined): string {
  if (!text) return ''
  return text
    .replace(/```[\s\S]*?```/g, '[код]')
    .replace(/`[^`]+`/g, '[код]')
    .replace(/#{1,6}\s/g, '')
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, 140)
}

function roleLabel(role: Message['role']): string {
  if (role === 'user') return 'Вы'
  if (role === 'assistant') return 'Syntee'
  return 'Система'
}

function formatTime(ts: number): string {
  if (!ts || ts < 1000000) return ''
  return new Date(ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
}

interface ChatMinimapProps {
  /** Виртуализатор ленты — для scrollToIndex и активного индекса. */
  virtualizer: Virtualizer<HTMLDivElement, Element>
  /** displayMessages страницы (включая псевдо — они отфильтровываются). */
  messages: Message[]
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  /** Дёрнуть ПЕРЕД прыжком к сообщению — сбросить pinned автоскролла.
   *  Иначе rAF-loop мгновенно вернёт ленту к низу, и прыжок не виден. */
  onJump?: () => void
}

function ChatMinimap({ virtualizer, messages, scrollContainerRef, onJump }: ChatMinimapProps) {
  const enabled = useSettingsStore(s => (s.settings['chatMinimap'] as boolean | undefined) ?? true)
  // Точки по реальным сообщениям с их исходными индексами в displayMessages
  // (scrollToIndex работает по индексу ПОЛНОГО массива, включая псевдо).
  const dots = useMemo(() => {
    const result: Array<{ origIndex: number; role: Message['role']; id: string }> = []
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      if (PSEUDO_IDS.has(m.id)) continue
      result.push({ origIndex: i, role: m.role, id: m.id })
    }
    return result
  }, [messages])

  const [activeOrigIndex, setActiveOrigIndex] = useState(-1)
  const [hasOverflow, setHasOverflow] = useState(false)
  const [hover, setHover] = useState<{ origIndex: number; clientY: number } | null>(null)
  const scrollRafRef = useRef(false)

  // Свежая ссылка на onJump без пересоздания handleClick (как onScrollExtraRef
  // в useChatAutoscroll). React Compiler не любит самоссылку useCallback —
  // ref-обёртка снимает проблему.
  const onJumpRef = useRef(onJump)
  useEffect(() => { onJumpRef.current = onJump })

  // Активное сообщение — по центру вьюпорта. Свой scroll-listener (passive,
  // rAF-throttled) — независим от onScroll страницы.
  // ВАЖНО: scrollContainerRef.current может быть null на первом рендере —
  // .chat-messages монтируется только в ветке !showSkeleton && messages>0.
  // Ref-object не триггерит эффект при заполнении .current, поэтому эффект
  // перевыполняется на messages.length/dots.length (меняются когда контейнер
  // появляется). Дополнительно — retry-цикл на rAF пока el не появится.
  useEffect(() => {
    let raf = 0
    let cancelled = false
    let cleanup: (() => void) | undefined
    let ro: ResizeObserver | undefined
    const onScroll = () => {
      if (scrollRafRef.current) return
      scrollRafRef.current = true
      requestAnimationFrame(() => {
        scrollRafRef.current = false
        update()
      })
    }
    const update = () => {
      const el = scrollContainerRef.current
      if (!el) return
      setHasOverflow(el.scrollHeight - el.clientHeight > 24)
      const center = el.scrollTop + el.clientHeight / 2
      const items = virtualizer.getVirtualItems()
      // Бинарный линейный поиск по видимым items: первый, чей конец ниже центра.
      let idx = items.length ? items[items.length - 1].index : -1
      for (const it of items) {
        if (it.end >= center) { idx = it.index; break }
        if (it.start >= center) { idx = it.index; break }
      }
      setActiveOrigIndex(idx)
    }
    const attach = () => {
      if (cancelled) return
      const el = scrollContainerRef.current
      if (!el) {
        // Контейнер ещё не смонтирован (showSkeleton/empty) — retry в след. кадре.
        raf = requestAnimationFrame(attach)
        return
      }
      update()
      el.addEventListener('scroll', onScroll, { passive: true })
      ro = new ResizeObserver(update)
      ro.observe(el)
      cleanup = () => {
        el.removeEventListener('scroll', onScroll)
        ro?.disconnect()
      }
    }
    attach()
    return () => {
      cancelled = true
      if (raf) cancelAnimationFrame(raf)
      cleanup?.()
    }
  }, [virtualizer, scrollContainerRef, messages.length])

  // Размер точки: при переполнении полосы точки ужимаются до DOT_MIN.
  const [dotSize, setDotSize] = useState(DOT_MAX)
  useEffect(() => {
    let raf = 0
    let cancelled = false
    let ro: ResizeObserver | undefined
    const apply = () => {
      const el = scrollContainerRef.current
      if (!el) return
      const maxH = el.clientHeight * STRIP_MAX_RATIO
      const fit = Math.floor((maxH + DOT_GAP) / (dots.length + DOT_GAP / Math.max(DOT_MAX, 1)))
      setDotSize(Math.max(DOT_MIN, Math.min(DOT_MAX, fit)))
    }
    const attach = () => {
      if (cancelled) return
      const el = scrollContainerRef.current
      if (!el) { raf = requestAnimationFrame(attach); return }
      apply()
      ro = new ResizeObserver(apply)
      ro.observe(el)
    }
    attach()
    return () => {
      cancelled = true
      if (raf) cancelAnimationFrame(raf)
      ro?.disconnect()
    }
  }, [scrollContainerRef, dots.length])

  const handleClick = useCallback((origIndex: number) => {
    // Сброс pinned ДО scrollToIndex — иначе rAF-loop автоскролла мгновенно
    // вернёт ленту к низу, и прыжок к выбранному сообщению не виден.
    onJumpRef.current?.()
    virtualizer.scrollToIndex(origIndex, { align: 'center', behavior: 'auto' })
  }, [virtualizer])

  if (!enabled || dots.length < MIN_MESSAGES || !hasOverflow) return null

  // Активная точка — ближайшая сверху к активному origIndex (активным может
  // оказаться псевдо-сообщение без точки — тогда подсвечиваем предыдущую).
  let activeDotIdx = -1
  for (let i = 0; i < dots.length; i++) {
    if (dots[i].origIndex <= activeOrigIndex) activeDotIdx = i
    else break
  }

  const hoverMsg = hover ? messages[hover.origIndex] : null

  return (
    <>
    <div className="chat-minimap" style={{ maxHeight: `${STRIP_MAX_RATIO * 100}%` }}>
      {dots.map((d, i) => (
        <motion.button
          key={d.id}
          type="button"
          className={[
            'chat-minimap-dot',
            `chat-minimap-dot--${d.role}`,
            i === activeDotIdx ? 'chat-minimap-dot--active' : '',
          ].filter(Boolean).join(' ')}
          style={{ width: dotSize, height: dotSize, '--dot-size': `${dotSize}px` } as React.CSSProperties}
          onClick={() => handleClick(d.origIndex)}
          onMouseEnter={e => setHover({ origIndex: d.origIndex, clientY: e.clientY })}
          onMouseLeave={() => setHover(null)}
          aria-label={`Сообщение ${i + 1} из ${dots.length}`}
          whileHover={whileHoverTiny}
          whileTap={whileTapTiny}
          transition={springHover}
        />
      ))}
    </div>

    {/* Превью сообщения при ховере на точку. Рендерим ВНЕ .chat-minimap:
        у контейнера transform + overflow:hidden — fixed-потомок клипился бы.
        position: fixed — не клипается overflow родителя. */}
    {hover && hoverMsg && (
      <div
        key={hover.origIndex}
        className="chat-minimap-preview"
        style={{ top: Math.min(Math.max(hover.clientY - 40, 8), window.innerHeight - 140) }}
      >
        <div className="chat-minimap-preview-head">
          <span className={`chat-minimap-preview-role chat-minimap-preview-role--${hoverMsg.role}`}>
            {roleLabel(hoverMsg.role)}
          </span>
          <span className="chat-minimap-preview-time">{formatTime(hoverMsg.createdAt)}</span>
        </div>
        <div className="chat-minimap-preview-text">
          {snippet(hoverMsg.content) || '[вложение]'}
        </div>
      </div>
    )}
    </>
  )
}

export default memo(ChatMinimap)
