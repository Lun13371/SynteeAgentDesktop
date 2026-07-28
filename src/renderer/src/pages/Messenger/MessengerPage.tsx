import { useState } from 'react'
import MessengerSidebar from '../../components/ui/Messenger/MessengerSidebar'
import MessengerConversation from '../../components/ui/Messenger/MessengerConversation'
import FriendsModal from '../../components/ui/Messenger/FriendsModal'
import { useMessengerStore } from '../../store/messenger.store'

export default function MessengerPage() {
  const [friendsOpen, setFriendsOpen] = useState(false)
  const status = useMessengerStore(s => s.status)

  return (
    <div className="msgr-page">
      <MessengerSidebar onOpenFriends={() => setFriendsOpen(true)} />
      <div className="msgr-page-main">
        <div className={`msgr-conn-status msgr-conn-status--${status}`}>
          <span className="msgr-conn-status-dot" />
          {status === 'connected' ? 'Подключено' : status === 'connecting' ? 'Подключение…' : 'Отключено'}
        </div>
        <MessengerConversation />
      </div>
      <FriendsModal open={friendsOpen} onClose={() => setFriendsOpen(false)} />
    </div>
  )
}
