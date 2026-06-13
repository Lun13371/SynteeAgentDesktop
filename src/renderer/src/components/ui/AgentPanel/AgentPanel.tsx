import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon, { type IconName } from '../AppIcon/AppIcon'
import IconButton from '../IconButton/IconButton'
import ToolChain from '../ToolChain/ToolChain'
import './AgentPanel.css'

interface AgentStep {
  id: string
  type: 'tool_call' | 'tool_result'
  toolName?: string
  toolArgs?: Record<string, unknown>
  content: string
  success?: boolean
  timestamp: number
  imageUrl?: string
}

interface AgentRecord {
  id: string
  parentId: string | null
  chatId: string
  task: string
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled'
  model: string
  parallel: boolean
  steps: AgentStep[]
  result: string
  summary: string
  createdAt: number
  finishedAt?: number
  error?: string
}

interface AgentPanelProps {
  onClose: () => void
  focusAgentId?: string | null
}

const TOOL_ICONS: Record<string, IconName> = {
  run_command: 'terminal', read_file: 'fileText', write_file: 'edit',
  list_directory: 'folder', search_web: 'globe', get_clipboard: 'clipboard',
  set_clipboard: 'clipboard', get_system_info: 'monitor', generate_image: 'image',
  read_files: 'fileText', search_code: 'search', analyze_project: 'folder',
  spawn_agent: 'git-branch',
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Ожидает', running: 'Работает', done: 'Готово',
  error: 'Ошибка', cancelled: 'Отменён',
}

function elapsed(a: AgentRecord) {
  const ms = (a.finishedAt ?? Date.now()) - a.createdAt
  return ms < 60000 ? (ms / 1000).toFixed(1) + 's' : (ms / 60000).toFixed(1) + 'm'
}

export default function AgentPanel({ onClose, focusAgentId }: AgentPanelProps) {
  const [agents, setAgents] = useState<AgentRecord[]>([])
  const [selected, setSelected] = useState<string | null>(focusAgentId ?? null)

  // Загружаем список и подписываемся на обновления
  useEffect(() => {
    window.syntee.agent.list().then(setAgents)

    const off = window.syntee.on('agent:update', (updated: AgentRecord) => {
      setAgents(prev => {
        const idx = prev.findIndex(a => a.id === updated.id)
        if (idx === -1) return [...prev, updated]
        const next = [...prev]
        next[idx] = updated
        return next
      })
    })
    return () => off()
  }, [])

  // Если передали focusAgentId — выбираем его
  useEffect(() => {
    if (focusAgentId) setSelected(focusAgentId)
  }, [focusAgentId])

  const selectedAgent = agents.find(a => a.id === selected) ?? null

  // Сортировка: активные сверху, потом по времени
  const sorted = [...agents].sort((a, b) => {
    const rank = (s: string) => s === 'running' ? 0 : s === 'pending' ? 1 : 2
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status)
    return b.createdAt - a.createdAt
  })

  // Дерево: корневые (parentId = null) и дочерние
  const roots = sorted.filter(a => a.parentId === null || !agents.find(p => p.id === a.parentId))
  const children = (parentId: string) => sorted.filter(a => a.parentId === parentId)

  const handleCancel = async (id: string) => {
    await window.syntee.agent.cancel(id)
  }

  return (
    <div className="agent-panel">
      {/* Хедер */}
      <div className="agent-panel__header">
        <div className="agent-panel__title">
          <AppIcon name="git-branch" size="sm" />
          <span>Агенты</span>
          {agents.filter(a => a.status === 'running').length > 0 && (
            <span className="agent-panel__running-badge">
              {agents.filter(a => a.status === 'running').length}
            </span>
          )}
        </div>
        <IconButton icon="x" size="sm" onClick={onClose} />
      </div>

      <div className="agent-panel__content">
        {/* Левая колонка — список */}
        <div className="agent-panel__list">
          {agents.length === 0 ? (
            <div className="agent-panel__empty">
              <AppIcon name="git-branch" size="lg" tone="muted" />
              <p>Нет активных агентов</p>
              <p className="agent-panel__empty-hint">Агенты появятся когда AI запустит подзадачу через spawn_agent</p>
            </div>
          ) : (
            roots.map(agent => (
              <div key={agent.id}>
                <AgentListItem
                  agent={agent}
                  selected={selected === agent.id}
                  onSelect={() => setSelected(agent.id)}
                  onCancel={handleCancel}
                />
                {/* Дочерние агенты */}
                {children(agent.id).map(child => (
                  <div key={child.id} className="agent-panel__child">
                    <div className="agent-panel__child-line" />
                    <AgentListItem
                      agent={child}
                      selected={selected === child.id}
                      onSelect={() => setSelected(child.id)}
                      onCancel={handleCancel}
                    />
                  </div>
                ))}
              </div>
            ))
          )}
        </div>

        {/* Правая колонка — детали */}
        <AnimatePresence mode="wait">
          {selectedAgent && (
            <motion.div
              key={selectedAgent.id}
              className="agent-panel__detail"
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 16 }}
              transition={{ duration: 0.18 }}
            >
              <div className="agent-detail__task">{selectedAgent.task}</div>

              <div className="agent-detail__meta">
                <span className={`agent-detail__status agent-detail__status--${selectedAgent.status}`}>
                  <AppIcon
                    name={selectedAgent.status === 'running' ? 'loader' : selectedAgent.status === 'done' ? 'check' : selectedAgent.status === 'error' ? 'x' : 'clock'}
                    size="xs"
                    animation={selectedAgent.status === 'running' ? 'spin' : 'none'}
                  />
                  {STATUS_LABEL[selectedAgent.status]}
                </span>
                <span className="agent-detail__model">{selectedAgent.model}</span>
                <span className="agent-detail__elapsed">{elapsed(selectedAgent)}</span>
                {selectedAgent.parallel && <span className="agent-detail__badge">параллельно</span>}
              </div>

              {/* Шаги */}
              {selectedAgent.steps.length > 0 && (
                <div className="agent-detail__steps">
                  <ToolChain
                    steps={selectedAgent.steps}
                    mode="detailed"
                    isRunning={selectedAgent.status === 'running'}
                  />
                </div>
              )}

              {/* Итог */}
              {selectedAgent.result && (
                <div className="agent-detail__result">
                  <div className="agent-detail__result-label">Итог</div>
                  <div className="agent-detail__result-text">{selectedAgent.result}</div>
                </div>
              )}

              {/* Ошибка */}
              {selectedAgent.error && (
                <div className="agent-detail__error">{selectedAgent.error}</div>
              )}

              {/* Отмена */}
              {selectedAgent.status === 'running' && (
                <button
                  className="agent-detail__cancel"
                  onClick={() => handleCancel(selectedAgent.id)}
                >
                  <AppIcon name="x" size="xs" />
                  Остановить агента
                </button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

// ── Элемент списка ────────────────────────────────────────────────────────
function AgentListItem({ agent, selected, onSelect, onCancel }: {
  agent: AgentRecord
  selected: boolean
  onSelect: () => void
  onCancel: (id: string) => void
}) {
  const shortTask = agent.task.length > 60 ? agent.task.slice(0, 60) + '…' : agent.task
  const currentTool = agent.steps.filter(s => s.type === 'tool_call').slice(-1)[0]?.toolName

  return (
    <motion.div
      className={`agent-list-item ${selected ? 'agent-list-item--selected' : ''} agent-list-item--${agent.status}`}
      onClick={onSelect}
      whileHover={{ x: 2 }}
      transition={{ duration: 0.1 }}
    >
      <div className={`agent-list-item__stripe agent-list-item__stripe--${agent.status}`} />
      <div className="agent-list-item__body">
        <div className="agent-list-item__top">
          <AppIcon
            name={agent.status === 'running' ? 'loader' : 'git-branch'}
            size="xs"
            animation={agent.status === 'running' ? 'spin' : 'none'}
            tone={agent.status === 'done' ? 'success' : agent.status === 'error' ? 'danger' : 'default'}
          />
          <span className="agent-list-item__task">{shortTask}</span>
          {agent.status === 'running' && (
            <button
              className="agent-list-item__cancel"
              onClick={e => { e.stopPropagation(); onCancel(agent.id) }}
              title="Остановить"
            >
              <AppIcon name="x" size="xs" />
            </button>
          )}
        </div>
        {agent.status === 'running' && currentTool && (
          <div className="agent-list-item__tool">
            <AppIcon name={TOOL_ICONS[currentTool] ?? 'zap'} size="xs" />
            <span>{currentTool}</span>
          </div>
        )}
      </div>
    </motion.div>
  )
}
