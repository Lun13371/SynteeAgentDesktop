import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import Identicon from '../Identicon/Identicon'
import AppIcon from '../AppIcon/AppIcon'
import { useMessengerStore } from '../../../store/messenger.store'
import './FriendsModal.css'

interface Props {
  open: boolean
  onClose: () => void
}

export default function FriendsModal({ open, onClose }: Props) {
  const friends = useMessengerStore(s => s.friends)
  const requests = useMessengerStore(s => s.friendRequests)
  const sendFriendRequest = useMessengerStore(s => s.sendFriendRequest)
  const acceptFriendRequest = useMessengerStore(s => s.acceptFriendRequest)
  const declineFriendRequest = useMessengerStore(s => s.declineFriendRequest)
  const unfriend = useMessengerStore(s => s.unfriend)
  const blockUser = useMessengerStore(s => s.blockUser)
  const startConversationWith = useMessengerStore(s => s.startConversationWith)

  const [email, setEmail] = useState('')
  const [searchResults, setSearchResults] = useState<{ id: string; email: string; display_name?: string | null; avatar_url?: string | null }[]>([])
  const [searching, setSearching] = useState(false)

  const incoming = requests.filter(r => r.direction === 'incoming')
  const outgoing = requests.filter(r => r.direction === 'outgoing')

  const runSearch = async (q: string) => {
    setEmail(q)
    if (q.trim().length < 3) { setSearchResults([]); return }
    setSearching(true)
    try {
      const res = await window.syntee.messenger.friends.search(q)
      setSearchResults(res)
    } catch { /* ignore */ }
    finally { setSearching(false) }
  }

  const handleAdd = async (addr: string) => {
    await sendFriendRequest(addr)
    setEmail('')
    setSearchResults([])
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="friends-modal-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="friends-modal"
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ type: 'spring', stiffness: 320, damping: 28 }}
            onClick={e => e.stopPropagation()}
          >
            <div className="friends-modal-header">
              <h2>Друзья</h2>
              <button className="friends-modal-close" onClick={onClose} aria-label="Закрыть">✕</button>
            </div>

            <div className="friends-modal-body">
              <section className="friends-section">
                <h3>Добавить друга</h3>
                <div className="friends-add">
                  <input
                    type="text"
                    placeholder="Введите email…"
                    value={email}
                    onChange={e => void runSearch(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && email.trim()) void handleAdd(email.trim()) }}
                  />
                  <button className="friends-add-btn" onClick={() => email.trim() && handleAdd(email.trim())} disabled={!email.trim()}>
                    <AppIcon name="userPlus" size="sm" /> Отправить
                  </button>
                </div>
                {searching && <div className="friends-hint">Поиск…</div>}
                {!searching && searchResults.length > 0 && (
                  <div className="friends-search-results">
                    {searchResults.map(u => (
                      <div key={u.id} className="friends-user-row">
                        <Identicon seed={u.id || u.email} src={u.avatar_url} size={28} alt={u.email} />
                        <div className="friends-user-info">
                          <span className="friends-user-name">{u.display_name || u.email}</span>
                          {u.display_name && <span className="friends-user-email">{u.email}</span>}
                        </div>
                        <button className="friends-action-btn" onClick={() => void handleAdd(u.email)}>
                          <AppIcon name="userPlus" size="xs" /> Добавить
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {incoming.length > 0 && (
                <section className="friends-section">
                  <h3>Входящие заявки ({incoming.length})</h3>
                  {incoming.map(r => (
                    <div key={r.id} className="friends-user-row">
                      <Identicon seed={r.user.id || r.user.email} src={r.user.avatar_url} size={28} alt={r.user.email} />
                      <div className="friends-user-info">
                        <span className="friends-user-name">{r.user.display_name || r.user.email}</span>
                        {r.user.display_name && <span className="friends-user-email">{r.user.email}</span>}
                      </div>
                      <div className="friends-action-group">
                        <button className="friends-action-btn friends-action-btn--primary" onClick={() => void acceptFriendRequest(r.user.id)}>
                          <AppIcon name="check" size="xs" /> Принять
                        </button>
                        <button className="friends-action-btn" onClick={() => void declineFriendRequest(r.user.id)}>
                          <AppIcon name="x" size="xs" /> Отклонить
                        </button>
                      </div>
                    </div>
                  ))}
                </section>
              )}

              {outgoing.length > 0 && (
                <section className="friends-section">
                  <h3>Исходящие заявки ({outgoing.length})</h3>
                  {outgoing.map(r => (
                    <div key={r.id} className="friends-user-row">
                      <Identicon seed={r.user.id || r.user.email} src={r.user.avatar_url} size={28} alt={r.user.email} />
                      <div className="friends-user-info">
                        <span className="friends-user-name">{r.user.display_name || r.user.email}</span>
                      </div>
                      <span className="friends-hint">Ожидает подтверждения</span>
                    </div>
                  ))}
                </section>
              )}

              <section className="friends-section">
                <h3>Друзья ({friends.length})</h3>
                {friends.length === 0 && <div className="friends-hint">Список друзей пуст.</div>}
                {friends.map(u => (
                  <div key={u.id} className="friends-user-row">
                    <Identicon seed={u.id || u.email} src={u.avatar_url} size={28} alt={u.email} />
                    <div className="friends-user-info">
                      <span className="friends-user-name">{u.display_name || u.email}</span>
                      {u.display_name && <span className="friends-user-email">{u.email}</span>}
                    </div>
                    <div className="friends-action-group">
                      <button className="friends-action-btn friends-action-btn--primary" onClick={async () => { const id = await startConversationWith(u.id); if (id) onClose() }}>
                        <AppIcon name="messageSquare" size="xs" /> Написать
                      </button>
                      <button className="friends-action-btn" title="Удалить из друзей" onClick={() => void unfriend(u.id)}>
                        <AppIcon name="x" size="xs" />
                      </button>
                      <button className="friends-action-btn friends-action-btn--danger" title="Заблокировать" onClick={() => void blockUser(u.id)}>
                        <AppIcon name="ban" size="xs" />
                      </button>
                    </div>
                  </div>
                ))}
              </section>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
