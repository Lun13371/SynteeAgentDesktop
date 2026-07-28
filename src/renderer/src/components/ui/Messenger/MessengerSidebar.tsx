import { useState } from 'react'
import Identicon from '../Identicon/Identicon'
import AppIcon from '../AppIcon/AppIcon'
import { useMessengerStore, type ConversationResponse, GLOBAL_CHANNEL } from '../../../store/messenger.store'
import './MessengerSidebar.css'

interface Props {
  onOpenFriends: () => void
}

export default function MessengerSidebar({ onOpenFriends }: Props) {
  const conversations = useMessengerStore(s => s.conversations)
  const activeId = useMessengerStore(s => s.activeConversationId)
  const openConversation = useMessengerStore(s => s.openConversation)
  const openGlobal = useMessengerStore(s => s.openGlobal)
  const globalUnread = useMessengerStore(s => s.globalUnread)
  const presence = useMessengerStore(s => s.presence)
  const [filter, setFilter] = useState('')

  const filtered = filter.trim()
    ? conversations.filter(c =>
      (c.other_user.display_name || c.other_user.email).toLowerCase().includes(filter.toLowerCase()))
    : conversations

  const totalUnread = conversations.reduce((n, c) => n + (c.unread_count || 0), 0)
  const pendingRequests = useMessengerStore(s => s.friendRequests.filter(r => r.direction === 'incoming').length)

  return (
    <div className="msgr-sidebar">
      <div className="msgr-sidebar-header">
        <div className="msgr-search">
          <AppIcon name="search" size="sm" tone="muted" />
          <input
            type="text"
            placeholder="Поиск диалогов…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
        </div>
        <button className="msgr-icon-btn" onClick={onOpenFriends} title="Друзья и заявки">
          <AppIcon name="users" size="sm" />
          {(pendingRequests > 0 || totalUnread > 0) && (
            <span className="msgr-icon-btn-badge">{pendingRequests || totalUnread}</span>
          )}
        </button>
      </div>

      <div className="msgr-conv-list">
        <button
          className={`msgr-conv-row msgr-conv-row--lounge ${activeId === GLOBAL_CHANNEL ? 'msgr-conv-row--active' : ''}`}
          onClick={() => void openGlobal()}
        >
          <div className="msgr-conv-avatar">
            <div className="msgr-lounge-icon">
              <AppIcon name="messageSquare" size="sm" tone="accent" />
            </div>
          </div>
          <div className="msgr-conv-meta">
            <div className="msgr-conv-top">
              <span className="msgr-conv-name">Общий чат</span>
            </div>
            <div className="msgr-conv-bottom">
              <span className="msgr-conv-preview">Lounge — для всех пользователей</span>
              {globalUnread > 0 && (
                <span className="msgr-conv-unread">{globalUnread > 99 ? '99+' : globalUnread}</span>
              )}
            </div>
          </div>
        </button>

        {filtered.length === 0 && (
          <div className="msgr-empty">Нет диалогов. Добавьте друга, чтобы начать общение.</div>
        )}
        {filtered.map(c => (
          <ConversationRow
            key={c.id}
            conv={c}
            online={presence[c.other_user.id] ?? c.other_online}
            active={c.id === activeId}
            onOpen={() => openConversation(c.id)}
          />
        ))}
      </div>
    </div>
  )
}

function ConversationRow({
  conv, online, active, onOpen,
}: { conv: ConversationResponse; online: boolean; active: boolean; onOpen: () => void }) {
  const name = conv.other_user.display_name || conv.other_user.email
  const last = conv.last_message
  const preview = !last
    ? 'Нет сообщений'
    : last.deleted
      ? 'Сообщение удалено'
      : last.body
        ? (last.body.length > 40 ? last.body.slice(0, 40) + '…' : last.body)
        : last.has_attachment
          ? `📎 ${last.attachment_filename || 'Вложение'}`
          : 'Сообщение'
  return (
    <button className={`msgr-conv-row ${active ? 'msgr-conv-row--active' : ''}`} onClick={onOpen}>
      <div className="msgr-conv-avatar">
        <Identicon seed={conv.other_user.id || conv.other_user.email} src={conv.other_user.avatar_url} size={36} alt={name} />
        <span className={`msgr-online-dot ${online ? 'msgr-online-dot--on' : ''}`} />
      </div>
      <div className="msgr-conv-meta">
        <div className="msgr-conv-top">
          <span className="msgr-conv-name">{name}</span>
          {conv.last_message_at && (
            <span className="msgr-conv-time">{formatTime(conv.last_message_at)}</span>
          )}
        </div>
        <div className="msgr-conv-bottom">
          <span className="msgr-conv-preview">{preview}</span>
          {conv.unread_count > 0 && (
            <span className="msgr-conv-unread">{conv.unread_count > 99 ? '99+' : conv.unread_count}</span>
          )}
        </div>
      </div>
    </button>
  )
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    const now = new Date()
    const sameDay = d.toDateString() === now.toDateString()
    if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' })
  } catch {
    return ''
  }
}
