import { useState } from 'react'
import { motion } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import type { Message, ToolOutputMode } from '../../../../../shared/types'
import AppIcon from '../AppIcon/AppIcon'
import IconButton from '../IconButton/IconButton'
import ToolChain from '../ToolChain/ToolChain'
import './MessageBubble.css'

interface MessageBubbleProps {
  message: Message
  onPin?: (id: string) => void
  onCopy?: (content: string) => void
  onReadAloud?: (content: string) => void
  toolOutputMode?: ToolOutputMode
}

export default function MessageBubble({ message, onPin, onCopy, onReadAloud, toolOutputMode = 'normal' }: MessageBubbleProps) {
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

      <div className="message-bubble-wrap">
        <div className={`message-bubble ${isUser ? 'message-bubble--user glass' : 'message-bubble--assistant'}`}>
          {message.isPinned === 1 && (
            <div className="message-pinned-badge">
              <AppIcon name="pin" size="sm" tone="accent" />
              <span>Закреплено</span>
            </div>
          )}

          {/* ToolChain — шаги агента сохранённые в сообщении */}
          {!isUser && message.toolSteps && message.toolSteps.length > 0 && (
            <ToolChain steps={message.toolSteps} mode={toolOutputMode} isRunning={false} />
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

          <span className="message-time">
            {new Date(message.createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>

        {/* Кнопки справа от bubble */}
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

      {isUser && <div className="message-avatar message-avatar--user" />}
    </motion.div>
  )
}
