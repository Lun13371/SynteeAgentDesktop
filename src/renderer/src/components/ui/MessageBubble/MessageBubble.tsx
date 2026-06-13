import { useState, useMemo, memo, useCallback, useEffect } from 'react'
import { motion } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import type { Message, ToolOutputMode } from '../../../../../shared/types'
import AppIcon from '../AppIcon/AppIcon'
import IconButton from '../IconButton/IconButton'
import ToolChain from '../ToolChain/ToolChain'
import AgentCard from '../AgentCard/AgentCard'
import MermaidBlock from './MermaidBlock'
import ThinkingBlock from '../ThinkingBlock/ThinkingBlock'
import 'katex/dist/katex.min.css'
import './MessageBubble.css'

interface MessageBubbleProps {
  message: Message
  onPin?: (id: string) => void
  onCopy?: (content: string) => void
  onReadAloud?: (content: string) => void
  onReply?: (message: Message) => void
  toolOutputMode?: ToolOutputMode
  searchQuery?: string
  liveThinking?: { text: string; isLive: boolean; ms?: number }
  isStreaming?: boolean
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
function AgentCardLive({ agentId, task, parallel }: {
  agentId: string
  task: string
  parallel: boolean
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
        parallel,
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

// Мемоизированный тяжёлый контент сообщения
const MessageContent = memo(function MessageContent({
  content, isUser, searchQuery, toolOutputMode, toolSteps,
  onPin, onCopy, onReadAloud, onReply, message, isPinned, createdAt,
  liveThinking, isStreaming, liveIters, liveTextAfter,
}: {
  content: string; isUser: boolean; searchQuery?: string
  toolOutputMode: ToolOutputMode; toolSteps?: Message['toolSteps']
  onPin?: (id: string) => void; onCopy?: () => void
  onReadAloud?: () => void; onReply?: () => void
  message: Message; isPinned: number; createdAt: number
  liveThinking?: { text: string; isLive: boolean; ms?: number }
  isStreaming?: boolean
  liveIters?: Array<{ textBefore: string; steps: import('../ToolChain/ToolChain').ToolStep[] }>
  liveTextAfter?: string
}) {
  const [copiedBlock, setCopiedBlock] = useState<number | null>(null)
  const [showActions, setShowActions] = useState(false)

  const segments = useMemo(() =>
    isUser ? [{ type: 'md' as const, content }] : parseContent(content),
    [content, isUser]
  )

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

        {!isUser && toolSteps && toolSteps.length > 0 && !liveIters?.length && (
          <ToolChain steps={toolSteps} mode={toolOutputMode} isRunning={false} />
        )}

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
                parallel={!!(s.toolArgs?.parallel)}
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

        {/* Thinking block — сохранённый или live */}
        {!isUser && (message.thinking || liveThinking) && (
          <ThinkingBlock
            text={message.thinking}
            liveText={liveThinking?.text}
            thinkingMs={message.thinkingMs ?? liveThinking?.ms}
            isLive={liveThinking?.isLive}
          />
        )}

        {/* Пустой пузырь во время ожидания первого токена */}
        {!isUser && isStreaming && !content && !liveThinking && !message.thinking && (
          <span className="msg-waiting-dots"><span/><span/><span/></span>
        )}

        {/* ── ИТЕРАЦИОННЫЙ РЕНДЕР (live агент: textBefore → toolchain → textAfter) ── */}
        {!isUser && liveIters && liveIters.length > 0 ? (
          <div className="message-segments">
            {liveIters.map((iter, ii) => {
              const isLastIter = ii === liveIters.length - 1
              const lastStepIsResult = iter.steps[iter.steps.length - 1]?.type === 'tool_result'
              return (
                <div key={ii} className="message-segment">
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
                  {/* Пульс после тулчейна пока AI думает (ждёт следующего токена) */}
                  {isStreaming && isLastIter && lastStepIsResult && !liveTextAfter && (
                    <span className="msg-waiting-dots"><span/><span/><span/></span>
                  )}
                </div>
              )
            })}
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
          /* ── ОБЫЧНЫЙ РЕНДЕР (нет итераций — обычный чат или финальное сообщение) ── */
          <div className="message-content selectable">
            {isUser ? (
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
        )}

        <span className="message-time">
          {new Date(createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      <div
        className="message-actions"
        style={{ opacity: showActions ? 1 : 0, pointerEvents: showActions ? 'all' : 'none', transition: 'opacity 0.12s' }}
      >
        <IconButton icon="copy" label="Копировать" className="msg-action-btn" onClick={onCopy} />
        <IconButton icon="pin" label="Закрепить" className="msg-action-btn" onClick={() => onPin?.(message.id)} />
        {onReply && <IconButton icon="reply" label="Ответить" className="msg-action-btn" onClick={onReply} />}
        {!isUser && <IconButton icon="volume" label="Озвучить" className="msg-action-btn" onClick={onReadAloud} />}
      </div>
    </div>
  )
})

// Внешний пузырь — только layout + spring анимация при mount
const MessageBubble = memo(function MessageBubble({
  message, onPin, onCopy, onReadAloud, onReply, toolOutputMode = 'normal', searchQuery, liveThinking, isStreaming,
}: MessageBubbleProps) {
  const isUser = message.role === 'user'

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.content)
    onCopy?.(message.content)
  }, [message.content, onCopy])

  const handleReply = useCallback(() => {
    onReply?.(message)
  }, [message, onReply])

  const handleReadAloud = useCallback(() => {
    onReadAloud?.(message.content)
  }, [message.content, onReadAloud])

  return (
    <motion.div
      className={`message-wrap ${isUser ? 'message-wrap--user' : 'message-wrap--assistant'} ${searchQuery ? 'message-wrap--search-match' : ''}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}  // CSS ease вместо spring — в 3x быстрее
    >
      {!isUser && (
        <div className="message-avatar">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <polygon points="9,1 17,5 17,13 9,17 1,13 1,5" fill="none" stroke="var(--accent)" strokeWidth="1.2" opacity="0.8"/>
            <polygon points="9,4 14,7 14,11 9,14 4,11 4,7" fill="var(--accent)" opacity="0.1"/>
          </svg>
        </div>
      )}

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
        message={message}
        isPinned={message.isPinned as number}
        createdAt={message.createdAt}
        liveThinking={liveThinking}
        isStreaming={isStreaming}
        liveIters={(message as Message & { liveIters?: Array<{ textBefore: string; steps: import('../ToolChain/ToolChain').ToolStep[] }> }).liveIters}
        liveTextAfter={(message as Message & { liveTextAfter?: string }).liveTextAfter}
      />
    </motion.div>
  )
})

export default MessageBubble

