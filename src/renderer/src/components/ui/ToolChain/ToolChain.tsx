import { useState, useEffect, useRef, memo, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
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
  diff?: string  // unified diff для edit_file
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
  ask_user:        { label: 'Вопрос',        icon: 'helpCircle', color: '#c084fc' },
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

  // Сначала матчим строго по callId — это единственный надёжный ключ при
  // параллельных тулах (Promise.all в Agent.ts создаёт несколько
  // tool_call одновременно с одним toolName). Раньше дальше шёл жадный
  // фолбэк «первый незаматченный result», который мог присвоить чужой
  // результат не тому вызову → реальный вызов оставался без result →
  // спиннер «Выполняется…» крутился бесконечно (running=true пока
  // !iter.result). Теперь фолбэк только по toolName среди resultless
  // вызовов, и orphan-результаты рендерятся как собственные итерации.
  const matchedResultIds = new Set<string>()
  for (const call of calls) {
    let result: ToolStep | undefined
    if (call.callId) {
      result = results.find(r => r.callId === call.callId)
    }
    if (!result) {
      // Fallback: первый незаматченный result с тем же toolName (без
      // чужого callId или с callId, которому уже нашли свою пару).
      result = results.find(r =>
        r.toolName === call.toolName &&
        !matchedResultIds.has(r.id) &&
        (!r.callId || r.callId === call.callId)
      )
    }
    if (result) {
      matchedResultIds.add(result.id)
    }
    iters.push({ id: call.id, call, result })
  }

  // Orphan-результаты (_error, _limit, _loop_guard, _verification) не имеют
  // парного tool_call — раньше дропались или примагничивались к чужой
  // итерации через жадный фолбэк. Теперь рендерим как собственные
  // синтетические итерации, чтобы пользователь видел причину остановки.
  for (const result of results) {
    if (matchedResultIds.has(result.id)) continue
    // Синтетический call с тем же toolName — итерация выглядит как обычный
    // тул, но без аргументов (call.content = toolName).
    const synthCall: ToolStep = {
      id: `${result.id}-synth`,
      type: 'tool_call',
      toolName: result.toolName,
      toolArgs: undefined,
      content: result.toolName ?? 'tool',
      success: undefined,
      timestamp: result.timestamp,
      callId: result.callId,
    }
    iters.push({ id: synthCall.id, call: synthCall, result })
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

// ANSI-стрипинг для renderer (нельзя импортировать из _shared.ts — там Node-зависимости).
// Та же логика что stripAnsi в core/tools/_shared.ts.
function stripAnsiRenderer(text: string): string {
  if (!text) return text
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[^[\]]/g, '')
    .replace(/[\b]/g, '')
}

// ── Live-вывод команды пока она выполняется ──────────────────────────
// Подписывается на pty:data для sessionId, стримит plain-text (ANSI стрипнут,
// маркер __SYNTEE_DONE вырезан) в <pre> с авто-скроллом. rAF-throttle чтобы
// не ре-рендерить на каждый чанк. Buffer capped 50KB (хвост) — иначе длинный
// вывод (npm install) раздул бы DOM.
const LiveCommandOutput = memo(function LiveCommandOutput({ sessionId }: { sessionId: string }) {
  const [output, setOutput] = useState('')
  const bufRef = useRef('')
  const rafRef = useRef<number | null>(null)
  const pendingRef = useRef(false)
  const preRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    bufRef.current = ''
    setOutput('')
    const off = window.syntee.on('pty:data', (sid: unknown, data: unknown) => {
      if (sid !== sessionId) return
      const chunk = typeof data === 'string' ? data : ''
      if (!chunk) return
      // ANSI + маркер-огрызки
      const clean = stripAnsiRenderer(chunk)
        .replace(/__SYNTEE_DONE_[a-f0-9]+:\d+\s*$/m, '')
      bufRef.current += clean
      // Cap 50KB — оставляем хвост (самое свежее)
      if (bufRef.current.length > 50000) {
        bufRef.current = bufRef.current.slice(-50000)
      }
      if (!pendingRef.current) {
        pendingRef.current = true
        rafRef.current = requestAnimationFrame(() => {
          pendingRef.current = false
          setOutput(bufRef.current)
        })
      }
    })
    return () => {
      off()
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [sessionId])

  // Авто-скролл вниз при обновлении
  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [output])

  if (!output) return null
  return (
    <div className="tc2-section tc2-live-terminal">
      <div className="tc2-section-title">Вывод</div>
      <pre ref={preRef} className="tc2-live-terminal-pre">{output}</pre>
    </div>
  )
}, (prev, next) => prev.sessionId === next.sessionId)

// Цветной diff блок. memo + чанкование: большие diff'ы (тысячи строк) раньше
// монтировали div на КАЖДУЮ строку при раскрытии итерации → фриз. Теперь
// первые DIFF_CHUNK строк + кнопка «Показать ещё».
const DIFF_CHUNK = 500
const DiffBlock = memo(function DiffBlock({ diff }: { diff: string }) {
  const [extra, setExtra] = useState(0)
  const visible = DIFF_CHUNK + extra
  const lines = diff.split('\n').filter((_, i, arr) => {
    // Убираем пустую последнюю строку
    return !(i === arr.length - 1 && arr[i] === '')
  })
  const shown = lines.slice(0, visible)
  return (
    <div className="tc2-diff-pre">
      {shown.map((line, i) => {
        let cls = 'tc2-diff-line'
        if (line.startsWith('+++') || line.startsWith('---')) cls += ' tc2-diff-meta'
        else if (line.startsWith('+')) cls += ' tc2-diff-add'
        else if (line.startsWith('-')) cls += ' tc2-diff-del'
        else if (line.startsWith('@@')) cls += ' tc2-diff-hunk'
        else cls += ' tc2-diff-ctx'
        return <div key={i} className={cls}>{line || '\u00a0'}</div>
      })}
      {lines.length > visible && (
        <button className="tc2-show-more" onClick={() => setExtra(e => e + DIFF_CHUNK)}>
          Показать ещё {Math.min(DIFF_CHUNK, lines.length - visible)} из {lines.length} строк
        </button>
      )}
    </div>
  )
}, (prev, next) => prev.diff === next.diff)

// Один блок итерации
const IterationBlock = memo(function IterationBlock({
  iter, index, isLast, isRunning, mode, defaultOpen, liveSessionId, animateEntrance,
}: {
  iter: Iteration
  index: number
  isLast: boolean
  isRunning: boolean
  mode: ToolOutputMode
  defaultOpen: boolean
  liveSessionId?: string
  // Entrance-анимация только для живых цепочек. Для сохранённых (история)
  // анимация бесполезна и вредна: при scroll-remount и при раскрытии
  // 100-итерационной цепочки stagger delay=index*0.04 давал последним
  // итерациям 4+ секунды задержки.
  animateEntrance: boolean
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

  // НЕТ авто-раскрытия при сбое: в больших чатах failed-итерации при скролле
  // монтировали полные тела (подсветка/diff) → фризы. Ошибка видна по бейджу
  // «ошибка» в заголовке — раскрытие по клику. (Во время live-прогона тело
  // и так уже раскрыто эффектом выше, так что ошибку видно сразу.)

  const statusColor = failed ? '#f87171' : (running || pending) ? meta.color : meta.color

  return (
    <motion.div
      className="tc2-iter"
      initial={animateEntrance ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={animateEntrance
        ? { delay: Math.min(index, 10) * 0.04, type: 'spring', stiffness: 420, damping: 32 }
        : { duration: 0 }}
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
                // ask_user — рендер вопросов и ответов пользователя
                if (iter.call.toolName === 'ask_user' && iter.call.toolArgs?.questions) {
                  const questions = iter.call.toolArgs.questions as Array<{
                    id?: string
                    question: string
                    header?: string
                    type?: string
                    options?: Array<{ label: string; value: string }>
                  }>
                  // Парсим ответы из результата (JSON в конце content)
                  let answers: Array<{
                    id: string
                    values?: string[]
                    text?: string
                    value?: boolean
                  }> = []
                  if (iter.result.success && iter.result.content) {
                    const jsonMatch = iter.result.content.match(/JSON:\s*(\[[\s\S]*\])/)
                    if (jsonMatch) {
                      try { answers = JSON.parse(jsonMatch[1]) } catch { /* skip */ }
                    }
                  }
                  const total = questions.length
                  const resolveType = (q: { type?: string; options?: unknown[] }) =>
                    q.type || (q.options && q.options.length > 0 ? 'choice' : 'text')
                  return (
                    <div className="tc2-section">
                      <div className="tc2-section-title" style={{ color: 'var(--accent, #e8e8ec)' }}>
                        {total > 1 ? `${total} вопроса пользователю` : 'Вопрос пользователю'}
                      </div>
                      <div className="tc2-ask-user">
                        {questions.map((q, qi) => {
                          const ans = answers.find(a => a.id === q.id) || answers[qi]
                          const qType = resolveType(q)
                          return (
                            <div key={qi} className="tc2-ask-q">
                              <div className="tc2-ask-q-num">
                                <AppIcon
                                  name={qType === 'yesno' ? 'check' : 'helpCircle'}
                                  size="xs"
                                />
                              </div>
                              <div className="tc2-ask-q-content">
                                {q.header && <div className="tc2-ask-q-label">{q.header}</div>}
                                <div className="tc2-ask-q-text">{q.question}</div>
                                {q.options && q.options.length > 0 && (
                                  <div className="tc2-ask-q-opts">
                                    {q.options.map(o => {
                                      const isSel = ans?.values?.includes(o.value)
                                      return (
                                        <span
                                          key={o.value}
                                          className={`tc2-ask-q-opt${isSel ? ' tc2-ask-q-opt--selected' : ''}`}
                                        >
                                          {isSel && <span className="tc2-ask-q-opt-check">✓</span>}
                                          {o.label}
                                        </span>
                                      )
                                    })}
                                  </div>
                                )}
                                {/* Ответ пользователя — цветовое выделение, collapse если длинный */}
                                {qType === 'yesno' && ans?.value !== undefined && (
                                  <div className={`tc2-ask-q-answer tc2-ask-q-answer--${ans.value ? 'yes' : 'no'}`}>
                                    <AppIcon name={ans.value ? 'check' : 'x'} size="xs" />
                                    {ans.value ? 'Да' : 'Нет'}
                                  </div>
                                )}
                                {ans?.text && (
                                  <div className={`tc2-ask-q-custom${ans.text.length > 200 ? ' tc2-ask-q-custom--collapsible' : ''}`}>
                                    {ans.text}
                                  </div>
                                )}
                              </div>
                            </div>
                          )
                        })}
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
                          loading="lazy"
                          decoding="async"
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
                <>
                  {/* Live-вывод для run_command пока команда выполняется.
                      Подписывается на pty:data по sessionId из toolProgress. */}
                  {iter.call.toolName === 'run_command' && liveSessionId && (
                    <LiveCommandOutput sessionId={liveSessionId} />
                  )}
                  <div className="tc2-section tc2-section--running">
                    <span className="tc2-spinner" />
                    <span className="tc2-running-text">Выполняется…</span>
                  </div>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}, (prev, next) => prev.iter === next.iter && prev.isLast === next.isLast &&
  prev.isRunning === next.isRunning && prev.mode === next.mode && prev.defaultOpen === next.defaultOpen &&
  prev.liveSessionId === next.liveSessionId && prev.animateEntrance === next.animateEntrance)

// Сколько итераций показываем при раскрытии цепочки и шаг догрузки.
const ITERS_PAGE = 15
const ITERS_CHUNK = 10

const ToolChain = memo(function ToolChain({ steps, mode, isRunning, label, elapsed, summary, toolProgress }: {
  steps: ToolStep[]
  mode: ToolOutputMode
  isRunning: boolean
  label?: string
  elapsed?: number   // ms — время выполнения для финального блока
  summary?: boolean  // если true — компактный финальный блок
  toolProgress?: Record<string, { stage: string; detail?: string; sessionId?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }>; ts: number }>
}) {
  const iters = useMemo(() => buildIterations(steps), [steps])
  // sessionId для live-вывода run_command (из tool_progress). Передаётся ТОЛЬКО
  // в IterationBlock — не в store, чтобы pty:data-стрим не триггерил ре-рендер.
  const runCmdSessionId = toolProgress?.['run_command']?.sessionId
  const runCmdActive = toolProgress?.['run_command']?.stage === 'start'
  const [collapsed, setCollapsed] = useState(true)  // свёрнут по дефолту
  // Окно видимых итераций: длинные цепочки (100+ тулов) при раскрытии раньше
  // монтировали ВСЕ IterationBlock разом (со stagger-анимациями и springs) →
  // фриз. Показываем последние ITERS_PAGE, кнопка «предыдущие» расширяет окно
  // к началу. Live-хвост (последние действия) виден всегда.
  const [itersExtra, setItersExtra] = useState(0)
  const totalDone = iters.filter(i => i.result).length
  const hasFailed = iters.some(i => i.result?.success === false)
  const failedCount = iters.filter(i => i.result?.success === false).length

  // НЕТ авто-раскрытия цепочки при сбое: в больших чатах failed-цепочки
  // авто-раскрывались при скролле и монтировали все тела с подсветкой →
  // фризы. Заголовок показывает «⚠ M ошибок из N» — раскрытие по клику.

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

  // Видимое окно итераций (хвост + расширение к началу по клику).
  const visibleCount = Math.min(iters.length, ITERS_PAGE + itersExtra)
  const hiddenCount = iters.length - visibleCount
  const visibleIters = iters.slice(hiddenCount)

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
                  {hasFailed ? `⚠ ${failedCount} ${failedCount === 1 ? 'ошибка' : failedCount < 5 ? 'ошибки' : 'ошибок'} из ${totalDone}` : `${totalDone} ${totalDone === 1 ? 'действие' : totalDone < 5 ? 'действия' : 'действий'}`}
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
            {hiddenCount > 0 && (
              <button className="tc2-show-more" onClick={() => setItersExtra(e => e + ITERS_CHUNK)}>
                Показать ещё {Math.min(ITERS_CHUNK, hiddenCount)} из {hiddenCount} предыдущих действий
              </button>
            )}
            {visibleIters.map((iter, vIdx) => {
              const idx = hiddenCount + vIdx
              return (
                <IterationBlock
                  key={iter.id}
                  iter={iter}
                  index={vIdx}
                  isLast={idx === iters.length - 1}
                  isRunning={!!isRunning}
                  mode={mode}
                  defaultOpen={!!isRunning && idx === iters.length - 1}
                  liveSessionId={runCmdActive && iter.call.toolName === 'run_command' && !iter.result ? runCmdSessionId : undefined}
                  animateEntrance={!!isRunning}
                />
              )
            })}

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
  prev.elapsed === next.elapsed && prev.summary === next.summary &&
  prev.toolProgress === next.toolProgress)

export default ToolChain
