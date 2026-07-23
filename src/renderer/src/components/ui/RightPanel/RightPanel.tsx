import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, useMotionValue, animate } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import IconButton from '../IconButton/IconButton'
import ResizeHandle from '../ResizeHandle/ResizeHandle'
import AgentPanel from '../AgentPanel/AgentPanel'
import FileExplorer from '../FileExplorer/FileExplorer'
import GitPanel from '../GitPanel/GitPanel'
import SessionChangesPanel from '../SessionChangesPanel/SessionChangesPanel'
import SideChatPanel from '../SideChatPanel/SideChatPanel'
import TerminalPanel from '../TerminalPanel/TerminalPanel'
import { useUIStore } from '../../../store/ui.store'
import './RightPanel.css'

export type RightPanelTab = 'agents' | 'files' | 'git' | 'session' | 'sidechat' | 'terminal'

interface RightPanelProps {
  onClose: () => void
  focusAgentId?: string | null
  currentChatId?: string | null
}

const TABS: Array<{ id: RightPanelTab; label: string; icon: 'git-branch' | 'folder' | 'git' | 'history' | 'messageSquare' | 'terminal' }> = [
  { id: 'sidechat', label: 'Чат', icon: 'messageSquare' },
  { id: 'agents', label: 'Агенты', icon: 'git-branch' },
  { id: 'files', label: 'Файлы', icon: 'folder' },
  { id: 'git', label: 'Git', icon: 'git' },
  { id: 'session', label: 'Сессия', icon: 'history' },
  { id: 'terminal', label: 'Терминал', icon: 'terminal' },
]

export default function RightPanel({ onClose, focusAgentId, currentChatId }: RightPanelProps) {
  const [tab, setTab] = useState<RightPanelTab>('sidechat')
  const [workdir, setWorkdir] = useState<string | null>(null)
  const [contentReady, setContentReady] = useState(false)
  const [closing, setClosing] = useState(false)
  const setAgentPanelWidth = useUIStore(s => s.setAgentPanelWidth)

  // ── useMotionValue: ширина и прозрачность обходят React полностью ────
  // Во время dragging widthMV.set() пишет напрямую в DOM — 0 ре-рендеров.
  const widthMV = useMotionValue(0)
  const opacityMV = useMotionValue(0)
  const closeControlsRef = useRef<ReturnType<typeof animate> | null>(null)

  // Открытие: 0 → panelWidth+6 (spring). После — contentReady=true.
  useEffect(() => {
    const w = useUIStore.getState().agentPanelWidth + 6
    const ctrlW = animate(widthMV, w, { type: 'spring', stiffness: 380, damping: 32 })
    const ctrlO = animate(opacityMV, 1, { duration: 0.15 })
    const timer = setTimeout(() => setContentReady(true), 250)
    return () => { ctrlW.stop(); ctrlO.stop(); clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!currentChatId) return
    let cancelled = false
    window.syntee.fs.getWorkdir(currentChatId).then((wd: string | null) => {
      if (!cancelled) setWorkdir(wd)
    })
    return () => { cancelled = true }
  }, [currentChatId])

  // During drag: пишем в motion value напрямую. React НЕ ре-рендерится.
  const handleResize = useCallback((w: number) => {
    const max = Math.min(Math.floor(window.innerWidth * 0.7), 1600)
    const clamped = Math.min(Math.max(Math.round(w), 280), max)
    widthMV.set(clamped + 6)
  }, [widthMV])

  // Drag end: обновляем store один раз + persist.
  const handleResizeEnd = useCallback(() => {
    const w = widthMV.get() - 6
    setAgentPanelWidth(w)
    window.syntee.settings.set('agentPanelWidth', w)
  }, [widthMV, setAgentPanelWidth])

  // Закрытие: анимируем width→0 и opacity→0, ПОТОМ зовём onClose().
  // Без AnimatePresence — нет конфликта exit props с useMotionValue,
  // нет перекрытия старой/новой панели при быстром reopen.
  const handleClose = useCallback(() => {
    if (closing) return
    setClosing(true)
    setContentReady(false)
    closeControlsRef.current?.stop()
    closeControlsRef.current = animate(widthMV, 0, {
      type: 'spring', stiffness: 380, damping: 32,
      onComplete: () => onClose(),
    })
    animate(opacityMV, 0, { duration: 0.15 })
  }, [closing, widthMV, opacityMV, onClose])

  useEffect(() => () => { closeControlsRef.current?.stop() }, [])

  return (
    <motion.div
      className="right-panel-wrapper"
      style={{ width: widthMV, opacity: opacityMV }}
    >
      <div className="right-panel-inner">
        <ResizeHandle side="right" onResize={handleResize} onResizeEnd={handleResizeEnd} />
        <div className="right-panel">
          <div className="right-panel__header">
            <div className="right-panel__tabs">
              {TABS.map(t => (
                <button
                  key={t.id}
                  className={`right-panel__tab ${tab === t.id ? 'right-panel__tab--active' : ''}`}
                  onClick={() => setTab(t.id)}
                  title={t.label}
                >
                  <AppIcon name={t.icon} size="xs" />
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
            <IconButton icon="x" label="Закрыть панель" size="sm" onClick={handleClose} />
          </div>

          <div className="right-panel__content">
            {contentReady && (
              <motion.div
                key={tab}
                className="right-panel__tab-content"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.15 }}
              >
                {tab === 'agents' && (
                  <AgentPanel focusAgentId={focusAgentId} currentChatId={currentChatId} />
                )}
                {tab === 'sidechat' && (
                  <SideChatPanel currentChatId={currentChatId} />
                )}
                {tab === 'files' && (
                  <FileExplorer key={workdir ?? 'no-workdir'} workdir={workdir} />
                )}
                {tab === 'git' && (
                  <GitPanel key={workdir ?? 'no-workdir'} workdir={workdir} />
                )}
                {tab === 'session' && (
                  <SessionChangesPanel key={currentChatId ?? 'no-chat'} chatId={currentChatId} />
                )}
                {tab === 'terminal' && (
                  <TerminalPanel currentChatId={currentChatId} />
                )}
              </motion.div>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  )
}
