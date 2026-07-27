/**
 * Нижний dock-терминал — горизонтальная панель как в VS Code integrated terminal.
 * Табы сессий текущего чата, shell-picker для создания новой, resize только
 * по вертикали (тянем верхнюю границу вверх/вниз). Открывается/закрывается
 * кнопкой в TitleBar или крестиком здесь — единственный сигнал видимости
 * терминала это dockOpen (см. terminal.store.ts).
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import IconButton from '../IconButton/IconButton'
import TerminalView from '../TerminalView/TerminalView'
import { disposeTerminal } from '../../../utils/terminalRegistry'
import { useTerminalStore, DOCK_HEIGHT_MIN, DOCK_HEIGHT_DEFAULT, type TerminalSessionMeta } from '../../../store/terminal.store'
import { useChatStore } from '../../../store/chat.store'
import './BottomDock.css'

interface ShellInfo {
  type: string
  label: string
  available: boolean
}

interface PickerPos { x: number; y: number }

function shellIconLabel(shell: string): string {
  switch (shell) {
    case 'powershell': return 'PS'
    case 'cmd': return 'CMD'
    case 'bash': return 'SH'
    case 'wsl': return 'WSL'
    default: return shell.slice(0, 3).toUpperCase()
  }
}

export default function BottomDock() {
  const dockOpen = useTerminalStore(s => s.dockOpen)
  const dockHeight = useTerminalStore(s => s.dockHeight)
  const activeSessionId = useTerminalStore(s => s.activeSessionId)
  const currentChatId = useChatStore(s => s.currentChatId)
  // Узкий селектор: только сессии текущего чата. Раньше sessionsByChat
  // целиком → ре-рендер при session change в ЛЮБОМ чате.
  const sessions = (useTerminalStore(s => currentChatId ? s.sessionsByChat[currentChatId] : undefined) ?? [])
  const aiBusySessionIds = useTerminalStore(s => s.aiBusySessionIds)
  const { createSession, closeSession, switchSession, setDockOpen, setDockHeight, setActiveChat } = useTerminalStore.getState()

  const [shells, setShells] = useState<ShellInfo[]>([])
  const [pickerPos, setPickerPos] = useState<PickerPos | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const newBtnRef = useRef<HTMLButtonElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const startYRef = useRef(0)
  const startHeightRef = useRef(DOCK_HEIGHT_DEFAULT)

  const visibleSessions = sessions.filter(s => !s.dead)

  useEffect(() => {
    window.syntee.pty.detectShells().then((list: ShellInfo[]) => setShells(list))
  }, [])

  useEffect(() => {
    setActiveChat(currentChatId ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChatId])

  // Закрытие shell-picker по клику вне
  useEffect(() => {
    if (!pickerPos) return
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (newBtnRef.current?.contains(t)) return
      if (pickerRef.current && !pickerRef.current.contains(t)) setPickerPos(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [pickerPos])

  const handleCreate = useCallback((shell: string) => {
    if (!currentChatId) return
    setPickerPos(null)
    createSession(currentChatId, shell)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChatId])

  const handleClose = useCallback((sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    closeSession(sessionId)
    disposeTerminal(sessionId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Resize по вертикали (только up/down) ──
  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    startYRef.current = e.clientY
    startHeightRef.current = dockHeight
    document.body.classList.add('dock-resize-active')
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return
      const delta = startYRef.current - e.clientY
      const next = Math.min(Math.max(startHeightRef.current + delta, DOCK_HEIGHT_MIN), Math.floor(window.innerHeight * 0.75))
      if (dockRef.current) dockRef.current.style.height = `${next}px`
    }
    const onUp = () => {
      if (!draggingRef.current) return
      draggingRef.current = false
      document.body.classList.remove('dock-resize-active')
      const h = dockRef.current?.getBoundingClientRect().height
      if (h) setDockHeight(h)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [setDockHeight])

  if (!dockOpen) return null

  return (
    <>
      <AnimatePresence>
        {dockOpen && (
          <motion.div
            ref={dockRef}
            className="bottom-dock"
            style={{ height: dockHeight }}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: dockHeight, opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 40 }}
          >
            <div className="bottom-dock__resize-bar" onMouseDown={handleDragStart} />

            <div className="bottom-dock__header">
              <div className="bottom-dock__tabs">
                {visibleSessions.map((s: TerminalSessionMeta) => (
                  <button
                    key={s.id}
                    className={`bottom-dock__tab ${s.id === activeSessionId ? 'bottom-dock__tab--active' : ''} ${aiBusySessionIds.has(s.id) ? 'bottom-dock__tab--ai-busy' : ''}`}
                    onClick={() => switchSession(s.id)}
                  >
                    {s.source === 'agent' && <AppIcon name="bot" size="xs" tone="accent" />}
                    <span className="bottom-dock__tab-shell">{shellIconLabel(s.shell)}</span>
                    <span className="bottom-dock__tab-title">{s.title}</span>
                    {aiBusySessionIds.has(s.id) && <span className="bottom-dock__tab-busy-dot" />}
                    <span className="bottom-dock__tab-close" onClick={(e) => handleClose(s.id, e)}>
                      <AppIcon name="x" size="xs" />
                    </span>
                  </button>
                ))}

                <div className="bottom-dock__new-wrap">
                  <button
                    ref={newBtnRef}
                    className="bottom-dock__new-btn"
                    onClick={(e) => {
                      if (pickerPos) { setPickerPos(null); return }
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      setPickerPos({ x: r.left, y: r.bottom + 4 })
                    }}
                    title="Новая сессия"
                  >
                    <AppIcon name="plus" size="xs" />
                  </button>
                </div>
              </div>

              <div className="bottom-dock__actions">
                <IconButton icon="chevronDown" label="Свернуть" onClick={() => setDockOpen(false)} />
              </div>
            </div>

            <div className="bottom-dock__body">
              {visibleSessions.length === 0 && (
                <div className="bottom-dock__empty">
                  Нет активных сессий. Нажмите «+», чтобы создать.
                </div>
              )}
              {visibleSessions.map(s => (
                <div key={s.id} style={{ display: s.id === activeSessionId ? 'block' : 'none', width: '100%', height: '100%' }}>
                  <TerminalView sessionId={s.id} autoFocus={s.id === activeSessionId} />
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {createPortal(
        <AnimatePresence>
          {pickerPos && (
            <motion.div
              ref={pickerRef}
              className="bottom-dock__shell-picker"
              style={{ position: 'fixed', left: pickerPos.x, top: pickerPos.y, zIndex: 9999 }}
              initial={{ opacity: 0, scale: 0.95, y: -6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -4 }}
              transition={{ type: 'spring', stiffness: 500, damping: 32 }}
            >
              {shells.length === 0 && <div className="bottom-dock__shell-empty">Shells не найдены</div>}
              {shells.map(sh => (
                <button key={sh.type + sh.label} className="bottom-dock__shell-item" onClick={() => handleCreate(sh.type)}>
                  <AppIcon name="terminal" size="xs" />
                  <span>{sh.label}</span>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  )
}
