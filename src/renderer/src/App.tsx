import { useEffect, useState } from 'react'
import { useUIStore } from './store/ui.store'
import ChatPage from './pages/Chat/ChatPage'
import OverlayPage from './pages/Overlay/OverlayPage'
import './pages/Overlay/OverlayPage.css'
import VoicePage from './pages/Voice/VoicePage'
import './pages/Voice/VoicePage.css'
import SpotlightPage from './pages/Spotlight/SpotlightPage'
import './pages/Spotlight/SpotlightPage.css'
import SettingsPage from './pages/Settings/SettingsPage'
import './pages/Settings/SettingsPage.css'
import TitleBar from './components/layout/TitleBar/TitleBar'
import ToastContainer from './components/ui/Toast/Toast'
import AnimatedBackground from './components/ui/AnimatedBackground/AnimatedBackground'
import Sidebar from './components/layout/Sidebar/Sidebar'

type Route = 'chat' | 'overlay' | 'voice' | 'spotlight'
type MainPage = 'chat' | 'settings'

function getRoute(): Route {
  const hash = window.location.hash.replace('#/', '')
  if (hash === 'overlay') return 'overlay'
  if (hash === 'voice') return 'voice'
  if (hash === 'spotlight') return 'spotlight'
  return 'chat'
}

export default function App() {
  const [route, setRoute] = useState<Route>(getRoute())
  const [mainPage, setMainPage] = useState<MainPage>('chat')
  const { theme } = useUIStore()

  useEffect(() => {
    const onHash = () => setRoute(getRoute())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Оверлей, голос, spotlight — отдельные окна
  if (route === 'overlay') return <OverlayPage />
  if (route === 'voice') return <VoicePage />
  if (route === 'spotlight') return <SpotlightPage />

  // Главное окно — chat или settings внутри одного layout
  return (
    <div className="app-root">
      <AnimatedBackground />
      <TitleBar onSettingsClick={() => setMainPage(p => p === 'settings' ? 'chat' : 'settings')} />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative', zIndex: 1 }}>
        {mainPage === 'chat' && <ChatPage embedded />}
        {mainPage === 'settings' && <SettingsPage />}
      </div>
      <ToastContainer />
    </div>
  )
}
