import { useState, useMemo, memo, useCallback, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import PlanCard from '../PlanCard/PlanCard'
import type { Message, ToolOutputMode } from '../../../../../shared/types'
import AppIcon from '../AppIcon/AppIcon'
import IconButton from '../IconButton/IconButton'
import ToolChain from '../ToolChain/ToolChain'
import TodoChecklist from '../TodoChecklist/TodoChecklist'
import FastContextBlock, { type FastContextResultData } from '../FastContextBlock/FastContextBlock'
import AgentCard from '../AgentCard/AgentCard'
import MermaidBlock from './MermaidBlock'
import ThinkingBlock from '../ThinkingBlock/ThinkingBlock'
import { useUIStore, type AvatarStyle } from '../../../store/ui.store'
import 'katex/dist/katex.min.css'
import './MessageBubble.css'

// Варианты анимации сообщений
export const MSG_ANIM_VARIANTS: Record<string, {
  initial: object; animate: object; transition: object; label: string; desc: string
}> = {
  slide: {
    label: 'Слайд', desc: 'Снизу вверх',
    initial: { opacity: 0, y: 18 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.2, ease: 'easeOut' },
  },
  fade: {
    label: 'Плавно', desc: 'Плавное появление',
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    transition: { duration: 0.3, ease: 'easeOut' },
  },
  pop: {
    label: 'Поп', desc: 'Пружинный эффект',
    initial: { opacity: 0, scale: 0.88 },
    animate: { opacity: 1, scale: 1 },
    transition: { type: 'spring', stiffness: 420, damping: 26 },
  },
  swing: {
    label: 'Качели', desc: 'С боку',
    initial: { opacity: 0, x: -24, rotate: -3 },
    animate: { opacity: 1, x: 0, rotate: 0 },
    transition: { type: 'spring', stiffness: 380, damping: 28 },
  },
  rise: {
    label: 'Подъём', desc: 'Снизу с блюром',
    initial: { opacity: 0, y: 32, filter: 'blur(6px)' },
    animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
    transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
  },
  none: {
    label: 'Нет', desc: 'Без анимации',
    initial: {},
    animate: {},
    transition: { duration: 0 },
  },
}

interface MessageBubbleProps {
  message: Message
  onPin?: (id: string) => void
  onCopy?: (content: string) => void
  onReadAloud?: (content: string) => void
  onReply?: (message: Message) => void
  onRewind?: (userMessageId: string) => void
  toolOutputMode?: ToolOutputMode
  searchQuery?: string
  liveThinking?: { text: string; isLive: boolean; ms?: number }
  isStreaming?: boolean
  isWaiting?: boolean
  rateLimitSec?: number
}

const codeStyle = {
  ...oneDark,
  'pre[class*="language-"]': {
    ...((oneDark as Record<string, React.CSSProperties>)['pre[class*="language-"]'] || {}),
    margin: 0, padding: '14px 16px', background: '#0d0d0f',
    borderRadius: '0 0 8px 8px', fontSize: '13px', lineHeight: '1.6',
  },
  'code[class*="language-"]': {
    ...((oneDark as Record<string, React.CSSProperties>)['code[class*="language-"]'] || {}),
    background: 'transparent', fontSize: '13px',
  },
}

// Diff рендерер
const DiffBlock = memo(function DiffBlock({ code }: { code: string }) {
  return (
    <div className="diff-block">
      {code.split('\n').map((line, i) => {
        const cls = line.startsWith('+') ? 'diff-add'
          : line.startsWith('-') ? 'diff-del'
          : line.startsWith('@@') ? 'diff-hunk'
          : 'diff-ctx'
        return <div key={i} className={`diff-line ${cls}`}><span className="diff-line-content">{line || '\u00A0'}</span></div>
      })}
    </div>
  )
})

// Admonition блок
const ADMONITION_META: Record<string, { icon: string; label: string; cls: string }> = {
  note:    { icon: '📝', label: 'Заметка',    cls: 'adm--note' },
  info:    { icon: 'ℹ️',  label: 'Инфо',       cls: 'adm--info' },
  tip:     { icon: '💡', label: 'Совет',      cls: 'adm--tip' },
  warning: { icon: '⚠️', label: 'Внимание',   cls: 'adm--warning' },
  danger:  { icon: '🚨', label: 'Опасность',  cls: 'adm--danger' },
}

const AdmonitionBlock = memo(function AdmonitionBlock({ kind, title, children }: { kind: string; title?: string; children: React.ReactNode }) {
  const meta = ADMONITION_META[kind] || ADMONITION_META.note
  return (
    <div className={`adm ${meta.cls}`}>
      <div className="adm-header">
        <span className="adm-icon">{meta.icon}</span>
        <span className="adm-title">{title || meta.label}</span>
      </div>
      <div className="adm-body">{children}</div>
    </div>
  )
})

// Парсим admonitions — вынесено и мемоизировано снаружи
function parseContent(raw: string): Array<{ type: 'md' | 'admonition'; content: string; kind?: string; title?: string }> {
  const result: Array<{ type: 'md' | 'admonition'; content: string; kind?: string; title?: string }> = []
  const lines = raw.split('\n')
  let i = 0
  let mdBuf: string[] = []
  const ADM_RE = /^:::(note|tip|warning|danger|info)(?:\s+(.+))?$/i
  while (i < lines.length) {
    const m = ADM_RE.exec(lines[i].trim())
    if (m) {
      if (mdBuf.length) { result.push({ type: 'md', content: mdBuf.join('\n') }); mdBuf = [] }
      const kind = m[1].toLowerCase()
      const title = m[2]
      const body: string[] = []
      i++
      while (i < lines.length && lines[i].trim() !== ':::') { body.push(lines[i]); i++ }
      result.push({ type: 'admonition', content: body.join('\n'), kind, title })
    } else {
      mdBuf.push(lines[i])
    }
    i++
  }
  if (mdBuf.length) result.push({ type: 'md', content: mdBuf.join('\n') })
  return result
}

// ── AgentCardLive — живая карточка суб-агента в чате ─────────────────────
function AgentCardLive({ agentId, task }: {
  agentId: string
  task: string
}) {
  const [agent, setAgent] = useState<{
    id: string; status: string; model: string; steps: unknown[]
    summary: string; error?: string; createdAt: number; finishedAt?: number
  } | null>(null)

  useEffect(() => {
    window.syntee.agent.get(agentId).then((a: unknown) => {
      if (a) setAgent(a as never)
    })
    const off = window.syntee.on('agent:update', (updated: { id: string } & Record<string, unknown>) => {
      if (updated.id === agentId) setAgent(updated as never)
    })
    return () => off()
  }, [agentId])

  const status = (agent?.status ?? 'pending') as 'pending' | 'running' | 'done' | 'error' | 'cancelled'
  const currentTool = (agent?.steps as Array<{ type: string; toolName?: string }> | undefined)
    ?.filter(s => s.type === 'tool_call').slice(-1)[0]?.toolName

  return (
    <AgentCard
      agent={{
        id: agentId,
        task,
        status,
        model: agent?.model ?? '…',
        stepsCount: agent?.steps?.length ?? 0,
        currentStep: status === 'running' && currentTool ? currentTool : undefined,
        summary: agent?.summary,
        error: agent?.error,
        createdAt: agent?.createdAt ?? Date.now(),
        finishedAt: agent?.finishedAt,
      }}
      onClick={() => {
        window.syntee.on('agent:focus', agentId as never)
        window.dispatchEvent(new CustomEvent('open-agent-panel', { detail: { agentId } }))
      }}
    />
  )
}

// Shimmer-индикатор ожидания AI (думает / rate limit)
const WAITING_PHRASES = [
  'Думаю...',
  'Анализирую...',
  'Составляю ответ...',
  'Обрабатываю...',
  'Формулирую...',
]

function WaitingIndicator({ rateLimitSec, agentStatus, filesChanged, commandsRun }: { rateLimitSec?: number; agentStatus?: string | null; filesChanged?: number; commandsRun?: number }) {
  const [phraseIdx, setPhraseIdx] = useState(0)
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    if (agentStatus || rateLimitSec) return
    const interval = setInterval(() => {
      setVisible(false)
      setTimeout(() => {
        setPhraseIdx(i => (i + 1) % WAITING_PHRASES.length)
        setVisible(true)
      }, 300)
    }, 2500)
    return () => clearInterval(interval)
  }, [agentStatus, rateLimitSec])

  const isRateLimit = rateLimitSec && rateLimitSec > 0
  const text = isRateLimit
    ? `Rate limit — жду ${rateLimitSec}с...`
    : agentStatus ?? WAITING_PHRASES[phraseIdx]
  const cls = isRateLimit
    ? ' msg-waiting-shimmer--rl'
    : agentStatus
      ? ' msg-waiting-shimmer--status'
      : ''

  // Живой счётчик (§4.2): N файлов изменено · M команд выполнено
  const counterParts: string[] = []
  if (filesChanged && filesChanged > 0) counterParts.push(`${filesChanged} ${plural(filesChanged, 'файл', 'файла', 'файлов')}`)
  if (commandsRun && commandsRun > 0) counterParts.push(`${commandsRun} ${plural(commandsRun, 'команда', 'команды', 'команд')}`)
  const counter = counterParts.length > 0 ? counterParts.join(' · ') : null

  return (
    <span className="msg-waiting-wrap">
      <span
        className={`msg-waiting-shimmer${cls}`}
        style={{ opacity: visible ? 1 : 0, transition: 'opacity 0.3s ease' }}
      >
        {text}
      </span>
      {counter && <span className="msg-waiting-counter">{counter}</span>}
    </span>
  )
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}

/** Извлекает результат get_fast_context из steps итерации. */
function extractFastContextResult(steps: Array<{ type: string; toolName?: string; content?: string }>): FastContextResultData | null {
  for (const s of steps) {
    if (s.type === 'tool_result' && s.toolName === 'get_fast_context' && s.content) {
      try {
        const parsed = JSON.parse(s.content) as FastContextResultData
        if (parsed && Array.isArray(parsed.files)) return parsed
      } catch { /* skip */ }
    }
  }
  return null
}

// Мемоизированный тяжёлый контент сообщения
const MessageContent = memo(function MessageContent({
  content, isUser, searchQuery, toolOutputMode, toolSteps,
  onPin, onCopy, onReadAloud, onReply, onRewind, message, isPinned, createdAt,
  liveThinking, isStreaming, isWaiting, liveIters, liveTextAfter, rateLimitSec,
  userMarkdown = true, timeEl, agentStatus, toolProgress,
}: {
  content: string; isUser: boolean; searchQuery?: string
  toolOutputMode: ToolOutputMode; toolSteps?: Message['toolSteps']
  onPin?: (id: string) => void; onCopy?: () => void
  onReadAloud?: () => void; onReply?: () => void
  onRewind?: () => void
  message: Message; isPinned: number; createdAt: number
  liveThinking?: { text: string; isLive: boolean; ms?: number }
  isStreaming?: boolean
  isWaiting?: boolean
  liveIters?: Array<{ textBefore: string; thinking?: string; thinkingMs?: number; steps: import('../ToolChain/ToolChain').ToolStep[] }>
  liveTextAfter?: string
  rateLimitSec?: number
  userMarkdown?: boolean
  timeEl?: React.ReactNode
  agentStatus?: string | null
  toolProgress?: Record<string, { stage: string; detail?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }>; ts: number }>
}) {
  const [copiedBlock, setCopiedBlock] = useState<number | null>(null)
  const [showActions, setShowActions] = useState(false)

  const segments = useMemo(() =>
    isUser && !userMarkdown
      ? [{ type: 'plain' as const, content }]
      : isUser
        ? [{ type: 'md' as const, content }]
        : parseContent(content),
    [content, isUser, userMarkdown]
  )

  // Живой счётчик (§4.2): N файлов изменено · M команд выполнено
  const agentCounts = useMemo(() => {
    if (!toolSteps) return { filesChanged: 0, commandsRun: 0 }
    const filesChanged = toolSteps.filter(s =>
      s.type === 'tool_result' && s.success &&
      ['write_file', 'edit_file', 'multi_edit_file'].includes(s.toolName || '')
    ).length
    const commandsRun = toolSteps.filter(s =>
      s.type === 'tool_call' && s.toolName === 'run_command'
    ).length
    return { filesChanged, commandsRun }
  }, [toolSteps])

  // Мемоизированные remarkPlugins — не создаём новый массив при каждом рендере
  const remarkPlugins = useMemo(() => [remarkGfm, remarkMath], [])
  const rehypePlugins = useMemo(() => [rehypeKatex], [])

  // Стабильные components для ReactMarkdown — без inline функций
  const mdComponents = useMemo(() => {
    let codeBlockIdx = 0
    return {
      code({ className, children }: { className?: string; children?: React.ReactNode }) {
        const match = /language-(\w+)/.exec(className || '')
        const raw = String(children).replace(/\n$/, '')
        const isInline = !match && !raw.includes('\n')
        if (isInline) return <code className="inline-code">{children}</code>
        const lang = match?.[1] || 'text'
        if (lang === 'mermaid') return <MermaidBlock code={raw} />
        if (lang === 'diff') return <DiffBlock code={raw} />
        const idx = codeBlockIdx++
        return (
          <div className="code-block">
            <div className="code-block-header">
              <span className="code-lang">{lang.toUpperCase()}</span>
              <button
                className={`code-copy-btn ${copiedBlock === idx ? 'code-copy-btn--copied' : ''}`}
                onClick={() => { navigator.clipboard.writeText(raw); setCopiedBlock(idx); setTimeout(() => setCopiedBlock(null), 1500) }}
              >
                {copiedBlock === idx ? '✓ Скопировано' : 'Копировать'}
              </button>
            </div>
            <SyntaxHighlighter
              style={codeStyle as Record<string, React.CSSProperties>}
              language={lang} PreTag="div"
              showLineNumbers={raw.split('\n').length > 4}
              lineNumberStyle={{ color: '#4a4a5a', fontSize: '11px', minWidth: '2.5em' }}
              wrapLongLines={false}
            >
              {raw}
            </SyntaxHighlighter>
          </div>
        )
      },
      table({ children }: { children?: React.ReactNode }) { return <div className="md-table-wrap"><table className="md-table">{children}</table></div> },
      thead({ children }: { children?: React.ReactNode }) { return <thead className="md-thead">{children}</thead> },
      tr({ children }: { children?: React.ReactNode }) { return <tr className="md-tr">{children}</tr> },
      th({ children }: { children?: React.ReactNode }) { return <th className="md-th">{children}</th> },
      td({ children }: { children?: React.ReactNode }) { return <td className="md-td">{children}</td> },
      blockquote({ children }: { children?: React.ReactNode }) { return <blockquote className="md-blockquote">{children}</blockquote> },
      a({ href, children }: { href?: string; children?: React.ReactNode }) { return <a href={href} className="md-link" target="_blank" rel="noreferrer">{children}</a> },
      hr() { return <hr className="md-hr" /> },
      p({ children }: { children?: React.ReactNode }) { return <p>{children}</p> },
    }
  }, [copiedBlock]) // только copiedBlock меняет кнопку

  const handleMouseEnter = useCallback(() => setShowActions(true), [])
  const handleMouseLeave = useCallback(() => setShowActions(false), [])

  return (
    <div
      className="message-bubble-wrap"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className={`message-bubble ${isUser ? 'message-bubble--user glass' : 'message-bubble--assistant'}`}>
        {isPinned === 1 && (
          <div className="message-pinned-badge">
            <AppIcon name="pin" size="sm" tone="accent" /><span>Закреплено</span>
          </div>
        )}

        {/* Пилюлька слеш-команды */}
        {isUser && message.slashCommand && (
          <div className="message-slash-pill">
            <span className="message-slash-pill-icon">/</span>
            <span className="message-slash-pill-name">{message.slashCommand.name}</span>
            {message.slashCommand.args && (
              <span className="message-slash-pill-args">{message.slashCommand.args}</span>
            )}
          </div>
        )}

        {(message as Message & { replyTo?: { role: string; content: string } }).replyTo && (
          <div className="message-reply-quote">
            <span className="message-reply-role">
              {(message as Message & { replyTo?: { role: string; content: string } }).replyTo!.role === 'user' ? 'Вы' : 'Syntee'}
            </span>
            <span className="message-reply-text">
              {(message as Message & { replyTo?: { role: string; content: string } }).replyTo!.content.slice(0, 120)}
              {(message as Message & { replyTo?: { role: string; content: string } }).replyTo!.content.length > 120 ? '…' : ''}
            </span>
          </div>
        )}

        {!isUser && toolSteps && toolSteps.length > 0 && !liveIters?.length && !(message as Message & { iterations?: unknown[] }).iterations?.length && (
          <ToolChain steps={toolSteps} mode={toolOutputMode} isRunning={false} />
        )}

        {/* Финальный рендер итераций из БД — точно как live, каждая итерация отдельно */}
        {!isUser && !liveIters?.length && (() => {
          type Iter = { label?: string; textBefore: string; thinking?: string; thinkingMs?: number; steps: import('../ToolChain/ToolChain').ToolStep[] }
          const iters = (message as Message & { iterations?: Iter[] }).iterations
          if (!iters?.length) return null
          return (
            <div className="message-iters">
              {iters.map((iter, i) => (
                <div key={i} className="message-iteration">
                  {iter.thinking && (
                    <ThinkingBlock text={iter.thinking} thinkingMs={iter.thinkingMs} />
                  )}
                  {iter.textBefore && (
                    <div className="message-content selectable">
                      {parseContent(iter.textBefore).map((s, si) =>
                        s.type === 'admonition' ? (
                          <AdmonitionBlock key={si} kind={s.kind!} title={s.title}>
                            <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>{s.content}</ReactMarkdown>
                          </AdmonitionBlock>
                        ) : (
                          <ReactMarkdown key={si} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={mdComponents}>{s.content}</ReactMarkdown>
                        )
                      )}
                    </div>
                  )}
                  {iter.steps.length > 0 && (
                    <ToolChain steps={iter.steps} mode={toolOutputMode} isRunning={false} />
                  )}
                  {iter.steps.some(s => s.toolName === 'get_fast_context') && (() => {
                    const fcSaved = extractFastContextResult(iter.steps)
                    if (fcSaved) return <FastContextBlock result={fcSaved} />
                    return null
                  })()}
                </div>
              ))}
            </div>
          )
        })()}

        {/* Карточки суб-агентов */}
        {!isUser && toolSteps && !liveIters?.length && toolSteps
          .filter(s => s.type === 'tool_call' && s.toolName === 'spawn_agent')
          .map(s => {
            // Ищем соответствующий tool_result чтобы получить agentId
            const resultStep = toolSteps.find(r =>
              r.type === 'tool_result' && r.toolName === 'spawn_agent' &&
              r.timestamp >= s.timestamp
            )
            const agentIdMatch = resultStep?.content?.match(/\[AGENT:([^\]]+)\]/)
            const agentId = agentIdMatch?.[1]
            if (!agentId) return null
            return (
              <AgentCardLive
                key={agentId}
                agentId={agentId}
                task={(s.toolArgs?.task as string) ?? ''}
              />
            )
          })
        }

        {/* Сгенерированные изображения из tool steps — показываем прямо в чате */}
        {!isUser && toolSteps && !liveIters?.length && toolSteps
          .filter(s => s.type === 'tool_result' && s.imageUrl)
          .map(s => (
            <div key={s.id} className="message-image-wrap">
              <img
                src={`file://${s.imageUrl}`}
                alt="Сгенерированное изображение"
                className="message-image"
                onClick={() => window.open(`file://${s.imageUrl}`, '_blank')}
              />
            </div>
          ))
        }

        {/* Сгенерированное изображение */}
        {message.imageUrl && (
          <div className="message-image-wrap">
            <img
              src={message.imageUrl}
              alt="Generated"
              className="message-image"
              onClick={() => window.open(message.imageUrl, '_blank')}
            />
          </div>
        )}

        {/* Thinking block — только для обычного чата (без итераций).
            В agent mode thinking рендерится внутри итераций и как liveThinking.
            Проверяем !iterations?.length чтобы не дублировать последний reasoning-блок,
            который уже отрендерен внутри итераций выше. */}
        {!isUser && !liveIters?.length && !(message as Message & { iterations?: unknown[] }).iterations?.length && (message.thinking || liveThinking) && (
          <ThinkingBlock
            text={message.thinking}
            liveText={liveThinking?.text}
            thinkingMs={message.thinkingMs ?? liveThinking?.ms}
            isLive={liveThinking?.isLive}
          />
        )}

        {/* Индикатор ожидания — сразу при отправке и пока AI не начал писать */}
        {!isUser && (isStreaming || isWaiting) && !content && !liveThinking && !message.thinking && !liveIters?.length && (
          <WaitingIndicator rateLimitSec={rateLimitSec} agentStatus={agentStatus} filesChanged={agentCounts.filesChanged} commandsRun={agentCounts.commandsRun} />
        )}

        {/* §4.3 — видимый чек-лист плана (todo list).
            Для сохранённого сообщения — message.todo (из БД).
            Для live-пузыря — liveTodo (пока стримится, до save). */}
        {!isUser && (() => {
          type TodoItem = { text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }
          const liveTodo = (message as Message & { liveTodo?: TodoItem[] }).liveTodo
          const todo = message.todo ?? liveTodo
          return todo && todo.length > 0 ? <TodoChecklist items={todo} /> : null
        })()}

        {/* ── ИТЕРАЦИОННЫЙ РЕНДЕР (live агент: textBefore → toolchain → textAfter) ── */}
        {!isUser && liveIters && liveIters.length > 0 ? (
          <div className="message-segments">
            {liveIters.map((iter, ii) => {
              const isLastIter = ii === liveIters.length - 1
              const lastStepIsResult = iter.steps[iter.steps.length - 1]?.type === 'tool_result'
              return (
                <div key={ii} className="message-segment">
                  {/* Thinking блок этой итерации — на своей позиции */}
                  {iter.thinking && (
                    <ThinkingBlock text={iter.thinking} thinkingMs={iter.thinkingMs} />
                  )}
                  {/* Текст ДО тулчейна */}
                  {iter.textBefore && (
                    <div className="message-content selectable">
                      {parseContent(iter.textBefore).map((s, i) =>
                        s.type === 'admonition' ? (
                          <AdmonitionBlock key={i} kind={s.kind!} title={s.title}>
                            <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>{s.content}</ReactMarkdown>
                          </AdmonitionBlock>
                        ) : (
                          <ReactMarkdown key={i} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={mdComponents}>{s.content}</ReactMarkdown>
                        )
                      )}
                    </div>
                  )}
                  {/* Тулчейн итерации */}
                  {iter.steps.length > 0 && (
                    <ToolChain
                      steps={iter.steps}
                      mode={toolOutputMode}
                      isRunning={!!isStreaming && isLastIter && !lastStepIsResult}
                    />
                  )}
                  {/* Fast Context блок — после toolchain, внутри итерации.
                      Позиция стабильна: стримящийся текст идёт ниже. */}
                  {iter.steps.some(s => s.toolName === 'get_fast_context') && (() => {
                    const fcLive = isStreaming && isLastIter ? toolProgress?.['get_fast_context'] : undefined
                    const isFcLive = fcLive && fcLive.stage !== 'done'
                    if (isFcLive) {
                      return <FastContextBlock result={{ files: [], summary: '', ms: 0, indexedFilesCount: 0 }} liveProgress={fcLive} />
                    }
                    const fcSaved = extractFastContextResult(iter.steps)
                    if (fcSaved) return <FastContextBlock result={fcSaved} />
                    return null
                  })()}
                  {/* Пульс после тулчейна пока AI думает (ждёт следующего токена) */}
                  {isStreaming && isLastIter && lastStepIsResult && !liveTextAfter && !liveThinking && (
                    <WaitingIndicator rateLimitSec={rateLimitSec} agentStatus={agentStatus} filesChanged={agentCounts.filesChanged} commandsRun={agentCounts.commandsRun} />
                  )}
                </div>
              )
            })}
            {/* Live thinking — текущий стримящийся блок рассуждения,
                на позиции после последней итерации, перед текстом ответа */}
            {liveThinking && (liveThinking.text || liveThinking.isLive) && (
              <ThinkingBlock
                liveText={liveThinking.text}
                thinkingMs={liveThinking.ms}
                isLive={liveThinking.isLive}
              />
            )}
            {/* Текст ПОСЛЕ всех тулов (финальный ответ текущей итерации) */}
            {liveTextAfter && (
              <div className="message-content selectable">
                {parseContent(liveTextAfter).map((s, i) =>
                  s.type === 'admonition' ? (
                    <AdmonitionBlock key={i} kind={s.kind!} title={s.title}>
                      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>{s.content}</ReactMarkdown>
                    </AdmonitionBlock>
                  ) : (
                    <ReactMarkdown key={i} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={mdComponents}>{s.content}</ReactMarkdown>
                  )
                )}
              </div>
            )}
          </div>
        ) : (
          /* ── ОБЫЧНЫЙ РЕНДЕР (нет live итераций — обычный чат или финальное сообщение) ── */
          /* Если есть сохранённые iterations — content уже покрыт ими, не дублируем */
          (() => {
            type Iter = { label?: string; textBefore: string; thinking?: string; thinkingMs?: number; steps: import('../ToolChain/ToolChain').ToolStep[] }
            const savedIters = (message as Message & { iterations?: Iter[] }).iterations
            if (!isUser && savedIters?.length) return null
            return (
              <div className="message-content selectable">
                {isUser && !userMarkdown ? (
                  <p>{content}</p>
                ) : (
                  segments.map((seg, si) =>
                    seg.type === 'admonition' ? (
                      <AdmonitionBlock key={si} kind={seg.kind!} title={seg.title}>
                        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
                          {seg.content}
                        </ReactMarkdown>
                      </AdmonitionBlock>
                    ) : (
                      <ReactMarkdown
                        key={si}
                        remarkPlugins={remarkPlugins}
                        rehypePlugins={rehypePlugins}
                        components={mdComponents}
                      >
                        {seg.content}
                      </ReactMarkdown>
                    )
                  )
                )}
              </div>
            )
          })()
        )}

        {timeEl}
      </div>

      <div
        className="message-actions"
        style={{ opacity: showActions ? 1 : 0, pointerEvents: showActions ? 'all' : 'none', transition: 'opacity 0.12s' }}
      >
        <IconButton icon="copy" label="Копировать" className="msg-action-btn" onClick={onCopy} />
        <IconButton icon="pin" label="Закрепить" className="msg-action-btn" onClick={() => onPin?.(message.id)} />
        {onReply && <IconButton icon="reply" label="Ответить" className="msg-action-btn" onClick={onReply} />}
        {isUser && onRewind && <IconButton icon="rewind" label="Откатить к этому сообщению" className="msg-action-btn" onClick={onRewind} />}
        {!isUser && <IconButton icon="volume" label="Озвучить" className="msg-action-btn" onClick={onReadAloud} />}
      </div>
    </div>
  )
})

// Аватар ассистента — несколько стилей
function AssistantAvatar({ style }: { style: AvatarStyle }) {
  if (style === 'none') return null
  if (style === 'circle') return (
    <div className="message-avatar message-avatar--circle">
      <svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="var(--accent)" opacity="0.7"/></svg>
    </div>
  )
  if (style === 'letter') return (
    <div className="message-avatar message-avatar--letter">S</div>
  )
  if (style === 'emoji') return (
    <div className="message-avatar message-avatar--emoji">🤖</div>
  )
  // hex (default)
  return (
    <div className="message-avatar">
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <polygon points="9,1 17,5 17,13 9,17 1,13 1,5" fill="none" stroke="var(--accent)" strokeWidth="1.2" opacity="0.8"/>
        <polygon points="9,4 14,7 14,11 9,14 4,11 4,7" fill="var(--accent)" opacity="0.1"/>
      </svg>
    </div>
  )
}

// System-разделитель — полоса поперёк чата для system-сообщений (откаты,
// сжатие контекста и т.д.). Для rewind-сообщений с активной redo-точкой
// показывает кнопку "Отменить откат". Для compact-сообщений — кнопку
// "Развернуть"/"Свернуть" для раскрытия резюме (compactSummary).
function SystemDivider({ message, isRewind, isCompact, isCompacting, timeEl }: {
  message: Message
  isRewind: boolean
  isCompact: boolean
  isCompacting: boolean
  timeEl: React.ReactNode
}) {
  const [canRedo, setCanRedo] = useState(false)
  const [redoing, setRedoing] = useState(false)
  const [expanded, setExpanded] = useState(false)

  // Проверяем — доступна ли отмена отката (есть redo-точка в БД).
  useEffect(() => {
    if (!isRewind || !message.chatId) { setCanRedo(false); return }
    let cancelled = false
    const check = async () => {
      const result = await window.syntee.chat.canRedo(message.chatId, message.id) as boolean
      if (!cancelled) setCanRedo(result)
    }
    check()
    // Проверяем снова при получении события CHAT_REWOUND (redo мог быть отменён).
    const off = window.syntee.on('chat:rewound', () => { if (!cancelled) check() })
    return () => { cancelled = true; off() }
  }, [isRewind, message.chatId, message.id])

  const handleRedo = useCallback(async () => {
    if (!message.chatId || redoing) return
    const confirmed = window.confirm('Отменить откат? Сообщения и файлы будут возвращены.')
    if (!confirmed) return
    setRedoing(true)
    try {
      const result = await window.syntee.chat.redo(message.chatId, message.id) as { messages?: Message[]; error?: string }
      if (result.error) {
        window.alert(result.error)
      }
      // CHAT_REWOUND event обновит messages в store
    } catch (e) {
      window.alert(String((e as Error)?.message ?? e))
    } finally {
      setRedoing(false)
    }
  }, [message.chatId, message.id, redoing])

  const variantClass = isRewind ? 'message-system-divider--rewind'
    : isCompact ? 'message-system-divider--compact'
    : isCompacting ? 'message-system-divider--compact message-system-divider--compacting'
    : ''
  const iconName = isRewind ? 'rewind' : (isCompact || isCompacting) ? 'layers' : 'info'
  const iconTone = isRewind ? 'warning' : (isCompact || isCompacting) ? 'accent' : 'muted'

  return (
    <motion.div
      className={`message-system-divider ${variantClass}`}
      initial={{ opacity: 0, scaleY: 0 }}
      animate={{ opacity: 1, scaleY: 1 }}
      transition={{ duration: 0.25 }}
    >
      <div className="message-system-divider__line" />
      <div className="message-system-divider__badge">
        {isCompacting
          ? <AppIcon name="refreshCw" size="xs" tone="accent" animation="spin" />
          : <AppIcon name={iconName} size="xs" tone={iconTone} />}
        <span className="message-system-divider__text">{message.content}</span>
        {timeEl}
        {isCompact && message.compactSummary && (
          <button
            className="message-system-divider__expand"
            onClick={() => setExpanded(v => !v)}
            title={expanded ? 'Свернуть резюме' : 'Развернуть резюме сжатия'}
          >
            <AppIcon name={expanded ? 'chevronUp' : 'chevronDown'} size="xs" />
            <span>{expanded ? 'Свернуть' : 'Развернуть'}</span>
          </button>
        )}
        {isRewind && canRedo && (
          <button
            className="message-system-divider__redo"
            onClick={handleRedo}
            disabled={redoing}
            title="Отменить откат — вернуть сообщения и файлы"
          >
            <AppIcon name="refreshCw" size="xs" animation={redoing ? 'spin' : 'none'} />
            <span>Отменить откат</span>
          </button>
        )}
      </div>
      <div className="message-system-divider__line" />

      {isCompact && expanded && message.compactSummary && (
        <motion.div
          className="message-system-divider__summary"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
        >
          <div className="message-system-divider__summary-head">
            <AppIcon name="layers" size="xs" tone="accent" />
            <span>Резюме сжатого контекста</span>
          </div>
          <div className="message-system-divider__summary-content selectable">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
            >
              {message.compactSummary}
            </ReactMarkdown>
          </div>
        </motion.div>
      )}
    </motion.div>
  )
}


const MessageBubble = memo(function MessageBubble({
  message, onPin, onCopy, onReadAloud, onReply, onRewind, toolOutputMode = 'normal', searchQuery, liveThinking, isStreaming, isWaiting, rateLimitSec,
}: MessageBubbleProps) {
  const isUser = message.role === 'user'

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.content)
    onCopy?.(message.content)
  }, [message.content, onCopy])

  const handleReply = useCallback(() => {
    onReply?.(message)
  }, [message, onReply])

  const handleRewind = useCallback(() => {
    onRewind?.(message.id)
  }, [message.id, onRewind])

  const handleReadAloud = useCallback(() => {
    onReadAloud?.(message.content)
  }, [message.content, onReadAloud])

  const { msgAnim, avatarStyle, showTime, userMarkdown } = useUIStore()
  const anim = MSG_ANIM_VARIANTS[msgAnim] ?? MSG_ANIM_VARIANTS.slide

  // Время — always / hover / never
  const timeEl = showTime !== 'never' ? (
    <span className={`message-time ${showTime === 'hover' ? 'message-time--hover' : ''}`}>
      {new Date(message.createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}
    </span>
  ) : null

  // System-сообщения (откаты, сжатие контекста, системные уведомления)
  // рендерим как стилизованную разделительную полосу поперёк чата — не
  // как пузырь.
  if (message.role === 'system') {
    const isRewind = message.slashCommand?.name === 'rewind'
    const isCompact = message.slashCommand?.name === 'compact' && message.slashCommand?.args !== 'pending'
    const isCompacting = message.slashCommand?.name === 'compact' && message.slashCommand?.args === 'pending'
    return <SystemDivider message={message} isRewind={isRewind} isCompact={isCompact} isCompacting={isCompacting} timeEl={timeEl} />
  }

  return (
    <motion.div
      className={`message-wrap ${isUser ? 'message-wrap--user' : 'message-wrap--assistant'} ${searchQuery ? 'message-wrap--search-match' : ''}`}
      initial={anim.initial}
      animate={anim.animate}
      transition={anim.transition}
    >
      {!isUser && <AssistantAvatar style={avatarStyle} />}

      {message.planData ? (
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
          {message.content && message.content.trim() && (
            <MessageContent
              content={message.content}
              isUser={isUser}
              searchQuery={searchQuery}
              toolOutputMode={toolOutputMode}
              toolSteps={message.toolSteps}
              onPin={onPin}
              onCopy={handleCopy}
              onReadAloud={handleReadAloud}
              onReply={handleReply}
              onRewind={handleRewind}
              message={message}
              isPinned={message.isPinned as number}
              createdAt={message.createdAt}
              liveThinking={liveThinking}
              isStreaming={isStreaming}
              isWaiting={isWaiting}
              liveIters={(message as Message & { liveIters?: Array<{ textBefore: string; thinking?: string; thinkingMs?: number; steps: import('../ToolChain/ToolChain').ToolStep[] }> }).liveIters}
              liveTextAfter={(message as Message & { liveTextAfter?: string }).liveTextAfter}
              rateLimitSec={rateLimitSec}
              userMarkdown={isUser ? userMarkdown : true}
              timeEl={timeEl}
              agentStatus={(message as Message & { agentStatus?: string }).agentStatus}
              toolProgress={(message as Message & { toolProgress?: Record<string, { stage: string; detail?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }>; ts: number }> }).toolProgress}
            />
          )}
          <PlanCard
            title={message.planData.title}
            content={message.planData.content}
            summary={message.planData.summary}
            filePath={message.planData.filePath}
          />
        </div>
      ) : (
      <MessageContent
        content={message.content}
        isUser={isUser}
        searchQuery={searchQuery}
        toolOutputMode={toolOutputMode}
        toolSteps={message.toolSteps}
        onPin={onPin}
        onCopy={handleCopy}
        onReadAloud={handleReadAloud}
        onReply={handleReply}
        onRewind={handleRewind}
        message={message}
        isPinned={message.isPinned as number}
        createdAt={message.createdAt}
        liveThinking={liveThinking}
        isStreaming={isStreaming}
        isWaiting={isWaiting}
        liveIters={(message as Message & { liveIters?: Array<{ textBefore: string; steps: import('../ToolChain/ToolChain').ToolStep[] }> }).liveIters}
        liveTextAfter={(message as Message & { liveTextAfter?: string }).liveTextAfter}
        rateLimitSec={rateLimitSec}
        userMarkdown={isUser ? userMarkdown : true}
        timeEl={timeEl}
        agentStatus={(message as Message & { agentStatus?: string }).agentStatus}
        toolProgress={(message as Message & { toolProgress?: Record<string, { stage: string; detail?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }>; ts: number }> }).toolProgress}
      />
      )}
    </motion.div>
  )
})

export default MessageBubble

