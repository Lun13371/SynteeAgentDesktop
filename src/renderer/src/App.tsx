import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from './store/ui.store'
import { initExtensionsPushEvents, useExtensionsStore } from './store/extensions.store'
import { setUiSoundsFlag } from './utils/sounds'
import { useChatRunSubscription } from './hooks/useChatRunSubscription'
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
import RightPanelHost from './components/ui/RightPanel/RightPanelHost'
import AgentConfirmDialog from './components/ui/AgentConfirmDialog/AgentConfirmDialog'
import BottomDock from './components/ui/BottomDock/BottomDock'
import './components/ui/RightPanel/RightPanel.css'

type Route = 'chat' | 'overlay' | 'voice' | 'spotlight'
type MainPage = 'chat' | 'settings' | 'memory'

function getRoute(): Route {
  const hash = window.location.hash.replace('#/', '')
  if (hash === 'overlay') return 'overlay'
  if (hash === 'voice') return 'voice'
  if (hash === 'spotlight') return 'spotlight'
  return 'chat'
}

// Доступные UI-шрифты. Только те, что подключены локально в fonts.css.
// Моноширинный (--font-mono) не настраивается пользователем — всегда
// JetBrains Mono для кода/путей.
const UI_FONTS: Record<string, string> = {
  'Inter': "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  'system': '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
}

// Применяет выбранный шрифт к CSS-переменной --font-family на :root.
// Раньше select в Settings сохранял значение, но не менял реальный
// шрифт — CSS-переменная оставалась дефолтной.
export function applyFontToDOM(fontId: string) {
  const stack = UI_FONTS[fontId] ?? UI_FONTS['Inter']
  document.documentElement.style.setProperty('--font-family', stack)
}

// Применяет кастомный accent цвет поверх темы. Меняет --accent и
// связанные переменные (--accent-hover, --accent-subtle, --border,
// --border-strong, --overlay-4/5/6, --glass-bg). Если color пустой —
// сбрасывает к теме (удаляет inline overrides).
export function applyAccentToDOM(color?: string) {
  const root = document.documentElement
  if (!color) {
    // Сброс к теме — удаляем все inline overrides
    root.style.removeProperty('--accent')
    root.style.removeProperty('--accent-hover')
    root.style.removeProperty('--accent-subtle')
    root.style.removeProperty('--accent-rgb')
    return
  }
  // Парсим hex → rgb components для rgba-конструкций
  const hex = color.replace('#', '')
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  if (isNaN(r) || isNaN(g) || isNaN(b)) return
  root.style.setProperty('--accent', color)
  root.style.setProperty('--accent-hover', `rgba(${r}, ${g}, ${b}, 0.85)`)
  root.style.setProperty('--accent-subtle', `rgba(${r}, ${g}, ${b}, 0.1)`)
  root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`)
}

export default function App() {
  const [route, setRoute] = useState<Route>(getRoute())
  const [mainPage, setMainPage] = useState<MainPage>('chat')
  const [onboarded, setOnboarded] = useState<boolean | null>(null)
  // useShallow — подписка только на нужные поля. agentPanelOpen и focusAgentId
  // убраны в RightPanelHost — при open/close панели App НЕ ре-рендерится.
  const { theme, setTheme, setBgStyle, setMsgAnim, setAccentColor, setAnimatedBackground,
    setAvatarStyle, setShowTime, setUserMarkdown, setUiSounds, setSendEffect,
    setAgentPanelOpen } = useUIStore(useShallow(s => ({
      theme: s.theme,
      setTheme: s.setTheme,
      setBgStyle: s.setBgStyle,
      setMsgAnim: s.setMsgAnim,
      setAccentColor: s.setAccentColor,
      setAnimatedBackground: s.setAnimatedBackground,
      setAvatarStyle: s.setAvatarStyle,
      setShowTime: s.setShowTime,
      setUserMarkdown: s.setUserMarkdown,
      setUiSounds: s.setUiSounds,
      setSendEffect: s.setSendEffect,
      setAgentPanelOpen: s.setAgentPanelOpen,
    })))

  // Глобальная IPC-подписка на события чатов (токены, шаги, статусы).
  // Монтируется один раз — пишет в Zustand store по chatId, чтобы
  // параллельные чаты каждый имели свой LiveState.
  useChatRunSubscription()

  // Загружаем визуальные настройки из electron-store при старте
  useEffect(() => {
    const applyVisualSettings = async () => {
      try {
        const [theme, bgStyle, msgAnim, accentColor, animatedBg,
          avatarStyle, showTime, userMarkdown, uiSounds, sendEffect,
          fontFamily, savedPanelWidth, savedPanelOpen] = await Promise.all([
          window.syntee.settings.get('theme'),
          window.syntee.settings.get('bgStyle'),
          window.syntee.settings.get('msgAnim'),
          window.syntee.settings.get('accentColor'),
          window.syntee.settings.get('animatedBackground'),
          window.syntee.settings.get('avatarStyle'),
          window.syntee.settings.get('showTime'),
          window.syntee.settings.get('userMarkdown'),
          window.syntee.settings.get('uiSounds'),
          window.syntee.settings.get('sendEffect'),
          window.syntee.settings.get('fontFamily'),
          window.syntee.settings.get('agentPanelWidth'),
          window.syntee.settings.get('agentPanelOpen'),
        ])
        if (theme) setTheme(theme as any)
        if (bgStyle) setBgStyle(bgStyle as string)
        if (msgAnim) setMsgAnim(msgAnim as string)
        if (accentColor) setAccentColor(accentColor as string)
        if (animatedBg !== undefined && animatedBg !== null) setAnimatedBackground(animatedBg as boolean)
        if (avatarStyle) setAvatarStyle(avatarStyle as any)
        if (showTime) setShowTime(showTime as any)
        if (userMarkdown !== undefined && userMarkdown !== null) setUserMarkdown(userMarkdown as boolean)
        if (uiSounds !== undefined && uiSounds !== null) {
          setUiSounds(uiSounds as boolean)
          setUiSoundsFlag(uiSounds as boolean)
        }
        if (sendEffect !== undefined && sendEffect !== null) setSendEffect(sendEffect as boolean)
        // Восстанавливаем ширину и состояние правой панели после рестарта.
        // setAgentPanelWidth сам клампит по динамическому MAX (зависит от окна).
        if (typeof savedPanelWidth === 'number' && savedPanelWidth > 0) {
          useUIStore.getState().setAgentPanelWidth(savedPanelWidth)
        }
        if (typeof savedPanelOpen === 'boolean') setAgentPanelOpen(savedPanelOpen)
        // Применяем шрифт к CSS-переменной. Раньше настройка вообще
        // не работала — значения сохранялись, но --font-family в :root
        // оставался 'Inter' и select не менял реальный шрифт.
        if (fontFamily) applyFontToDOM(fontFamily as string)
        // Кастомный accent применяется поверх темы.
        if (accentColor) applyAccentToDOM(accentColor as string)
      } catch { /* ok */ }
    }
    applyVisualSettings()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // При ресайзе окна — ре-клампим ширину панели. Если окно сузили,
  // сохранённая ширина может превышать новый динамический MAX (70% окна).
  // settings.set НЕ делаем — сохранение идёт через onResizeEnd в RightPanel
  // (дебаунс 500мс), здесь только быстрая Zustand-мутация для визуального отклика.
  useEffect(() => {
    const onResize = () => {
      const st = useUIStore.getState()
      const current = st.agentPanelWidth
      const maxW = Math.min(Math.floor(window.innerWidth * 0.7), 1600)
      if (current > maxW) {
        st.setAgentPanelWidth(maxW)
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const onHash = () => setRoute(getRoute())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Синхронизируем флаг звуков при изменении в store.
  // Селектор — без него useUIStore() подписывается на ВЕСЬ store,
  // и App ре-рендерится при любом изменении (agentPanelOpen, agentPanelWidth и т.д.)
  const uiSounds = useUIStore(s => s.uiSounds)
  useEffect(() => { setUiSoundsFlag(uiSounds) }, [uiSounds])

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

  // Подписка на push-события MCP (статус подключения, обновление тулов).
  // Один раз за сессию — обновляет extensions.store в реальном времени.
  useEffect(() => {
    const cleanup = initExtensionsPushEvents()
    // Предзагрузка mcpServers при старте — иначе бейдж MCP не покажется,
    // пока пользователь не откроет ExtensionsPopover хотя бы раз.
    // warmupGlobalServers в main уже запустил подключение в фоне; здесь мы
    // подтягиваем актуальный список серверов (с runtime-статусом) в стор.
    useExtensionsStore.getState().loadMcpServers()
    // Предзагрузка skills — аналогично MCP, чтобы бейдж и список были
    // доступны сразу при старте, без необходимости открывать ExtensionsPopover.
    useExtensionsStore.getState().loadSkills()
    return cleanup
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
        onAgentClick={() => {
          const st = useUIStore.getState()
          const next = !st.agentPanelOpen
          st.setAgentPanelOpen(next)
          window.syntee.settings.set('agentPanelOpen', next)
        }}
        onMemoryClick={() => setMainPage(p => p === 'memory' ? 'chat' : 'memory')}
      />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative', zIndex: 1 }}>
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
          {mainPage === 'chat' && <ChatPage embedded />}
          {mainPage === 'settings' && <SettingsPage />}
          {mainPage === 'memory' && <MemoryPage />}
        </div>
        <RightPanelHost />
      </div>
      <BottomDock />
      <ToastContainer />
      <AgentConfirmDialog />
    </div>
  )
}
