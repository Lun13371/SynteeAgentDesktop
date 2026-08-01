import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Search, Send, X } from 'lucide-react'
import Identicon from '../Identicon/Identicon'
import { useMessengerStore } from '../../../store/messenger.store'
import { useAuthStore } from '../../../store/auth.store'
import { useToast } from '../Toast/Toast'
import type { UserBrief } from '../../../store/messenger.store'
import './ShareChatModal.css'

interface Props {
  open: boolean
  onClose: () => void
  chatId: string | null
  chatTitle: string
}

/**
 * Modal for picking a friend to share the current AI chat with.
 * Loads the friend list from the messenger store; on confirm, calls the
 * `messenger.shares.shareChat` IPC handler which packs the chat snapshot
 * and POSTs it to the gateway (which delivers a `chat_share` DM).
 */
export default function ShareChatModal({ open, onClose, chatId, chatTitle }: Props) {
  const friends = useMessengerStore((s) => s.friends)
  const loadFriends = useMessengerStore((s) => s.loadFriends)
  const me = useAuthStore((s) => s.user)
  const [filter, setFilter] = useState('')
  const [sending, setSending] = useState<string | null>(null)
  const [sendingGlobal, setSendingGlobal] = useState(false)

  useEffect(() => {
    if (open) void loadFriends()
  }, [open, loadFriends])

  const friendsExceptMe = me ? friends.filter((f) => f.id !== me.id) : friends
  const filtered = filter.trim()
    ? friendsExceptMe.filter((f) => (f.display_name || f.email).toLowerCase().includes(filter.toLowerCase()))
    : friendsExceptMe

  const handleShare = async (friend: UserBrief) => {
    if (!chatId) return
    setSending(friend.id)
    try {
      const res = await window.syntee.messenger.shares.shareChat(chatId, friend.id)
      if ('error' in res) {
        useToast.getState().add(res.error, 'error')
      } else {
        useToast.getState().add(`Чат «${chatTitle}» отправлен`, 'success')
        onClose()
      }
    } finally {
      setSending(null)
    }
  }

  const handleShareGlobal = async () => {
    if (!chatId) return
    setSendingGlobal(true)
    try {
      const res = await window.syntee.messenger.global.shareChat(chatId)
      if ('error' in res) {
        useToast.getState().add(res.error, 'error')
      } else {
        useToast.getState().add(`Чат «${chatTitle}» опубликован в общем чате`, 'success')
        onClose()
      }
    } finally {
      setSendingGlobal(false)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="share-chat-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="share-chat-modal"
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ type: 'spring', stiffness: 320, damping: 28 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="share-chat-header">
              <div>
                <h2>Поделиться чатом</h2>
                <p className="share-chat-subtitle">«{chatTitle}»</p>
              </div>
              <button className="share-chat-close" onClick={onClose} aria-label="Закрыть">
                <X size={16} />
              </button>
            </div>

            <div className="share-chat-search">
              <Search size={14} className="share-chat-search-icon" />
              <input
                type="text"
                placeholder="Поиск друга…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>

            <div className="share-chat-list">
              <button
                className="share-chat-global-btn"
                disabled={sendingGlobal}
                onClick={() => void handleShareGlobal()}
              >
                <div className="share-chat-global-icon">
                  <Send size={14} />
                </div>
                <div className="share-chat-global-info">
                  <span className="share-chat-global-name">Общий чат (Lounge)</span>
                  <span className="share-chat-global-desc">Опубликовать для всех пользователей</span>
                </div>
                {sendingGlobal && <span className="share-chat-global-spinner">…</span>}
              </button>

              <div className="share-chat-divider" />

              {filtered.length === 0 && (
                <div className="share-chat-empty">
                  {friendsExceptMe.length === 0
                    ? 'Список друзей пуст. Добавьте друга в мессенджере.'
                    : 'Никто не найден.'}
                </div>
              )}
              {filtered.map((f) => (
                <div key={f.id} className="share-chat-friend">
                  <Identicon seed={f.id || f.email} src={f.avatar_url} size={32} alt={f.email} />
                  <div className="share-chat-friend-info">
                    <span className="share-chat-friend-name">{f.display_name || f.email}</span>
                    {f.display_name && <span className="share-chat-friend-email">{f.email}</span>}
                  </div>
                  <button
                    className="share-chat-send"
                    disabled={sending === f.id}
                    onClick={() => void handleShare(f)}
                    title="Отправить"
                  >
                    <Send size={14} />
                  </button>
                </div>
              ))}
            </div>

            <p className="share-chat-note">
              Получатель увидит чат в мессенджере и сможет импортировать его к себе как копию.
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
