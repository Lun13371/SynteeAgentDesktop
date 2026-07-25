import { useState, useEffect, useRef, memo, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import PlanCard from '../PlanCard/PlanCard'
import ToolResultRenderer from './ToolResultRenderer'
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
  callId?: string  // id tool_call из API — для матчинга call↔result при параллельных тулах
  /** Имя MCP-сервера для MCP-тулов (mcp__server__tool). */
  serverName?: string
  // true — модель только начала вызывать этот тул, аргументы ещё не собраны
  // (см. tool_call_pending в Agent.ts). Карточка показывает "готовится" без
  // аргументов, заменяется на обычный tool_call in-place когда придёт полный.
  pending?: boolean
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
  get_system_info: { label: 'Система',       icon: 'info',      color: '#38bdf8' },
  generate_image:  { label: 'Генерация',     icon: 'image',     color: '#fb923c' },
  analyze_project: { label: 'Анализ',        icon: 'folder',    color: '#c084fc' },
  get_fast_context:{ label: 'Быстрый контекст', icon: 'compass', color: '#06b6d4' },
  spawn_agent:     { label: 'Суб-агент',     icon: 'gitBranch', color: '#4ade80' },
  get_agent_status:{ label: 'Статус агента', icon: 'gitBranch', color: '#4ade80' },
  get_diagnostics: { label: 'Диагностика',   icon: 'info',      color: '#38bdf8' },
  list_extensions: { label: 'Расширения',    icon: 'puzzle',    color: '#a78bfa' },
  get_skill:       { label: 'Скилл',         icon: 'puzzle',    color: '#a78bfa' },
  think:           { label: 'Размышление',   icon: 'brain',     color: '#94a3b8' },
  update_todo:     { label: 'План',          icon: 'listChecks', color: '#60a5fa' },
  update_working_memory: { label: 'Память',  icon: 'database',  color: '#34d399' },
  revert_last_change: { label: 'Откат',      icon: 'rewind',    color: '#f87171' },
}

/** Парсит mcp__server__tool → { server, tool }. Server может содержать подчёркивания. */
function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
  if (!toolName.startsWith('mcp__')) return null
  const rest = toolName.slice(5)
  const lastSep = rest.lastIndexOf('__')
  if (lastSep === -1) return null
  return { server: rest.slice(0, lastSep), tool: rest.slice(lastSep + 2) }
}

function getToolMeta(name?: string, serverName?: string): { label: string; icon: string; color: string; isMcp?: boolean; server?: string } {
  if (!name) return { label: 'Инструмент', icon: 'zap', color: '#94a3b8' }
  // MCP-тулы — отдельная ветка с иконкой server и фиолетовым цветом.
  const mcpParsed = parseMcpToolName(name)
  if (mcpParsed) {
    return {
      label: mcpParsed.tool,
      icon: 'server',
      color: '#a78bfa',
      isMcp: true,
      server: serverName ?? mcpParsed.server,
    }
  }
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
  const calls = steps.filter(s => s.type === 'tool_call')
  const results = steps.filter(s => s.type === 'tool_result')

  for (const call of calls) {
    // Матчим по callId если есть, иначе по toolName (первый незаматченный result с тем же toolName)
    let result: ToolStep | undefined
    if (call.callId) {
      result = results.find(r => r.callId === call.callId)
    }
    if (!result) {
      // Fallback: первый незаматченный result с тем же toolName
      result = results.find(r => r.toolName === call.toolName && !(r as ToolStep & { _matched?: boolean })._matched)
    }
    if (!result) {
      // Последний fallback: первый незаматченный result
      result = results.find(r => !(r as ToolStep & { _matched?: boolean })._matched)
    }
    if (result) {
      (result as ToolStep & { _matched?: boolean })._matched = true
    }
    iters.push({ id: call.id, call, result })
  }

  // Чистим временный флаг
  results.forEach(r => { delete (r as ToolStep & { _matched?: boolean })._matched })

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
  const lines = diff.split('\n').filter((_, i, arr) => {
    // Убираем пустую последнюю строку
    return !(i === arr.length - 1 && arr[i] === '')
  })
  return (
    <div className="tc2-diff-pre">
      {lines.map((line, i) => {
        let cls = 'tc2-diff-line'
        if (line.startsWith('+++') || line.startsWith('---')) cls += ' tc2-diff-meta'
        else if (line.startsWith('+')) cls += ' tc2-diff-add'
        else if (line.startsWith('-')) cls += ' tc2-diff-del'
        else if (line.startsWith('@@')) cls += ' tc2-diff-hunk'
        else cls += ' tc2-diff-ctx'
        return <div key={i} className={cls}>{line || '\u00a0'}</div>
      })}
    </div>
  )
}

// Один блок итерации
const IterationBlock = memo(function IterationBlock({
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
  const meta = getToolMeta(iter.call.toolName, iter.call.serverName)
  const failed = iter.result?.success === false
  // pending — модель ещё генерирует аргументы этого вызова (см. Agent.ts
  // tool_call_pending). Отличаем от "running" (тул реально исполняется в
  // Node), чтобы показать корректный текст, но визуально это тот же
  // "идёт работа, не зависло" индикатор.
  const pending = !!iter.call.pending
  // Раньше проверяли isLast — но при параллельных тулах (Promise.all в Agent.ts)
  // одновременно создаётся несколько итераций без результата, и спиннер/бейдж
  // показывался только у последней. Теперь "выполняется" — у любого тула без
  // результата, пока идёт живой стрим, независимо от позиции.
  const running = isRunning && !iter.result && !pending

  const prevRunning = useRef(running)
  useEffect(() => {
    if ((running || pending) && !prevRunning.current) setOpen(true)
    prevRunning.current = running || pending
  }, [running, pending])

  const statusColor = failed ? '#f87171' : (running || pending) ? meta.color : meta.color

  return (
    <motion.div
      className="tc2-iter"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04, type: 'spring', stiffness: 420, damping: 32 }}
    >
      <div className="tc2-rail">
        <div
          className={`tc2-dot ${(running || pending) ? 'tc2-dot--pulse' : ''}`}
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
          {meta.isMcp && meta.server && (
            <span className="tc2-iter-server">{meta.server}</span>
          )}
          {iter.call.toolName && !meta.isMcp && (
            <code className="tc2-iter-name">{iter.call.toolName}</code>
          )}

          {iter.call.toolArgs && !open && (
            <span className="tc2-iter-preview">
              {truncate(String(Object.values(iter.call.toolArgs)[0] ?? ''))}
            </span>
          )}

          <span className="tc2-iter-spacer" />

          {meta.isMcp && <span className="tc2-badge tc2-badge--mcp">MCP</span>}
          {pending && <span className="tc2-badge tc2-badge--running">готовится</span>}
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
              {iter.call.toolArgs && Object.keys(iter.call.toolArgs).length > 0 && mode === 'detailed' && (
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

              {iter.result && mode !== 'compact' && (() => {
                // save_plan — специальная плашка
                if (iter.call.toolName === 'save_plan' && iter.result.success) {
                  return (
                    <div className="tc2-section">
                      <div className="tc2-section-title" style={{ color: '#4ade80' }}>Результат</div>
                      <div className="tc2-plan-saved">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                          <polyline points="14 2 14 8 20 8"/>
                        </svg>
                        {iter.result.content}
                      </div>
                    </div>
                  )
                }
                // image — картинка
                if (iter.result.imageUrl) {
                  return (
                    <div className="tc2-section">
                      <div className="tc2-section-title" style={{ color: '#4ade80' }}>Результат</div>
                      <div className="tc2-image-wrap">
                        <img
                          src={`file://${iter.result.imageUrl}`}
                          alt="Результат"
                          className="tc2-image"
                          onClick={() => window.open(`file://${iter.result!.imageUrl}`, '_blank')}
                        />
                      </div>
                    </div>
                  )
                }
                // diff — DiffBlock
                if (iter.result.diff) {
                  return (
                    <div className="tc2-section">
                      <div className="tc2-section-title" style={{ color: '#4ade80' }}>Результат</div>
                      <DiffBlock diff={iter.result.diff} />
                    </div>
                  )
                }
                // умный рендер через ToolResultRenderer
                return (
                  <ToolResultRenderer
                    call={iter.call}
                    result={iter.result}
                    mode={mode}
                  />
                )
              })()}

              {pending && (
                <div className="tc2-section tc2-section--running">
                  <span className="tc2-spinner" />
                  <span className="tc2-running-text">Готовится вызов…</span>
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
}, (prev, next) => prev.iter === next.iter && prev.isLast === next.isLast &&
  prev.isRunning === next.isRunning && prev.mode === next.mode && prev.defaultOpen === next.defaultOpen)

const ToolChain = memo(function ToolChain({ steps, mode, isRunning, label, elapsed, summary }: {
  steps: ToolStep[]
  mode: ToolOutputMode
  isRunning: boolean
  label?: string
  elapsed?: number   // ms — время выполнения для финального блока
  summary?: boolean  // если true — компактный финальный блок
}) {
  const iters = useMemo(() => buildIterations(steps), [steps])
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
            const meta = getToolMeta(call.toolName, call.serverName)
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
            const meta = getToolMeta(call.toolName, call.serverName)
            return (
              <span
                key={id}
                className="tc2-mini-chip"
                style={{ background: meta.color + '22', color: meta.color }}
                title={meta.isMcp && meta.server ? `${meta.server} · ${meta.label}` : call.toolName}
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
}, (prev, next) => prev.steps === next.steps && prev.mode === next.mode &&
  prev.isRunning === next.isRunning && prev.label === next.label &&
  prev.elapsed === next.elapsed && prev.summary === next.summary)

export default ToolChain
