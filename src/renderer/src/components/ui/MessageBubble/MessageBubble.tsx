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
import 'katex/dist/katex.min.css'
import './MessageBubble.css'

interface MessageBubbleProps {
  message: Message
  onPin?: (id: string) => void
  onCopy?: (content: string) => void
  onReadAloud?: (content: string) => void
  toolOutputMode?: ToolOutputMode
}

// Кастомный стиль для SyntaxHighlighter — поверх oneDark
const codeStyle = {
  ...oneDark,
  'pre[class*="language-"]': {
    ...((oneDark as Record<string, React.CSSProperties>)['pre[class*="language-"]'] || {}),
    margin: 0,
    padding: '14px 16px',
    background: '#0d0d0f',
    borderRadius: '0 0 8px 8px',
    fontSize: '13px',
    lineHeight: '1.6',
  },
  'code[class*="language-"]': {
    ...((oneDark as Record<string, React.CSSProperties>)['code[class*="language-"]'] || {}),
    background: 'transparent',
    fontSize: '13px',
  },
}

export default function MessageBubble({ message, onPin, onCopy, onReadAloud, toolOutputMode = 'normal' }: MessageBubbleProps) {
  const [showActions, setShowActions] = useState(false)
  const [copiedBlock, setCopiedBlock] = useState<number | null>(null)
  const isUser = message.role === 'user'

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content)
    onCopy?.(message.content)
  }

  const handleCopyBlock = (code: string, idx: number) => {
    navigator.clipboard.writeText(code)
    setCopiedBlock(idx)
    setTimeout(() => setCopiedBlock(null), 1500)
  }

  let codeBlockIdx = 0

  return (
    <motion.div
      className={`message-wrap ${isUser ? 'message-wrap--user' : 'message-wrap--assistant'}`}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 300, damping: 28 }}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      {!isUser && (
        <div className="message-avatar">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <polygon points="9,1 17,5 17,13 9,17 1,13 1,5"
              fill="none" stroke="var(--accent)" strokeWidth="1.2" opacity="0.8"/>
            <polygon points="9,4 14,7 14,11 9,14 4,11 4,7"
              fill="var(--accent)" opacity="0.1"/>
          </svg>
        </div>
      )}

      <div className="message-bubble-wrap">
        <div className={`message-bubble ${isUser ? 'message-bubble--user glass' : 'message-bubble--assistant'}`}>
          {message.isPinned === 1 && (
            <div className="message-pinned-badge">
              <AppIcon name="pin" size="sm" tone="accent" />
              <span>Закреплено</span>
            </div>
          )}

          {!isUser && message.toolSteps && message.toolSteps.length > 0 && (
            <ToolChain steps={message.toolSteps} mode={toolOutputMode} isRunning={false} />
          )}

          <div className="message-content selectable">
            {isUser ? (
              <p>{message.content}</p>
            ) : (
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeKatex]}
                components={{
                  // Блоки кода
                  code({ className, children, ...props }) {
                    const match = /language-(\w+)/.exec(className || '')
                    const raw = String(children).replace(/\n$/, '')
                    // inline — нет переносов строк и нет language-xxx
                    const isInline = !match && !raw.includes('\n')
                    if (isInline) {
                      return <code className="inline-code" {...props}>{children}</code>
                    }
                    const idx = codeBlockIdx++
                    const lang = match?.[1] || 'text'
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
                          language={lang}
                          PreTag="div"
                          showLineNumbers={raw.split('\n').length > 4}
                          lineNumberStyle={{ color: '#4a4a5a', fontSize: '11px', minWidth: '2.5em' }}
                          wrapLongLines={false}
                        >
                          {raw}
                        </SyntaxHighlighter>
                      </div>
                    )
                  },
                  // Таблицы
                  table({ children }) {
                    return (
                      <div className="md-table-wrap">
                        <table className="md-table">{children}</table>
                      </div>
                    )
                  },
                  thead({ children }) { return <thead className="md-thead">{children}</thead> },
                  tbody({ children }) { return <tbody>{children}</tbody> },
                  tr({ children }) { return <tr className="md-tr">{children}</tr> },
                  th({ children }) { return <th className="md-th">{children}</th> },
                  td({ children }) { return <td className="md-td">{children}</td> },
                  // Остальные элементы
                  blockquote({ children }) {
                    return <blockquote className="md-blockquote">{children}</blockquote>
                  },
                  a({ href, children }) {
                    return <a href={href} className="md-link" target="_blank" rel="noreferrer">{children}</a>
                  },
                  img({ src, alt }) {
                    return <img src={src} alt={alt} className="md-img" />
                  },
                  hr() { return <hr className="md-hr" /> },
                }}
              >
                {message.content}
              </ReactMarkdown>
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
          {!isUser && (
            <IconButton icon="volume" label="Озвучить" className="msg-action-btn" onClick={() => onReadAloud?.(message.content)} />
          )}
        </motion.div>
      </div>
    </motion.div>
  )
}
