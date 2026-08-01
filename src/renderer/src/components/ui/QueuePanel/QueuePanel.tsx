import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence, Reorder } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import { useChatStore } from '../../../store/chat.store'
import { removePendingUserMsg } from '../../../hooks/useChatRunSubscription'
import type { QueueItemMeta } from '../../../../../shared/types'
import './QueuePanel.css'

interface QueueBadgeProps {
  chatId: string
}

const DROP_W = 340
const HOVER_OPEN_DELAY = 120
const HOVER_CLOSE_DELAY = 220

// Стабильная пустая ссылка: `?? []` прямо в селекторе создавал НОВЫЙ массив
// на каждый вызов → zustand видел «изменение» → QueuePanel ре-рендерился на
// каждое обновление store, включая 50мс-флеши стриминга (20×/сек).
const EMPTY_QUEUE: QueueItemMeta[] = []

/**
 * Бейдж очереди запросов чата + раскрывающаяся панель управления.
 *
 * Показывается в строке статуса над инпутом (рядом с workdir-бейджем),
 * когда в текущем чате есть активный или ожидающий запрос. Скрыт когда
 * очередь пуста.
 *
 * Взаимодействие:
 *  - Hover на бейдже → плавное раскрытие панели вверх (с задержкой 120мс).
 *  - Клик по бейджу → фиксация панели открытой (чтобы кликать Cancel/Remove
 *    без риска закрытия при случайном сдвиге курсора).
 *  - Клик снаружи / ESC → закрытие зафиксированной панели.
 *  - Drag-handle слева от каждого queued-элемента → перестановка очереди.
 *
 * Панель открывается вверх (инпут внизу окна), использует glass-эстетику
 * (backdrop-filter blur) и spring-анимации framer-motion.
 */
export default function QueuePanel({ chatId }: QueueBadgeProps) {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [dropPos, setDropPos] = useState<{ bottom: number; left: number; width: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)

  const queue = useChatStore(s => s.queueByChat[chatId] ?? EMPTY_QUEUE)
  const activeRun = useChatStore(s => s.activeRunByChat[chatId] ?? null)

  // Бейдж показывается ТОЛЬКО когда есть ожидающие (queued) запросы.
  // Один активный запрос без очереди — бейджа нет (остановка через Stop-кнопку).
  // Running-секция внутри панели дополняет Queued-список для управления.
  const hasItems = queue.length > 0
  const total = queue.length + (activeRun ? 1 : 0)

  const computeDropPos = useCallback(() => {
    if (!btnRef.current) return null
    const r = btnRef.current.getBoundingClientRect()
    const left = Math.max(8, Math.min(r.left, window.innerWidth - DROP_W - 8))
    return { bottom: window.innerHeight - r.top + 6, left, width: DROP_W }
  }, [])

  const clearTimers = useCallback(() => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null }
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
  }, [])

  const close = useCallback(() => {
    clearTimers()
    setOpen(false)
    setPinned(false)
  }, [clearTimers])

  // Hover-открытие с задержкой
  const handleMouseEnter = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
    if (open || pinned) return
    if (openTimer.current) clearTimeout(openTimer.current)
    openTimer.current = window.setTimeout(() => {
      const pos = computeDropPos()
      if (pos) {
        setDropPos(pos)
        setOpen(true)
      }
    }, HOVER_OPEN_DELAY)
  }, [open, pinned, computeDropPos])

  // Hover-закрытие с задержкой (не закрываем если зафиксировано)
  const handleMouseLeave = useCallback(() => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null }
    if (pinned) return
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY)
  }, [pinned])

  // Клик по бейджу — toggle фиксации
  const handleClick = useCallback(() => {
    if (pinned) {
      close()
    } else {
      clearTimers()
      const pos = computeDropPos()
      if (pos) setDropPos(pos)
      setOpen(true)
      setPinned(true)
    }
  }, [pinned, close, clearTimers, computeDropPos])

  // Закрытие по клику снаружи и ESC (только в зафиксированном режиме)
  useEffect(() => {
    if (!open || !pinned) return
    const onDown = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return
      if (dropRef.current?.contains(e.target as Node)) return
      close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDown)
      document.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, pinned, close])

  // Действия
  const cancelActive = useCallback(() => {
    window.syntee.chat.stop(chatId)
  }, [chatId])

  const removeQueued = useCallback((item: QueueItemMeta) => {
    // Убираем из очереди в main и заодно чистим отложенное user-сообщение,
    // иначе оно зависнет навсегда (запрос не стартует → 'running' не придётся).
    window.syntee.chat.queueRemove(chatId, item.queueId)
    removePendingUserMsg(item.msgId)
  }, [chatId])

  const reorderQueue = useCallback((newQueue: QueueItemMeta[]) => {
    // Оптимистичное обновление для мгновенного отклика UI; main подтвердит.
    useChatStore.getState().setQueue(chatId, newQueue)
    window.syntee.chat.queueReorder(chatId, newQueue.map(m => m.queueId))
  }, [chatId])

  // Очистка таймеров при размонтировании
  useEffect(() => {
    return () => {
      if (openTimer.current) clearTimeout(openTimer.current)
      if (closeTimer.current) clearTimeout(closeTimer.current)
    }
  }, [])

  if (!hasItems) return null

  return (
    <div className="queue-badge-wrap">
      <motion.button
        ref={btnRef}
        className={`queue-badge-pill${activeRun ? ' queue-badge-pill--running' : ''}`}
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        whileTap={{ scale: 0.96 }}
        whileHover={{ scale: 1.04 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        title={`${queue.length} в очереди${activeRun ? ' (1 выполняется)' : ''}`}
      >
        <AppIcon
          name={activeRun ? 'loader' : 'clock'}
          size="xs"
          animation={activeRun ? 'spin' : 'none'}
          tone={activeRun ? 'accent' : 'muted'}
        />
        <span className="queue-badge-count">{queue.length}</span>
        <span className="queue-badge-label">в очереди</span>
      </motion.button>

      {createPortal(
        <AnimatePresence>
          {open && dropPos && (
            <motion.div
              ref={dropRef}
              className="queue-dropdown"
              style={{
                position: 'fixed',
                left: dropPos.left,
                bottom: dropPos.bottom,
                width: dropPos.width,
                zIndex: 9999,
              }}
              initial={{ opacity: 0, y: 8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
            >
              <div className="queue-dropdown-header">
                <AppIcon name="listChecks" size="xs" tone="muted" />
                <span className="queue-dropdown-title">Очередь запросов</span>
                <span className="queue-dropdown-count">{total}</span>
              </div>

              {/* Running секция */}
              <AnimatePresence>
                {activeRun && (
                  <motion.div
                    className="queue-running-card"
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4, scale: 0.97 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 32 }}
                    layout
                  >
                    <div className="queue-running-icon">
                      <AppIcon name="loader" size="sm" animation="spin" tone="accent" />
                    </div>
                    <div className="queue-running-body">
                      <div className="queue-running-status">Выполняется</div>
                      <div className="queue-running-preview">{activeRun.preview || 'Запрос…'}</div>
                    </div>
                    <button
                      className="queue-item-btn queue-item-btn--cancel"
                      onClick={cancelActive}
                      title="Остановить выполнение"
                    >
                      <AppIcon name="x" size="xs" />
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Queued секция с drag-reorder */}
              {queue.length > 0 && (
                <div className="queue-list-wrap">
                  <div className="queue-list-label">
                    Ожидают ({queue.length})
                  </div>
                  <Reorder.Group
                    axis="y"
                    values={queue}
                    onReorder={reorderQueue}
                    className="queue-list"
                  >
                    {queue.map((item, idx) => (
                      <Reorder.Item
                        key={item.queueId}
                        value={item}
                        className="queue-item"
                        whileDrag={{ scale: 1.02, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}
                        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                      >
                        <div className="queue-item-handle" title="Перетащите для перестановки">
                          <AppIcon name="gripVertical" size="xs" tone="muted" />
                        </div>
                        <span className="queue-item-index">{idx + 1}</span>
                        <span className="queue-item-preview">{item.preview || 'Запрос…'}</span>
                        <button
                          className="queue-item-btn queue-item-btn--remove"
                          onClick={() => removeQueued(item)}
                          title="Убрать из очереди"
                        >
                          <AppIcon name="x" size="xs" />
                        </button>
                      </Reorder.Item>
                    ))}
                  </Reorder.Group>
                </div>
              )}

              {queue.length === 0 && !activeRun && (
                <div className="queue-empty">Очередь пуста</div>
              )}

              <div className="queue-dropdown-hint">
                Перетащите за <AppIcon name="gripVertical" size="xs" tone="muted" /> для перестановки
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  )
}
