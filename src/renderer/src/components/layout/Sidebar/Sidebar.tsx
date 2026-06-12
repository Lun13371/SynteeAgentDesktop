import { motion } from 'framer-motion'
import type { Chat } from '../../../../../shared/types'
import AppIcon from '../../ui/AppIcon/AppIcon'
import IconButton from '../../ui/IconButton/IconButton'
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
          <AppIcon name="plus" size="sm" tone="default" />
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
        <motion.button
          className={`sidebar-incognito-btn no-drag ${isIncognito ? 'sidebar-incognito-btn--active' : ''}`}
          onClick={onToggleIncognito}
          whileTap={{ scale: 0.95 }}
          title="Режим инкогнито"
          aria-label="Режим инкогнито"
        >
          <AppIcon name="lock" size="sm" tone={isIncognito ? 'accent' : 'muted'} />
          {isIncognito ? 'Инкогнито вкл' : 'Инкогнито'}
        </motion.button>

        <div className="sidebar-user">
          <div className="sidebar-user-avatar">S</div>
          <span className="sidebar-user-name">Пользователь</span>
          <IconButton icon="settings" label="Настройки" className="sidebar-settings-btn no-drag" />
        </div>
      </div>
    </motion.aside>
  )
}
