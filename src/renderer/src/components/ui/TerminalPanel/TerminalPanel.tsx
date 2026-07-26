/**
 * Компактная версия терминала для таба правой панели. Показывает список
 * сессий текущего чата + активную сессию (TerminalView).
 *
 * dockOpen — единственный сигнал местоположения терминала (см. terminal.store.ts):
 * если нижний dock открыт, сессия рендерится там (и здесь показываем только
 * подсказку с кнопкой "Показать здесь"), иначе рендерим TerminalView прямо
 * тут и даём кнопку "Развернуть вниз".
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import IconButton from '../IconButton/IconButton'
import TerminalView from '../TerminalView/TerminalView'
import { disposeTerminal } from '../../../utils/terminalRegistry'
import { useTerminalStore, type TerminalSessionMeta } from '../../../store/terminal.store'
import './TerminalPanel.css'

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

interface TerminalPanelProps {
  currentChatId?: string | null
}

export default function TerminalPanel({ currentChatId }: TerminalPanelProps) {
  const dockOpen = useTerminalStore(s => s.dockOpen)
  const activeSessionId = useTerminalStore(s => s.activeSessionId)
  const sessionsByChat = useTerminalStore(s => s.sessionsByChat)
  const aiBusySessionIds = useTerminalStore(s => s.aiBusySessionIds)
  const { createSession, closeSession, switchSession, setDockOpen, setActiveChat } = useTerminalStore.getState()

  const [shells, setShells] = useState<ShellInfo[]>([])
  const [pickerPos, setPickerPos] = useState<PickerPos | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const newBtnRef = useRef<HTMLButtonElement>(null)

  const sessions = (currentChatId ? sessionsByChat[currentChatId] : undefined) ?? []
  const visibleSessions = sessions.filter(s => !s.dead)

  useEffect(() => {
    window.syntee.pty.detectShells().then((list: ShellInfo[]) => setShells(list))
  }, [])

  useEffect(() => {
    setActiveChat(currentChatId ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChatId])

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

  const handleCreate = (shell: string) => {
    if (!currentChatId) return
    setPickerPos(null)
    createSession(currentChatId, shell)
  }

  const handleClose = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    closeSession(sessionId)
    disposeTerminal(sessionId)
  }

  if (!currentChatId) {
    return <div className="terminal-panel terminal-panel--empty">Откройте чат, чтобы использовать терминал</div>
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-panel__header">
        <div className="terminal-panel__tabs">
          {visibleSessions.map((s: TerminalSessionMeta) => (
            <button
              key={s.id}
              className={`terminal-panel__tab ${s.id === activeSessionId ? 'terminal-panel__tab--active' : ''} ${aiBusySessionIds.has(s.id) ? 'terminal-panel__tab--ai-busy' : ''}`}
              onClick={() => switchSession(s.id)}
            >
              {s.source === 'agent' && <AppIcon name="bot" size="xs" tone="accent" />}
              <span className="terminal-panel__tab-shell">{shellIconLabel(s.shell)}</span>
              <span className="terminal-panel__tab-title">{s.title}</span>
              {aiBusySessionIds.has(s.id) && <span className="terminal-panel__tab-busy-dot" />}
              <span className="terminal-panel__tab-close" onClick={(e) => handleClose(s.id, e)}>
                <AppIcon name="x" size="xs" />
              </span>
            </button>
          ))}
          <div className="terminal-panel__new-wrap">
            <button
              ref={newBtnRef}
              className="terminal-panel__new-btn"
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
        {activeSessionId && (
          <IconButton
            icon={dockOpen ? 'chevronUp' : 'chevronDown'}
            label={dockOpen ? 'Показать здесь' : 'Развернуть вниз'}
            size="sm"
            onClick={() => setDockOpen(!dockOpen)}
          />
        )}
      </div>
      <div className="terminal-panel__body">
        {visibleSessions.length === 0 && (
          <div className="terminal-panel__empty">Нет активных сессий. Нажмите «+», чтобы создать.</div>
        )}
        {!dockOpen && visibleSessions.map(s => (
          <div key={s.id} style={{ display: s.id === activeSessionId ? 'block' : 'none', width: '100%', height: '100%' }}>
            <TerminalView sessionId={s.id} autoFocus={s.id === activeSessionId} />
          </div>
        ))}
        {dockOpen && activeSessionId && (
          <div className="terminal-panel__moved-hint">
            Сессия открыта в нижнем терминале.
            <button className="terminal-panel__moved-link" onClick={() => setDockOpen(false)}>Показать здесь</button>
          </div>
        )}
      </div>

      {createPortal(
        <AnimatePresence>
          {pickerPos && (
            <motion.div
              ref={pickerRef}
              className="terminal-panel__shell-picker"
              style={{ position: 'fixed', left: pickerPos.x, top: pickerPos.y, zIndex: 9999 }}
              initial={{ opacity: 0, scale: 0.95, y: -6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -4 }}
              transition={{ type: 'spring', stiffness: 500, damping: 32 }}
            >
              {shells.length === 0 && <div className="terminal-panel__shell-empty">Shells не найдены</div>}
              {shells.map(sh => (
                <button key={sh.type + sh.label} className="terminal-panel__shell-item" onClick={() => handleCreate(sh.type)}>
                  <AppIcon name="terminal" size="xs" />
                  <span>{sh.label}</span>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  )
}
