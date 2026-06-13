import { useEffect, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
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
import MemoryPage from './pages/Memory/MemoryPage'
import './pages/Memory/MemoryPage.css'
import OnboardingPage from './pages/Onboarding/OnboardingPage'
import './pages/Onboarding/OnboardingPage.css'
import TitleBar from './components/layout/TitleBar/TitleBar'
import ToastContainer from './components/ui/Toast/Toast'
import AnimatedBackground from './components/ui/AnimatedBackground/AnimatedBackground'
import AgentPanel from './components/ui/AgentPanel/AgentPanel'
import AgentConfirmDialog from './components/ui/AgentConfirmDialog/AgentConfirmDialog'
import './components/ui/AgentPanel/AgentPanel.css'

type Route = 'chat' | 'overlay' | 'voice' | 'spotlight'
type MainPage = 'chat' | 'settings' | 'memory'

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
  const [showAgent, setShowAgent] = useState(false)
  const [focusAgentId, setFocusAgentId] = useState<string | null>(null)
  const [onboarded, setOnboarded] = useState<boolean | null>(null)
  const { theme } = useUIStore()

  useEffect(() => {
    const onHash = () => setRoute(getRoute())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Слушаем open-agent-panel от AgentCardLive
  useEffect(() => {
    const handler = (e: Event) => {
      const agentId = (e as CustomEvent<{ agentId: string }>).detail?.agentId ?? null
      setFocusAgentId(agentId)
      setShowAgent(true)
    }
    window.addEventListener('open-agent-panel', handler)
    return () => window.removeEventListener('open-agent-panel', handler)
  }, [])

  // Проверяем первый запуск
  useEffect(() => {
    const check = async () => {
      try {
        const done = await window.syntee.settings.get('firstRunComplete')
        setOnboarded(!!done)
      } catch {
        setOnboarded(false)
      }
    }
    check()
  }, [])

  // Оверлей, голос, spotlight — отдельные окна
  if (route === 'overlay') return <OverlayPage />
  if (route === 'voice') return <VoicePage />
  if (route === 'spotlight') return <SpotlightPage />

  // Пока проверяем — ничего не показываем
  if (onboarded === null) return null

  // Первый запуск — онбординг
  if (!onboarded) return <OnboardingPage onDone={() => setOnboarded(true)} />

  // Главное окно
  return (
    <div className="app-root">
      <AnimatedBackground />
      <TitleBar
        onSettingsClick={() => setMainPage(p => p === 'settings' ? 'chat' : 'settings')}
        onAgentClick={() => { setFocusAgentId(null); setShowAgent(p => !p) }}
        onMemoryClick={() => setMainPage(p => p === 'memory' ? 'chat' : 'memory')}
      />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative', zIndex: 1 }}>
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
          {mainPage === 'chat' && <ChatPage embedded />}
          {mainPage === 'settings' && <SettingsPage />}
          {mainPage === 'memory' && <MemoryPage />}
        </div>
        <AnimatePresence>
          {showAgent && (
            <AgentPanel
              onClose={() => { setShowAgent(false); setFocusAgentId(null) }}
              focusAgentId={focusAgentId}
            />
          )}
        </AnimatePresence>
      </div>
      <ToastContainer />
      <AgentConfirmDialog />
    </div>
  )
}
