import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import type { ToolOutputMode } from '../../../../../shared/types'
import './ToolChain.css'

export interface ToolStep {
  id: string
  type: 'tool_call' | 'tool_result'
  toolName?: string
  toolArgs?: Record<string, unknown>
  content: string
  success?: boolean
  timestamp: number
}

interface ToolChainProps {
  steps: ToolStep[]
  mode: ToolOutputMode
  isRunning?: boolean
}

const TOOL_META: Record<string, { label: string; icon: string; color: string }> = {
  run_command:    { label: 'Команда',        icon: 'terminal',  color: '#f59e0b' },
  write_file:     { label: 'Запись файла',   icon: 'fileText',  color: '#f87171' },
  read_file:      { label: 'Чтение файла',   icon: 'fileText',  color: '#60a5fa' },
  list_directory: { label: 'Папка',          icon: 'folder',    color: '#a78bfa' },
  search_web:     { label: 'Поиск',          icon: 'globe',     color: '#34d399' },
  get_clipboard:  { label: 'Буфер',          icon: 'clipboard', color: '#94a3b8' },
  set_clipboard:  { label: 'Буфер →',        icon: 'clipboard', color: '#94a3b8' },
  get_system_info:{ label: 'Система',        icon: 'info',      color: '#38bdf8' },
}

function getToolMeta(name?: string) {
  if (!name) return { label: 'Инструмент', icon: 'zap', color: '#94a3b8' }
  return TOOL_META[name] || { label: name, icon: 'zap', color: '#94a3b8' }
}

// Пары call+result
function pairSteps(steps: ToolStep[]) {
  const pairs: Array<{ call: ToolStep; result?: ToolStep }> = []
  let i = 0
  while (i < steps.length) {
    const s = steps[i]
    if (s.type === 'tool_call') {
      const next = steps[i + 1]
      if (next?.type === 'tool_result' && next.toolName === s.toolName) {
        pairs.push({ call: s, result: next })
        i += 2
      } else {
        pairs.push({ call: s })
        i++
      }
    } else { i++ }
  }
  return pairs
}

export default function ToolChain({ steps, mode, isRunning }: ToolChainProps) {
  const [expanded, setExpanded] = useState(false)
  const [openPairs, setOpenPairs] = useState<Set<string>>(new Set())

  const pairs = pairSteps(steps)
  if (pairs.length === 0 && !isRunning) return null

  const togglePair = (id: string) => {
    setOpenPairs(prev => {
      const s = new Set(prev)
      s.has(id) ? s.delete(id) : s.add(id)
      return s
    })
  }

  // compact — одна строка с иконками всех тулов
  if (mode === 'compact') {
    return (
      <div className="tool-chain tool-chain--compact">
        <div className="tc-compact-row">
          {isRunning && <span className="tc-spinner" />}
          {pairs.map(({ call }, i) => {
            const meta = getToolMeta(call.toolName)
            return (
              <span key={call.id} className="tc-compact-chip" style={{ '--chip-color': meta.color } as React.CSSProperties}>
                <AppIcon name={meta.icon as 'zap'} size="xs" />
                {i < pairs.length - 1 && <span className="tc-compact-arrow">›</span>}
              </span>
            )
          })}
          {isRunning && <span className="tc-compact-dots">···</span>}
        </div>
      </div>
    )
  }

  return (
    <div className="tool-chain">
      {/* Заголовок цепочки */}
      <motion.button
        className={`tc-header ${expanded ? 'tc-header--open' : ''}`}
        onClick={() => setExpanded(e => !e)}
        whileTap={{ scale: 0.98 }}
      >
        <div className="tc-header-left">
          {isRunning
            ? <span className="tc-spinner" />
            : <AppIcon name={expanded ? 'chevronDown' : 'chevronUp'} size="xs" />
          }
          <span className="tc-header-label">
            {isRunning ? 'Выполняю...' : `${pairs.length} ${pairs.length === 1 ? 'действие' : pairs.length < 5 ? 'действия' : 'действий'}`}
          </span>
        </div>
        {/* Мини-иконки всех тулов */}
        <div className="tc-header-chips">
          {pairs.map(({ call }) => {
            const meta = getToolMeta(call.toolName)
            return (
              <span
                key={call.id}
                className="tc-mini-chip"
                style={{ background: meta.color + '22', color: meta.color }}
              >
                <AppIcon name={meta.icon as 'zap'} size="xs" />
              </span>
            )
          })}
          {isRunning && <span className="tc-mini-chip tc-mini-chip--pulse">···</span>}
        </div>
      </motion.button>

      {/* Цепочка шагов */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            className="tc-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
          >
            <div className="tc-steps">
              {pairs.map(({ call, result }, idx) => {
                const meta = getToolMeta(call.toolName)
                const isOpen = openPairs.has(call.id)
                const failed = result?.success === false

                return (
                  <motion.div
                    key={call.id}
                    className={`tc-step ${failed ? 'tc-step--failed' : result ? 'tc-step--done' : 'tc-step--running'}`}
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: idx * 0.05, type: 'spring', stiffness: 400, damping: 28 }}
                  >
                    {/* Линия слева */}
                    <div className="tc-line">
                      <div className="tc-dot" style={{ background: failed ? '#f87171' : result ? meta.color : '#555' }}>
                        {!result && !failed && <span className="tc-dot-pulse" style={{ background: meta.color }} />}
                      </div>
                      {idx < pairs.length - 1 && <div className="tc-connector" />}
                    </div>

                    {/* Контент */}
                    <div className="tc-step-content">
                      <button className="tc-step-header" onClick={() => mode === 'detailed' && togglePair(call.id)}>
                        <span className="tc-step-icon" style={{ color: meta.color }}>
                          <AppIcon name={meta.icon as 'zap'} size="sm" />
                        </span>
                        <span className="tc-step-label">{meta.label}</span>
                        {call.toolName && <code className="tc-step-name">{call.toolName}</code>}
                        {failed && <span className="tc-step-badge tc-step-badge--fail">ошибка</span>}
                        {result && !failed && <span className="tc-step-badge tc-step-badge--ok">✓</span>}
                        {mode === 'detailed' && result && (
                          <AppIcon name={isOpen ? 'chevronUp' : 'chevronDown'} size="xs" />
                        )}
                      </button>

                      {/* Normal: показываем первый аргумент */}
                      {mode === 'normal' && call.toolArgs && (
                        <div className="tc-step-preview">
                          {Object.entries(call.toolArgs).slice(0, 1).map(([k, v]) => (
                            <span key={k} className="tc-arg-preview">
                              <span className="tc-arg-key">{k}:</span>
                              <span className="tc-arg-val">
                                {String(v).slice(0, 60)}{String(v).length > 60 ? '…' : ''}
                              </span>
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Detailed: все аргументы + результат раскрываются */}
                      {mode === 'detailed' && (
                        <AnimatePresence initial={false}>
                          {isOpen && (
                            <motion.div
                              className="tc-step-details"
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                            >
                              {call.toolArgs && Object.keys(call.toolArgs).length > 0 && (
                                <div className="tc-detail-block">
                                  <div className="tc-detail-title">Аргументы</div>
                                  {Object.entries(call.toolArgs).map(([k, v]) => (
                                    <div key={k} className="tc-detail-row">
                                      <span className="tc-arg-key">{k}</span>
                                      <pre className="tc-arg-pre">{String(v)}</pre>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {result && (
                                <div className="tc-detail-block">
                                  <div className="tc-detail-title">Результат</div>
                                  <pre className="tc-result-pre">
                                    {result.content.slice(0, 500)}{result.content.length > 500 ? '\n…' : ''}
                                  </pre>
                                </div>
                              )}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      )}
                    </div>
                  </motion.div>
                )
              })}

              {/* Текущий шаг (если выполняется) */}
              {isRunning && (
                <motion.div
                  className="tc-step tc-step--running"
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                >
                  <div className="tc-line">
                    <div className="tc-dot tc-dot--pulse">
                      <span className="tc-dot-pulse" />
                    </div>
                  </div>
                  <div className="tc-step-content">
                    <div className="tc-step-header">
                      <span className="tc-running-label">Думаю…</span>
                    </div>
                  </div>
                </motion.div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
