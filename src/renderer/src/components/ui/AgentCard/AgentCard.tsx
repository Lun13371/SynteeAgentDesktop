import { useState, useEffect, useRef, memo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon, { type IconName } from '../AppIcon/AppIcon'
import { getSubagentRole } from '../../../../../shared/subagent-roles'
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
  role?: string
  steps?: Array<{ type: string; toolName?: string; toolArgs?: Record<string, unknown>; content: string; success?: boolean; timestamp: number }>
}

interface AgentCardProps {
  agent: AgentCardData
  onClick?: () => void
  /** Live-режим — принудительно развёрнут, крутит shimmer. */
  live?: boolean
}

const STATUS_META: Record<AgentStatus, { label: string; icon: IconName; tone: string }> = {
  pending:   { label: 'Ожидает',  icon: 'clock',   tone: 'muted' },
  running:   { label: 'Работает', icon: 'loader',  tone: 'accent' },
  done:      { label: 'Готово',   icon: 'check',   tone: 'success' },
  error:     { label: 'Ошибка',   icon: 'x',       tone: 'danger' },
  cancelled: { label: 'Отменён',  icon: 'archive', tone: 'muted' },
}

const TOOL_ICONS: Record<string, IconName> = {
  run_command: 'terminal', read_file: 'fileText', write_file: 'edit',
  list_directory: 'folder', search_web: 'globe',
  get_system_info: 'monitor', generate_image: 'image',
  read_files: 'fileText', search_code: 'search', analyze_project: 'folder',
  spawn_agent: 'git-branch',
  list_extensions: 'puzzle', get_skill: 'puzzle', think: 'brain', update_todo: 'listChecks',
  update_working_memory: 'database', get_fast_context: 'compass',
}

function getToolIcon(toolName?: string): IconName {
  if (!toolName) return 'zap'
  if (toolName.startsWith('mcp__')) return 'server'
  return TOOL_ICONS[toolName] ?? 'zap'
}

function shortTask(task: string, max = 56): string {
  if (task.length <= max) return task
  return task.slice(0, max) + '…'
}

function elapsedMs(createdAt: number, finishedAt?: number): string {
  const ms = (finishedAt ?? Date.now()) - createdAt
  if (ms < 1000) return `${ms}мс`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}с`
  return `${(ms / 60000).toFixed(1)}м`
}

const AgentCard = memo(function AgentCard({ agent, onClick, live }: AgentCardProps) {
  const meta = STATUS_META[agent.status]
  const isLive = agent.status === 'running' || agent.status === 'pending'
  const [expanded, setExpanded] = useState(false)
  const [showSummary, setShowSummary] = useState(false)

  // При live — авто-раскрытие. При переходе live→done — авто-сворачивание
  // через 1.5с (как FastContextBlock wasLiveRef).
  const wasLiveRef = useRef(false)
  useEffect(() => {
    if (isLive) {
      wasLiveRef.current = true
      setExpanded(true)
    } else if (wasLiveRef.current && !isLive) {
      const t = setTimeout(() => setExpanded(false), 1500)
      return () => clearTimeout(t)
    }
  }, [isLive])

  // Последние 4 тул-вызова (для chips в развёрнутом теле).
  const recentTools = (agent.steps ?? [])
    .filter(s => s.type === 'tool_call' && s.toolName)
    .slice(-4)
  const currentTool = recentTools[recentTools.length - 1]?.toolName

  return (
    <div
      className={`agent-c agent-c--${agent.status}${isLive ? ' agent-c--live' : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter') onClick?.() }}
    >
      {/* Левая полоска статуса */}
      <div className={`agent-c__stripe agent-c__stripe--${agent.status}`} />

      <div className="agent-c__main">
        {/* Компактная строка-заголовок */}
        <div className="agent-c__row" onClick={(e) => { e.stopPropagation(); setExpanded(v => !v) }}>
          <div className="agent-c__status-icon">
            <AppIcon
              name={meta.icon}
              size="xs"
              tone={meta.tone as never}
              animation={agent.status === 'running' ? 'spin' : 'none'}
            />
          </div>
          <span className="agent-c__task" title={agent.task}>{shortTask(agent.task)}</span>
          {currentTool && isLive && (
            <span className="agent-c__current-tool" title={currentTool}>
              <AppIcon name={getToolIcon(currentTool)} size="xs" tone="muted" />
              {currentTool}
            </span>
          )}
          {agent.role && (
            <span
              className="agent-c__role-badge"
              style={{ color: getSubagentRole(agent.role).color }}
            >
              {getSubagentRole(agent.role).nameEn}
            </span>
          )}
          <span className={`agent-c__badge agent-c__badge--${agent.status}`}>{meta.label}</span>
          {!isLive && agent.summary && (
            <AppIcon name="chevronDown" size="xs" tone="muted" className={expanded ? 'agent-c__chevron' : 'agent-c__chevron agent-c__chevron--closed'} />
          )}
        </div>

        {/* Развёрнутое тело — детали по клику */}
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              className="agent-c__body"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
            >
              {/* Live tool chips — компактная строка текущих действий */}
              {isLive && recentTools.length > 0 && (
                <div className="agent-c__chips">
                  {recentTools.map((t, i) => (
                    <span key={`${t.toolName}-${t.timestamp}`} className="agent-c__chip">
                      <AppIcon name={getToolIcon(t.toolName)} size="xs" />
                      {t.toolName}
                    </span>
                  ))}
                </div>
              )}

              {/* Shimmer во время работы */}
              {isLive && agent.status === 'running' && (
                <div className="agent-c__shimmer">
                  <div className="agent-c__shimmer-line" />
                  <div className="agent-c__shimmer-line agent-c__shimmer-line--short" />
                </div>
              )}

              {/* Error */}
              {agent.status === 'error' && agent.error && (
                <div className="agent-c__error">{agent.error}</div>
              )}

              {/* Summary — раскрываемый */}
              {agent.status === 'done' && agent.summary && (
                <div className="agent-c__summary-wrap">
                  <button
                    className="agent-c__summary-toggle"
                    onClick={(e) => { e.stopPropagation(); setShowSummary(s => !s) }}
                  >
                    <AppIcon
                      name="chevronDown"
                      size="xs"
                      tone="muted"
                      className={showSummary ? 'agent-c__chevron' : 'agent-c__chevron agent-c__chevron--closed'}
                    />
                    <span>Итог</span>
                  </button>
                  <AnimatePresence initial={false}>
                    {showSummary && (
                      <motion.p
                        className="agent-c__summary"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                      >
                        {agent.summary}
                      </motion.p>
                    )}
                  </AnimatePresence>
                </div>
              )}

              {/* Cancelled empty */}
              {agent.status === 'cancelled' && !agent.summary && (
                <div className="agent-c__empty">Агент отменён до завершения.</div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Футер-мета — компактный, всегда виден */}
        <div className="agent-c__meta" onClick={(e) => e.stopPropagation()}>
          <span className="agent-c__meta-model">{agent.model}</span>
          <span className="agent-c__meta-dot">·</span>
          <span className="agent-c__meta-steps">{agent.stepsCount} шаг{agent.stepsCount === 1 ? '' : 'ов'}</span>
          <span className="agent-c__meta-dot">·</span>
          <span className="agent-c__meta-time">{elapsedMs(agent.createdAt, agent.finishedAt)}</span>
          <span className="agent-c__meta-hint">↗ детали</span>
        </div>
      </div>
    </div>
  )
})

export default AgentCard
