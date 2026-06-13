import { useState, useEffect, useRef } from 'react'
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
  imageUrl?: string
  diff?: string  // unified diff для edit_file / multi_edit_file
}

const TOOL_META: Record<string, { label: string; icon: string; color: string }> = {
  edit_file:       { label: 'Редактировать', icon: 'filePen',   color: '#fb923c' },
  multi_edit_file: { label: 'Мульти-правка', icon: 'filePen',   color: '#fb923c' },
  run_command:     { label: 'Команда',       icon: 'terminal',  color: '#f59e0b' },
  write_file:      { label: 'Запись файла',  icon: 'fileText',  color: '#f87171' },
  read_file:       { label: 'Чтение файла',  icon: 'fileText',  color: '#60a5fa' },
  read_files:      { label: 'Чтение файлов', icon: 'fileText',  color: '#60a5fa' },
  list_directory:  { label: 'Папка',         icon: 'folder',    color: '#a78bfa' },
  search_web:      { label: 'Поиск в сети',  icon: 'globe',     color: '#34d399' },
  search_code:     { label: 'Поиск кода',    icon: 'code',      color: '#818cf8' },
  get_clipboard:   { label: 'Буфер обмена',  icon: 'clipboard', color: '#94a3b8' },
  set_clipboard:   { label: 'Буфер →',       icon: 'clipboard', color: '#94a3b8' },
  get_system_info: { label: 'Система',       icon: 'info',      color: '#38bdf8' },
  generate_image:  { label: 'Генерация',     icon: 'image',     color: '#fb923c' },
  analyze_project: { label: 'Анализ',        icon: 'folder',    color: '#c084fc' },
  spawn_agent:     { label: 'Суб-агент',     icon: 'gitBranch', color: '#4ade80' },
  get_agent_status:{ label: 'Статус агента', icon: 'gitBranch', color: '#4ade80' },
}

function getToolMeta(name?: string) {
  if (!name) return { label: 'Инструмент', icon: 'zap', color: '#94a3b8' }
  return TOOL_META[name] || { label: name, icon: 'zap', color: '#94a3b8' }
}

// Группируем шаги: каждая итерация = один вызов тула + его результат
interface Iteration {
  id: string
  call: ToolStep
  result?: ToolStep
}

function buildIterations(steps: ToolStep[]): Iteration[] {
  const iters: Iteration[] = []
  let i = 0
  while (i < steps.length) {
    const s = steps[i]
    if (s.type === 'tool_call') {
      const next = steps[i + 1]
      if (next?.type === 'tool_result') {
        iters.push({ id: s.id, call: s, result: next })
        i += 2
      } else {
        iters.push({ id: s.id, call: s })
        i++
      }
    } else {
      i++
    }
  }
  return iters
}

function truncate(s: string, n = 80) {
  return s.length > n ? s.slice(0, n) + '…' : s
}

function formatArg(v: unknown): string {
  if (typeof v === 'string') return v
  return JSON.stringify(v, null, 2)
}

// Цветной diff блок
function DiffBlock({ diff }: { diff: string }) {
  const lines = diff.split('\n')
  return (
    <div className="tc2-diff-pre">
      {lines.map((line, i) => {
        let cls = 'tc2-diff-line'
        if (line.startsWith('+') && !line.startsWith('+++')) cls += ' tc2-diff-add'
        else if (line.startsWith('-') && !line.startsWith('---')) cls += ' tc2-diff-del'
        else if (line.startsWith('@@')) cls += ' tc2-diff-hunk'
        else if (line.startsWith('---') || line.startsWith('+++')) cls += ' tc2-diff-meta'
        return <div key={i} className={cls}>{line || ' '}</div>
      })}
    </div>
  )
}

// Один блок итерации
function IterationBlock({
  iter, index, isLast, isRunning, mode, defaultOpen,
}: {
  iter: Iteration
  index: number
  isLast: boolean
  isRunning: boolean
  mode: ToolOutputMode
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const meta = getToolMeta(iter.call.toolName)
  const failed = iter.result?.success === false
  const running = isLast && isRunning && !iter.result

  const prevRunning = useRef(running)
  useEffect(() => {
    if (running && !prevRunning.current) setOpen(true)
    prevRunning.current = running
  }, [running])

  const statusColor = failed ? '#f87171' : running ? meta.color : meta.color

  return (
    <motion.div
      className="tc2-iter"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04, type: 'spring', stiffness: 420, damping: 32 }}
    >
      <div className="tc2-rail">
        <div
          className={`tc2-dot ${running ? 'tc2-dot--pulse' : ''}`}
          style={{ background: statusColor }}
        />
        {!isLast && <div className="tc2-rail-line" />}
      </div>

      <div className="tc2-iter-body">
        <button
          className={`tc2-iter-header ${open ? 'tc2-iter-header--open' : ''}`}
          onClick={() => setOpen(o => !o)}
        >
          <span className="tc2-iter-icon" style={{ color: meta.color }}>
            <AppIcon name={meta.icon as 'zap'} size="sm" />
          </span>
          <span className="tc2-iter-label">{meta.label}</span>
          {iter.call.toolName && (
            <code className="tc2-iter-name">{iter.call.toolName}</code>
          )}

          {iter.call.toolArgs && !open && (
            <span className="tc2-iter-preview">
              {truncate(String(Object.values(iter.call.toolArgs)[0] ?? ''))}
            </span>
          )}

          <span className="tc2-iter-spacer" />

          {running && <span className="tc2-badge tc2-badge--running">выполняется</span>}
          {failed && <span className="tc2-badge tc2-badge--fail">ошибка</span>}
          {iter.result && !failed && <span className="tc2-badge tc2-badge--ok">✓</span>}

          <AppIcon name={open ? 'chevronUp' : 'chevronDown'} size="xs" />
        </button>

        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              className="tc2-iter-details"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
            >
              {iter.call.toolArgs && Object.keys(iter.call.toolArgs).length > 0 && (
                <div className="tc2-section">
                  <div className="tc2-section-title">Аргументы</div>
                  <div className="tc2-code-block">
                    {Object.entries(iter.call.toolArgs).map(([k, v]) => (
                      <div key={k} className="tc2-arg-row">
                        <span className="tc2-arg-key">{k}</span>
                        <pre className="tc2-arg-val">{truncate(formatArg(v), 300)}</pre>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {iter.result && (
                <div className="tc2-section">
                  <div className="tc2-section-title" style={{ color: failed ? '#f87171' : '#4ade80' }}>
                    {failed ? 'Ошибка' : 'Результат'}
                  </div>
                  {iter.result.imageUrl ? (
                    <div className="tc2-image-wrap">
                      <img
                        src={`file://${iter.result.imageUrl}`}
                        alt="Результат"
                        className="tc2-image"
                        onClick={() => window.open(`file://${iter.result!.imageUrl}`, '_blank')}
                      />
                    </div>
                  ) : iter.result.diff ? (
                    <DiffBlock diff={iter.result.diff} />
                  ) : (
                    <pre className="tc2-result-pre">
                      {truncate(iter.result.content, mode === 'detailed' ? 1000 : 300)}
                    </pre>
                  )}
                </div>
              )}

              {running && (
                <div className="tc2-section tc2-section--running">
                  <span className="tc2-spinner" />
                  <span className="tc2-running-text">Выполняется…</span>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}

export default function ToolChain({ steps, mode, isRunning, label, elapsed, summary }: {
  steps: ToolStep[]
  mode: ToolOutputMode
  isRunning: boolean
  label?: string
  elapsed?: number   // ms — время выполнения для финального блока
  summary?: boolean  // если true — компактный финальный блок
}) {
  const iters = buildIterations(steps)
  const [collapsed, setCollapsed] = useState(true)  // свёрнут по дефолту
  const totalDone = iters.filter(i => i.result).length
  const hasFailed = iters.some(i => i.result?.success === false)

  // Считаем elapsed из timestamps если не передан явно
  const allSteps = steps.filter(s => s.timestamp)
  const autoElapsed = allSteps.length >= 2
    ? allSteps[allSteps.length - 1].timestamp - allSteps[0].timestamp
    : undefined
  const elapsedMs = elapsed ?? autoElapsed

  const elapsedStr = elapsedMs != null
    ? elapsedMs >= 60000
      ? `${Math.floor(elapsedMs / 60000)}м ${Math.round((elapsedMs % 60000) / 1000)}с`
      : elapsedMs >= 1000
        ? `${(elapsedMs / 1000).toFixed(1)}с`
        : `${elapsedMs}мс`
    : null

  if (iters.length === 0 && !isRunning) return null

  if (mode === 'compact') {
    return (
      <div className="tc2 tc2--compact">
        <div className="tc2-compact-row">
          {isRunning && <span className="tc2-spinner" />}
          {iters.map(({ id, call }, i) => {
            const meta = getToolMeta(call.toolName)
            return (
              <span key={id} className="tc2-compact-chip" style={{ '--chip-color': meta.color } as React.CSSProperties}>
                <AppIcon name={meta.icon as 'zap'} size="xs" />
                {i < iters.length - 1 && <span className="tc2-compact-arrow">›</span>}
              </span>
            )
          })}
          {isRunning && <span className="tc2-compact-dots">···</span>}
        </div>
      </div>
    )
  }

  return (
    <div className={`tc2${summary ? ' tc2--summary' : ''}`}>
      <div className="tc2-header">
        <button className="tc2-collapse-btn" onClick={() => setCollapsed(c => !c)}>
          <AppIcon name={collapsed ? 'chevronRight' : 'chevronDown'} size="xs" />
        </button>

        <div className="tc2-header-summary">
          {label
            ? <span className="tc2-header-title tc2-header-title--label">{label}</span>
            : isRunning
              ? <><span className="tc2-spinner" /><span className="tc2-header-title">Агент работает</span></>
              : <span className="tc2-header-title">
                  {hasFailed ? '⚠ ' : ''}
                  {`${totalDone} ${totalDone === 1 ? 'действие' : totalDone < 5 ? 'действия' : 'действий'}`}
                </span>
          }
          {elapsedStr && !isRunning && (
            <span className="tc2-elapsed">{elapsedStr}</span>
          )}
        </div>

        <div className="tc2-header-chips">
          {iters.map(({ id, call }) => {
            const meta = getToolMeta(call.toolName)
            return (
              <span
                key={id}
                className="tc2-mini-chip"
                style={{ background: meta.color + '22', color: meta.color }}
                title={call.toolName}
              >
                <AppIcon name={meta.icon as 'zap'} size="xs" />
              </span>
            )
          })}
          {isRunning && <span className="tc2-mini-chip tc2-mini-chip--pulse">···</span>}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            className="tc2-iters"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
          >
            {iters.map((iter, idx) => (
              <IterationBlock
                key={iter.id}
                iter={iter}
                index={idx}
                isLast={idx === iters.length - 1}
                isRunning={!!isRunning}
                mode={mode}
                defaultOpen={!!isRunning && idx === iters.length - 1}
              />
            ))}

            {/* Пульс — ждём следующего тула */}
            {isRunning && iters.length > 0 && iters[iters.length - 1].result && (
              <motion.div className="tc2-iter" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <div className="tc2-rail">
                  <div className="tc2-dot tc2-dot--thinking" />
                </div>
                <div className="tc2-iter-body">
                  <div className="tc2-thinking-row">
                    <span className="tc2-spinner" />
                    <span className="tc2-thinking-label">Думаю…</span>
                  </div>
                </div>
              </motion.div>
            )}

            {/* Старт — нет тулов ещё */}
            {isRunning && iters.length === 0 && (
              <div className="tc2-iter">
                <div className="tc2-rail">
                  <div className="tc2-dot tc2-dot--thinking" />
                </div>
                <div className="tc2-iter-body">
                  <div className="tc2-thinking-row">
                    <span className="tc2-spinner" />
                    <span className="tc2-thinking-label">Анализирую задачу…</span>
                  </div>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
