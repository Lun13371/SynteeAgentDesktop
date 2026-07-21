import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import IconButton from '../IconButton/IconButton'
import ResizeHandle from '../ResizeHandle/ResizeHandle'
import AgentPanel from '../AgentPanel/AgentPanel'
import FileExplorer from '../FileExplorer/FileExplorer'
import GitPanel from '../GitPanel/GitPanel'
import { useUIStore } from '../../../store/ui.store'
import './RightPanel.css'

export type RightPanelTab = 'agents' | 'files' | 'git'

interface RightPanelProps {
  onClose: () => void
  focusAgentId?: string | null
  currentChatId?: string | null
}

const TABS: Array<{ id: RightPanelTab; label: string; icon: 'git-branch' | 'folder' | 'git' }> = [
  { id: 'agents', label: 'Агенты', icon: 'git-branch' },
  { id: 'files', label: 'Файлы', icon: 'folder' },
  { id: 'git', label: 'Git', icon: 'git' },
]

export default function RightPanel({ onClose, focusAgentId, currentChatId }: RightPanelProps) {
  const [tab, setTab] = useState<RightPanelTab>('agents')
  const [workdir, setWorkdir] = useState<string | null>(null)
  const panelWidth = useUIStore(s => s.agentPanelWidth)
  const setAgentPanelWidth = useUIStore(s => s.setAgentPanelWidth)

  useEffect(() => {
    if (!currentChatId) return
    let cancelled = false
    window.syntee.fs.getWorkdir(currentChatId).then((wd: string | null) => {
      if (!cancelled) setWorkdir(wd)
    })
    return () => { cancelled = true }
  }, [currentChatId])

  return (
    <motion.div
      className="right-panel-wrapper"
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: panelWidth + 6, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
    >
      <div className="right-panel-inner" style={{ width: panelWidth + 6 }}>
        <ResizeHandle side="right" onResize={(w) => setAgentPanelWidth(w)} />
        <div className="right-panel" style={{ width: panelWidth }}>
          {/* Хедер с табами */}
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
            <IconButton icon="x" label="Закрыть панель" size="sm" onClick={onClose} />
          </div>

          {/* Контент */}
          <div className="right-panel__content">
            <AnimatePresence mode="wait">
              <motion.div
                key={tab}
                className="right-panel__tab-content"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
              >
                {tab === 'agents' && (
                  <AgentPanel focusAgentId={focusAgentId} currentChatId={currentChatId} />
                )}
                {tab === 'files' && (
                  <FileExplorer key={workdir ?? 'no-workdir'} workdir={workdir} />
                )}
                {tab === 'git' && (
                  <GitPanel key={workdir ?? 'no-workdir'} workdir={workdir} />
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </motion.div>
  )
}
