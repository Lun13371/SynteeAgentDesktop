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

  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<{ id: string; email: string; username?: string | null; display_name?: string | null; avatar_url?: string | null }[]>([])
  const [searching, setSearching] = useState(false)

  const incoming = requests.filter(r => r.direction === 'incoming')
  const outgoing = requests.filter(r => r.direction === 'outgoing')

  const runSearch = async (q: string) => {
    setQuery(q)
    if (q.trim().replace(/^@/, '').length < 3) { setSearchResults([]); return }
    setSearching(true)
    try {
      const res = await window.syntee.messenger.friends.search(q)
      setSearchResults(res)
    } catch { /* ignore */ }
    finally { setSearching(false) }
  }

  const handleAdd = async (addr: string) => {
    await sendFriendRequest(addr.replace(/^@/, ''))
    setQuery('')
    setSearchResults([])
  }

  const labelOf = (u: { username?: string | null; display_name?: string | null; email: string }) =>
    u.username ? `@${u.username}` : u.display_name || u.email
  const secondaryOf = (u: { username?: string | null; display_name?: string | null; email: string }) =>
    u.username ? (u.display_name || u.email) : null

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
                    placeholder="Введите @username…"
                    value={query}
                    onChange={e => void runSearch(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && query.trim()) void handleAdd(query.trim()) }}
                  />
                  <button className="friends-add-btn" onClick={() => query.trim() && handleAdd(query.trim())} disabled={!query.trim()}>
                    <AppIcon name="userPlus" size="sm" /> Отправить
                  </button>
                </div>
                {searching && <div className="friends-hint">Поиск…</div>}
                {!searching && searchResults.length > 0 && (
                  <div className="friends-search-results">
                    {searchResults.map(u => (
                      <div key={u.id} className="friends-user-row">
                        <Identicon seed={u.id || u.email} src={u.avatar_url} size={28} alt={labelOf(u)} />
                        <div className="friends-user-info">
                          <span className="friends-user-name">{labelOf(u)}</span>
                          {secondaryOf(u) && <span className="friends-user-email">{secondaryOf(u)}</span>}
                        </div>
                        <button className="friends-action-btn" onClick={() => void handleAdd(u.username ?? u.email)}>
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
                      <Identicon seed={r.user.id || r.user.email} src={r.user.avatar_url} size={28} alt={labelOf(r.user)} />
                      <div className="friends-user-info">
                        <span className="friends-user-name">{labelOf(r.user)}</span>
                        {secondaryOf(r.user) && <span className="friends-user-email">{secondaryOf(r.user)}</span>}
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
                      <Identicon seed={r.user.id || r.user.email} src={r.user.avatar_url} size={28} alt={labelOf(r.user)} />
                      <div className="friends-user-info">
                        <span className="friends-user-name">{labelOf(r.user)}</span>
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
                    <Identicon seed={u.id || u.email} src={u.avatar_url} size={28} alt={labelOf(u)} />
                    <div className="friends-user-info">
                      <span className="friends-user-name">{labelOf(u)}</span>
                      {secondaryOf(u) && <span className="friends-user-email">{secondaryOf(u)}</span>}
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
