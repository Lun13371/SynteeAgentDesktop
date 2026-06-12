import { motion } from 'framer-motion'
import type { Chat } from '../../../../../shared/types'
import './Sidebar.css'

interface SidebarProps {
  chats?: Chat[]
  currentChatId?: string | null
  onSelectChat?: (id: string) => void
  onNewChat?: () => void
  isIncognito?: boolean
  onToggleIncognito?: () => void
}

function groupChatsByDate(chats: Chat[]) {
  const now = Date.now()
  const day = 86400000
  const groups: Record<string, Chat[]> = { 'Сегодня': [], 'Вчера': [], 'Ранее': [] }

  for (const chat of chats) {
    const diff = now - chat.updatedAt
    if (diff < day) groups['Сегодня'].push(chat)
    else if (diff < day * 2) groups['Вчера'].push(chat)
    else groups['Ранее'].push(chat)
  }
  return groups
}

export default function Sidebar({
  chats = [], currentChatId, onSelectChat, onNewChat,
  isIncognito, onToggleIncognito,
}: SidebarProps) {
  const groups = groupChatsByDate(chats)

  return (
    <motion.aside
      className="sidebar glass"
      initial={{ x: -20, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
    >
      <div className="sidebar-top">
        <motion.button
          className="sidebar-new-chat no-drag"
          whileTap={{ scale: 0.95 }}
          whileHover={{ scale: 1.02 }}
          onClick={onNewChat}
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
            <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          Новый чат
        </motion.button>
      </div>

      <div className="sidebar-list">
        {chats.length === 0 ? (
          <div className="sidebar-empty">Нет чатов</div>
        ) : (
          Object.entries(groups).map(([label, groupChats]) =>
            groupChats.length > 0 && (
              <div key={label}>
                <div className="sidebar-group-label">{label}</div>
                {groupChats.map(chat => (
                  <motion.button
                    key={chat.id}
                    className={`sidebar-chat-item no-drag ${chat.id === currentChatId ? 'sidebar-chat-item--active' : ''}`}
                    onClick={() => onSelectChat?.(chat.id)}
                    whileTap={{ scale: 0.98 }}
                  >
                    <span className="sidebar-chat-title">{chat.title}</span>
                    {chat.messageCount !== undefined && (
                      <span className="sidebar-chat-count">{chat.messageCount}</span>
                    )}
                  </motion.button>
                ))}
              </div>
            )
          )
        )}
      </div>

      <div className="sidebar-bottom">
        {/* Режим инкогнито */}
        <motion.button
          className={`sidebar-incognito-btn no-drag ${isIncognito ? 'sidebar-incognito-btn--active' : ''}`}
          onClick={onToggleIncognito}
          whileTap={{ scale: 0.95 }}
          title="Режим инкогнито"
        >
          🔒 {isIncognito ? 'Инкогнито вкл' : 'Инкогнито'}
        </motion.button>

        <div className="sidebar-user">
          <div className="sidebar-user-avatar">S</div>
          <span className="sidebar-user-name">Пользователь</span>
          <motion.button
            className="sidebar-settings-btn no-drag"
            whileTap={{ scale: 0.88 }}
            title="Настройки"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.4"/>
              <path d="M8 1v2M8 13v2M1 8h2M13 8h2M2.93 2.93l1.41 1.41M11.66 11.66l1.41 1.41M2.93 13.07l1.41-1.41M11.66 4.34l1.41-1.41"
                stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          </motion.button>
        </div>
      </div>
    </motion.aside>
  )
}
