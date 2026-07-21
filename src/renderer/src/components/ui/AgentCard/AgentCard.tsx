import { motion } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import './AgentCard.css'

export type AgentStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

export interface AgentCardData {
  id: string
  task: string
  status: AgentStatus
  model: string
  stepsCount: number
  currentStep?: string
  summary?: string
  error?: string
  createdAt: number
  finishedAt?: number
}

interface AgentCardProps {
  agent: AgentCardData
  onClick?: () => void
}

const STATUS_META: Record<AgentStatus, { label: string; icon: 'loader' | 'check' | 'x' | 'clock' | 'archive'; tone: string }> = {
  pending:   { label: 'Ожидает',    icon: 'clock',   tone: 'muted' },
  running:   { label: 'Работает',   icon: 'loader',  tone: 'accent' },
  done:      { label: 'Готово',     icon: 'check',   tone: 'success' },
  error:     { label: 'Ошибка',     icon: 'x',       tone: 'danger' },
  cancelled: { label: 'Отменён',    icon: 'archive', tone: 'muted' },
}

export default function AgentCard({ agent, onClick }: AgentCardProps) {
  const meta = STATUS_META[agent.status]
  const elapsed = agent.finishedAt
    ? ((agent.finishedAt - agent.createdAt) / 1000).toFixed(1) + 's'
    : ((Date.now() - agent.createdAt) / 1000).toFixed(0) + 's'

  const shortTask = agent.task.length > 80 ? agent.task.slice(0, 80) + '…' : agent.task

  return (
    <motion.div
      className={`agent-card agent-card--${agent.status}`}
      initial={{ opacity: 0, y: 8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onClick?.()}
    >
      {/* Левая полоска статуса */}
      <div className={`agent-card__stripe agent-card__stripe--${agent.status}`} />

      <div className="agent-card__body">
        {/* Заголовок */}
        <div className="agent-card__header">
          <div className="agent-card__icon-wrap">
            <AppIcon name="git-branch" size="sm" />
          </div>
          <div className="agent-card__title-wrap">
            <span className="agent-card__title">{shortTask}</span>
          </div>
          <div className={`agent-card__status agent-card__status--${agent.status}`}>
            <AppIcon
              name={meta.icon}
              size="xs"
              animation={agent.status === 'running' ? 'spin' : 'none'}
            />
            <span>{meta.label}</span>
          </div>
        </div>

        {/* Текущий шаг или итог */}
        {agent.status === 'running' && agent.currentStep && (
          <div className="agent-card__step">
            <span className="agent-card__step-dot" />
            <span className="agent-card__step-text">{agent.currentStep}</span>
          </div>
        )}
        {agent.status === 'done' && agent.summary && (
          <div className="agent-card__summary">{
            agent.summary.length > 120 ? agent.summary.slice(0, 120) + '…' : agent.summary
          }</div>
        )}
        {agent.status === 'error' && agent.error && (
          <div className="agent-card__error">{agent.error}</div>
        )}

        {/* Футер */}
        <div className="agent-card__footer">
          <span className="agent-card__model">{agent.model}</span>
          <span className="agent-card__dot">·</span>
          <span className="agent-card__steps">{agent.stepsCount} шаг{agent.stepsCount === 1 ? '' : 'ов'}</span>
          <span className="agent-card__dot">·</span>
          <span className="agent-card__time">{elapsed}</span>
          <span className="agent-card__hint">нажми для деталей →</span>
        </div>
      </div>
    </motion.div>
  )
}
