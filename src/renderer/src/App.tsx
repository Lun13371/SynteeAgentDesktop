import { useEffect, useState } from 'react'
import { useUIStore } from './store/ui.store'
import ChatPage from './pages/Chat/ChatPage'
import OverlayPage from './pages/Overlay/OverlayPage'
import './pages/Overlay/OverlayPage.css'
import VoicePage from './pages/Voice/VoicePage'
import SpotlightPage from './pages/Spotlight/SpotlightPage'

type Route = 'chat' | 'overlay' | 'voice' | 'spotlight'

function getRoute(): Route {
  const hash = window.location.hash.replace('#/', '')
  if (hash === 'overlay') return 'overlay'
  if (hash === 'voice') return 'voice'
  if (hash === 'spotlight') return 'spotlight'
  return 'chat'
}

export default function App() {
  const [route, setRoute] = useState<Route>(getRoute())
  const { theme } = useUIStore()

  useEffect(() => {
    const onHash = () => setRoute(getRoute())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Применяем тему
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  return (
    <div className="app-root">
      {route === 'chat' && <ChatPage />}
      {route === 'overlay' && <OverlayPage />}
      {route === 'voice' && <VoicePage />}
      {route === 'spotlight' && <SpotlightPage />}
    </div>
  )
}
