import { useState } from 'react'
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
import MermaidBlock from './MermaidBlock'
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

// Diff рендерер — красные/зелёные строки
function DiffBlock({ code }: { code: string }) {
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
}

// Admonition блок
const ADMONITION_META: Record<string, { icon: string; label: string; cls: string }> = {
  note:    { icon: '📝', label: 'Заметка',    cls: 'adm--note' },
  info:    { icon: 'ℹ️',  label: 'Инфо',       cls: 'adm--info' },
  tip:     { icon: '💡', label: 'Совет',      cls: 'adm--tip' },
  warning: { icon: '⚠️', label: 'Внимание',   cls: 'adm--warning' },
  danger:  { icon: '🚨', label: 'Опасность',  cls: 'adm--danger' },
}

function AdmonitionBlock({ kind, title, children }: { kind: string; title?: string; children: React.ReactNode }) {
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
}

// Подсветка поискового запроса в тексте
function HighlightText({ text, query }: { text: string; query?: string }) {
  if (!query || !text) return <>{text}</>
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'))
  return (
    <>
      {parts.map((p, i) =>
        p.toLowerCase() === query.toLowerCase()
          ? <mark key={i} className="search-highlight">{p}</mark>
          : p
      )}
    </>
  )
}

export default function MessageBubble({
  message, onPin, onCopy, onReadAloud, onReply, toolOutputMode = 'normal', searchQuery
}: MessageBubbleProps) {
  const [showActions, setShowActions] = useState(false)
  const [copiedBlock, setCopiedBlock] = useState<number | null>(null)
  const isUser = message.role === 'user'
  let codeBlockIdx = 0

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content)
    onCopy?.(message.content)
  }

  const handleCopyBlock = (code: string, idx: number) => {
    navigator.clipboard.writeText(code)
    setCopiedBlock(idx)
    setTimeout(() => setCopiedBlock(null), 1500)
  }

  // Парсим admonitions из текста вручную (:::kind ... :::)
  const parseContent = (raw: string): Array<{ type: 'md' | 'admonition'; content: string; kind?: string; title?: string }> => {
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

  const segments = isUser ? [{ type: 'md' as const, content: message.content }] : parseContent(message.content)

  return (
    <motion.div
      className={`message-wrap ${isUser ? 'message-wrap--user' : 'message-wrap--assistant'} ${searchQuery ? 'message-wrap--search-match' : ''}`}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 300, damping: 28 }}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      {!isUser && (
        <div className="message-avatar">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <polygon points="9,1 17,5 17,13 9,17 1,13 1,5" fill="none" stroke="var(--accent)" strokeWidth="1.2" opacity="0.8"/>
            <polygon points="9,4 14,7 14,11 9,14 4,11 4,7" fill="var(--accent)" opacity="0.1"/>
          </svg>
        </div>
      )}

      <div className="message-bubble-wrap">
        <div className={`message-bubble ${isUser ? 'message-bubble--user glass' : 'message-bubble--assistant'}`}>
          {message.isPinned === 1 && (
            <div className="message-pinned-badge">
              <AppIcon name="pin" size="sm" tone="accent" /><span>Закреплено</span>
            </div>
          )}

          {/* Reply цитата */}
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

          {!isUser && message.toolSteps && message.toolSteps.length > 0 && (
            <ToolChain steps={message.toolSteps} mode={toolOutputMode} isRunning={false} />
          )}

          <div className="message-content selectable">
            {isUser ? (
              <p><HighlightText text={message.content} query={searchQuery} /></p>
            ) : (
              segments.map((seg, si) =>
                seg.type === 'admonition' ? (
                  <AdmonitionBlock key={si} kind={seg.kind!} title={seg.title}>
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                      {seg.content}
                    </ReactMarkdown>
                  </AdmonitionBlock>
                ) : (
                  <ReactMarkdown
                    key={si}
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeKatex]}
                    components={{
                      code({ className, children }) {
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
                              <span className="code-lang">{lang}</span>
                              <button
                                className={`code-copy-btn ${copiedBlock === idx ? 'code-copy-btn--copied' : ''}`}
                                onClick={() => handleCopyBlock(raw, idx)}
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
                      table({ children }) { return <div className="md-table-wrap"><table className="md-table">{children}</table></div> },
                      thead({ children }) { return <thead className="md-thead">{children}</thead> },
                      tr({ children }) { return <tr className="md-tr">{children}</tr> },
                      th({ children }) { return <th className="md-th">{children}</th> },
                      td({ children }) { return <td className="md-td">{children}</td> },
                      blockquote({ children }) { return <blockquote className="md-blockquote">{children}</blockquote> },
                      a({ href, children }) { return <a href={href} className="md-link" target="_blank" rel="noreferrer">{children}</a> },
                      hr() { return <hr className="md-hr" /> },
                      // Подсветка поиска в параграфах
                      p({ children }) {
                        if (!searchQuery) return <p>{children}</p>
                        return <p>{children}</p>
                      },
                    }}
                  >
                    {seg.content}
                  </ReactMarkdown>
                )
              )
            )}
          </div>

          <span className="message-time">
            {new Date(message.createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>

        <motion.div
          className="message-actions"
          initial={{ opacity: 0, x: -6 }}
          animate={{ opacity: showActions ? 1 : 0, x: showActions ? 0 : -6 }}
          transition={{ duration: 0.12 }}
          style={{ pointerEvents: showActions ? 'all' : 'none' }}
        >
          <IconButton icon="copy" label="Копировать" className="msg-action-btn" onClick={handleCopy} />
          <IconButton icon="pin" label="Закрепить" className="msg-action-btn" onClick={() => onPin?.(message.id)} />
          {onReply && (
            <IconButton icon="reply" label="Ответить" className="msg-action-btn" onClick={() => onReply(message)} />
          )}
          {!isUser && (
            <IconButton icon="volume" label="Озвучить" className="msg-action-btn" onClick={() => onReadAloud?.(message.content)} />
          )}
        </motion.div>
      </div>
    </motion.div>
  )
}
