import { useState } from 'react'
import { motion } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import type { Message } from '../../../../../shared/types'
import './MessageBubble.css'

interface MessageBubbleProps {
  message: Message
  onPin?: (id: string) => void
  onCopy?: (text: string) => void
  onReadAloud?: (text: string) => void
}

export default function MessageBubble({ message, onPin, onCopy, onReadAloud }: MessageBubbleProps) {
  const [showActions, setShowActions] = useState(false)
  const isUser = message.role === 'user'

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content)
    onCopy?.(message.content)
  }

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

      <div className={`message-bubble ${isUser ? 'message-bubble--user glass' : 'message-bubble--assistant'}`}>
        {/* Пиннут */}
        {message.isPinned === 1 && (
          <div className="message-pinned-badge">📌 Закреплено</div>
        )}

        <div className="message-content selectable">
          {isUser ? (
            <p>{message.content}</p>
          ) : (
            <ReactMarkdown
              components={{
                code({ node, className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || '')
                  const isBlock = !!(node?.position?.start.line !== node?.position?.end.line)
                  return isBlock && match ? (
                    <div className="code-block">
                      <div className="code-block-header">
                        <span className="code-lang">{match[1]}</span>
                        <button
                          className="code-copy-btn"
                          onClick={() => navigator.clipboard.writeText(String(children))}
                        >
                          Копировать
                        </button>
                      </div>
                      <SyntaxHighlighter
                        style={oneDark as Record<string, React.CSSProperties>}
                        language={match[1]}
                        PreTag="div"
                        customStyle={{ margin: 0, borderRadius: '0 0 8px 8px', background: 'rgba(0,0,0,0.4)' }}
                      >
                        {String(children).replace(/\n$/, '')}
                      </SyntaxHighlighter>
                    </div>
                  ) : (
                    <code className="inline-code" {...props}>{children}</code>
                  )
                }
              }}
            >
              {message.content}
            </ReactMarkdown>
          )}
        </div>

        {/* Время */}
        <span className="message-time">
          {new Date(message.createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      {/* Действия при наведении */}
      <motion.div
        className="message-actions"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: showActions ? 1 : 0, scale: showActions ? 1 : 0.9 }}
        transition={{ duration: 0.15 }}
      >
        <button className="msg-action-btn" onClick={handleCopy} title="Копировать">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <rect x="4" y="4" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M2 9V2h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
        </button>
        <button className="msg-action-btn" onClick={() => onPin?.(message.id)} title="Закрепить">
          📌
        </button>
        {!isUser && (
          <button className="msg-action-btn" onClick={() => onReadAloud?.(message.content)} title="Озвучить">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M2 4.5h2l3-3v10l-3-3H2v-4z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              <path d="M9 4a3 3 0 010 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
        )}
      </motion.div>
    </motion.div>
  )
}
