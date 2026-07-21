import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon, { type IconName } from '../AppIcon/AppIcon'
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
  steps: AgentStep[]
  result: string
  summary: string
  createdAt: number
  finishedAt?: number
  error?: string
}

interface AgentPanelProps {
  focusAgentId?: string | null
  currentChatId?: string | null
}

const TOOL_ICONS: Record<string, IconName> = {
  run_command: 'terminal', read_file: 'fileText', write_file: 'edit',
  list_directory: 'folder', search_web: 'globe',
  get_system_info: 'monitor', generate_image: 'image',
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

export default function AgentPanel({ focusAgentId, currentChatId }: AgentPanelProps) {
  const [agents, setAgents] = useState<AgentRecord[]>([])
  const [selected, setSelected] = useState<string | null>(focusAgentId ?? null)
  const [filterChat, setFilterChat] = useState<string | null>(currentChatId ?? null)

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

  // Если focusAgentId передан — выбираем его
  useEffect(() => {
    if (focusAgentId) setSelected(focusAgentId)
  }, [focusAgentId])

  // Синхронизируем filterChat с текущим чатом
  useEffect(() => {
    if (currentChatId) setFilterChat(currentChatId)
  }, [currentChatId])

  const selectedAgent = agents.find(a => a.id === selected) ?? null

  // Уникальные chatId из всех агентов
  const chatIds = Array.from(new Set(agents.map(a => a.chatId)))

  // Отфильтрованные агенты
  const filteredAgents = filterChat ? agents.filter(a => a.chatId === filterChat) : agents

  // Сортировка: активные сверху, потом по времени
  const sorted = [...filteredAgents].sort((a, b) => {
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
    <div className="agent-panel agent-panel--tab-content">
      {/* Фильтр по чатам */}
      {chatIds.length > 1 && (
        <div className="agent-panel__chat-filter">
          <button
            className={`agent-panel__chat-pill ${filterChat === null ? 'active' : ''}`}
            onClick={() => setFilterChat(null)}
          >
            Все
          </button>
          {chatIds.map(cid => {
            const count = agents.filter(a => a.chatId === cid).length
            const running = agents.filter(a => a.chatId === cid && a.status === 'running').length
            return (
              <button
                key={cid}
                className={`agent-panel__chat-pill ${filterChat === cid ? 'active' : ''}`}
                onClick={() => setFilterChat(cid)}
              >
                <span>Чат {cid.slice(-4)}</span>
                {running > 0
                  ? <span className="agent-panel__chat-pill-dot agent-panel__chat-pill-dot--running" />
                  : <span className="agent-panel__chat-pill-count">{count}</span>
                }
              </button>
            )
          })}
        </div>
      )}

      <div className="agent-panel__content">
        {/* Левая колонка — список */}
        <div className="agent-panel__list">
          {agents.length === 0 ? (
            <div className="agent-panel__empty">
              <AppIcon name="git-branch" size="lg" tone="muted" />
              <p>Нет агентов</p>
              <p className="agent-panel__empty-hint">Агенты ещё не запускались</p>
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
  const shortTask = (agent.task ?? '').length > 60 ? agent.task.slice(0, 60) + '…' : (agent.task ?? '')
  const currentTool = (agent.steps ?? []).filter(s => s.type === 'tool_call').slice(-1)[0]?.toolName

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
