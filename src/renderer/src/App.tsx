import { useEffect, useState } from 'react'
import { useUIStore } from './store/ui.store'
import { initExtensionsPushEvents, useExtensionsStore } from './store/extensions.store'
import { setUiSoundsFlag } from './utils/sounds'
import { useChatRunSubscription } from './hooks/useChatRunSubscription'
import { useAuthStore } from './store/auth.store'
import { useNavStore } from './store/nav.store'
import {
  useGatewayModelsStore,
  startGatewayStatusPolling,
} from './store/gatewayModels.store'
import { useBillingStore } from './store/billing.store'
import { autoAssignGatewayModels, markAutoAssignDone, isAutoAssignDone } from './store/autoAssign'
import { contrastText, withAlpha, hexToRgb, hslToHex } from './utils/colorUtils'
import { startThemeScheduler } from './utils/themeScheduler'
import type { CustomTheme } from '../../shared/types'
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
import LoginScreen from './pages/Login/LoginScreen'
import './pages/Login/LoginScreen.css'
import TitleBar from './components/layout/TitleBar/TitleBar'
import ToastContainer from './components/ui/Toast/Toast'
import AnimatedBackground from './components/ui/AnimatedBackground/AnimatedBackground'
import RightPanelHost from './components/ui/RightPanel/RightPanelHost'
import AgentConfirmDialog from './components/ui/AgentConfirmDialog/AgentConfirmDialog'
import QuestionPanel from './components/ui/QuestionPanel/QuestionPanel'
import BottomDock from './components/ui/BottomDock/BottomDock'
import './components/ui/RightPanel/RightPanel.css'

type Route = 'chat' | 'overlay' | 'voice' | 'spotlight'

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
    root.style.removeProperty('--accent')
    root.style.removeProperty('--accent-hover')
    root.style.removeProperty('--accent-subtle')
    root.style.removeProperty('--accent-rgb')
    root.style.removeProperty('--on-accent')
    root.style.removeProperty('--on-accent-strong')
    root.style.removeProperty('--on-accent-muted')
    return
  }
  const hex = color.replace('#', '')
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  if (isNaN(r) || isNaN(g) || isNaN(b)) return
  root.style.setProperty('--accent', color)
  root.style.setProperty('--accent-hover', `rgba(${r}, ${g}, ${b}, 0.85)`)
  root.style.setProperty('--accent-subtle', `rgba(${r}, ${g}, ${b}, 0.1)`)
  root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`)
  const onAccent = contrastText(color)
  root.style.setProperty('--on-accent', onAccent === '#000' ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.95)')
  root.style.setProperty('--on-accent-strong', onAccent)
  root.style.setProperty('--on-accent-muted', onAccent === '#000' ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.7)')
}

export function applyGlassToDOM(blur: number) {
  document.documentElement.style.setProperty('--glass-blur', `${blur}px`)
}

export function applyDensityToDOM(density: 'compact' | 'comfortable' | 'spacious') {
  document.documentElement.setAttribute('data-density', density)
}

export function applyGradientAccentToDOM(enabled: boolean, color2: string, angle: number, color1: string) {
  const root = document.documentElement
  if (!enabled) {
    root.style.removeProperty('--accent-gradient')
    root.style.setProperty('--accent-bg', 'var(--accent)')
    return
  }
  root.style.setProperty('--accent-gradient', `linear-gradient(${angle}deg, ${color1}, ${color2})`)
  root.style.setProperty('--accent-bg', `linear-gradient(${angle}deg, ${color1}, ${color2})`)
}

export function applyCustomThemeToDOM(theme: CustomTheme | null) {
  const root = document.documentElement
  const styleEl = document.getElementById('custom-theme-vars') as HTMLStyleElement | null
  if (!theme) {
    if (styleEl) styleEl.remove()
    root.removeAttribute('data-custom-theme')
    return
  }
  const c = theme.colors
  const accent = c.accent
  const accentRgb = hexToRgb(accent)
  const onAccent = contrastText(accent)
  const overlayRgb = theme.base === 'light' ? '31, 35, 40' : '255, 255, 255'
  const shadowRgb = theme.base === 'light'
    ? `${hexToRgb(c.bodyBg)!.r}, ${hexToRgb(c.bodyBg)!.g}, ${hexToRgb(c.bodyBg)!.b}`
    : '0, 0, 0'
  const accentRgbStr = accentRgb ? `${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}` : '255, 255, 255'
  const glassBg = theme.base === 'light'
    ? withAlpha('#ffffff', 0.7 * (theme.glass.opacity / 100))
    : withAlpha(accent, 0.05 * (theme.glass.opacity / 100))
  const css = `
[data-theme="custom"][data-custom-theme="${theme.id}"] {
  --body-bg: ${c.bodyBg};
  --bg-primary: ${c.bgPrimary};
  --bg-secondary: ${c.bgSecondary};
  --bg-tertiary: ${c.bgTertiary};
  --text-primary: ${c.textPrimary};
  --text-secondary: ${c.textSecondary};
  --text-muted: ${c.textMuted};
  --accent: ${accent};
  --accent-hover: ${withAlpha(accent, 0.85)};
  --accent-subtle: ${withAlpha(accent, 0.1)};
  --accent-rgb: ${accentRgbStr};
  --border: ${withAlpha(accent, 0.12)};
  --border-strong: ${withAlpha(accent, 0.25)};
  --sidebar-bg: ${c.sidebarBg};
  --shadow: 0 8px 32px rgba(${shadowRgb}, 0.5);
  --shadow-lg: 0 20px 60px rgba(${shadowRgb}, 0.7);
  --overlay-1: rgba(${overlayRgb}, 0.02);
  --overlay-2: rgba(${overlayRgb}, 0.04);
  --overlay-3: rgba(${overlayRgb}, 0.06);
  --overlay-4: rgba(${overlayRgb}, 0.08);
  --overlay-5: rgba(${overlayRgb}, 0.12);
  --overlay-6: rgba(${overlayRgb}, 0.16);
  --on-accent: ${onAccent === '#000' ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.95)'};
  --on-accent-strong: ${onAccent};
  --on-accent-muted: ${onAccent === '#000' ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.7)'};
  --glass-bg: ${glassBg};
  --glass-border: ${withAlpha(accent, 0.1)};
  --glass-blur: ${theme.glass.blur}px;
  --glass-saturate: ${theme.glass.saturate}%;
  --glass-highlight-1: ${theme.base === 'light' ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.06)'};
  --glass-highlight-2: ${withAlpha(accent, 0.03)};
  --shadow-rgb: ${shadowRgb};
  --overlay-rgb: ${overlayRgb};
}`.trim()
  if (styleEl) {
    styleEl.textContent = css
  } else {
    const el = document.createElement('style')
    el.id = 'custom-theme-vars'
    el.textContent = css
    document.head.appendChild(el)
  }
  root.setAttribute('data-custom-theme', theme.id)
}

export async function applyBgImageToDOM(bgImage: { src: string; blur: number; opacity: number; tint: string; tintStrength: number } | null) {
  const appRoot = document.querySelector('.app-root')
  document.getElementById('bg-image-layer')?.remove()
  document.getElementById('bg-image-tint')?.remove()
  if (!bgImage || !bgImage.src) return

  let url = bgImage.src
  if (bgImage.src.startsWith('bg-images://')) {
    const dataUrl = await window.syntee.bgImage.load(bgImage.src)
    if (!dataUrl) return
    url = dataUrl
  }

  const el = document.createElement('div')
  el.id = 'bg-image-layer'
  el.style.cssText = `
    position: absolute; inset: 0; z-index: 0; pointer-events: none;
    background-image: url(${url});
    background-size: cover; background-position: center;
    filter: blur(${bgImage.blur}px);
    opacity: ${bgImage.opacity / 100};
  `
  if (appRoot) {
    const first = appRoot.firstChild
    if (first) appRoot.insertBefore(el, first)
    else appRoot.appendChild(el)
  }
  else document.body.insertBefore(el, document.body.firstChild)
  if (bgImage.tintStrength > 0) {
    const ov = document.createElement('div')
    ov.id = 'bg-image-tint'
    ov.style.cssText = `
      position: absolute; inset: 0; z-index: 0; pointer-events: none;
      background: ${bgImage.tint};
      opacity: ${bgImage.tintStrength / 100};
    `
    if (appRoot) {
      const layer = document.getElementById('bg-image-layer')
      if (layer && layer.nextSibling) appRoot.insertBefore(ov, layer.nextSibling)
      else appRoot.appendChild(ov)
    }
    else document.body.insertBefore(ov, document.body.firstChild)
  }
}

let rainbowTimer: number | null = null
export function applyRainbowAccentToDOM(enabled: boolean) {
  if (rainbowTimer !== null) {
    clearInterval(rainbowTimer)
    rainbowTimer = null
  }
  if (!enabled) return
  let hue = 0
  rainbowTimer = window.setInterval(() => {
    hue = (hue + 2) % 360
    const c = hslToHex(hue, 75, 58)
    applyAccentToDOM(c)
  }, 60)
}

export default function App() {
  const [route, setRoute] = useState<Route>(getRoute())
  // authBoot: null — проверяем; 'login' — показать экран входа; 'app' — войдено/гость.
  const [authBoot, setAuthBoot] = useState<'login' | 'app' | null>(null)
  const mainPage = useNavStore(s => s.mainPage)
  const toggleMainPage = useNavStore(s => s.toggleMainPage)
  const openSettings = useNavStore(s => s.openSettings)
  // useShallow — подписка только на нужные поля.
  const theme = useUIStore(s => s.theme)

  const authUser = useAuthStore(s => s.user)
  const authLoad = useAuthStore(s => s.load)

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
          fontFamily, savedPanelWidth, savedPanelOpen,
          glassBlur, density, accentGradient, rainbowAccent, bgImage,
          customThemes, activeCustomThemeId, themeSchedule, recentAccents] = await Promise.all([
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
          window.syntee.settings.get('glassBlur'),
          window.syntee.settings.get('density'),
          window.syntee.settings.get('accentGradient'),
          window.syntee.settings.get('rainbowAccent'),
          window.syntee.settings.get('bgImage'),
          window.syntee.settings.get('customThemes'),
          window.syntee.settings.get('activeCustomThemeId'),
          window.syntee.settings.get('themeSchedule'),
          window.syntee.settings.get('recentAccents'),
        ])
        const st = useUIStore.getState()
        if (theme) st.setTheme(theme as any)
        if (bgStyle) st.setBgStyle(bgStyle as string)
        if (msgAnim) st.setMsgAnim(msgAnim as string)
        if (accentColor) st.setAccentColor(accentColor as string)
        if (animatedBg !== undefined && animatedBg !== null) st.setAnimatedBackground(animatedBg as boolean)
        if (avatarStyle) st.setAvatarStyle(avatarStyle as any)
        if (showTime) st.setShowTime(showTime as any)
        if (userMarkdown !== undefined && userMarkdown !== null) st.setUserMarkdown(userMarkdown as boolean)
        if (uiSounds !== undefined && uiSounds !== null) {
          st.setUiSounds(uiSounds as boolean)
          setUiSoundsFlag(uiSounds as boolean)
        }
        if (sendEffect !== undefined && sendEffect !== null) st.setSendEffect(sendEffect as boolean)
        if (typeof savedPanelWidth === 'number' && savedPanelWidth > 0) st.setAgentPanelWidth(savedPanelWidth)
        if (typeof savedPanelOpen === 'boolean') st.setAgentPanelOpen(savedPanelOpen)
        if (typeof glassBlur === 'number') st.setGlassBlur(glassBlur)
        if (density) st.setDensity(density as any)
        if (accentGradient) st.setAccentGradient(accentGradient as any)
        if (typeof rainbowAccent === 'boolean') st.setRainbowAccent(rainbowAccent)
        if (bgImage) st.setBgImage(bgImage as any)
        if (Array.isArray(customThemes)) st.setCustomThemes(customThemes as any)
        if (activeCustomThemeId !== undefined) st.setActiveCustomThemeId(activeCustomThemeId as any)
        if (themeSchedule) st.setThemeSchedule(themeSchedule as any)
        if (Array.isArray(recentAccents)) st.setRecentAccents(recentAccents as string[])

        if (fontFamily) applyFontToDOM(fontFamily as string)

        const currentTheme = useUIStore.getState().theme
        const themes = useUIStore.getState().customThemes
        const activeId = useUIStore.getState().activeCustomThemeId
        if (currentTheme === 'custom' && activeId) {
          const ct = themes.find(t => t.id === activeId)
          if (ct) applyCustomThemeToDOM(ct)
        }
        if (!rainbowAccent && accentColor) applyAccentToDOM(accentColor as string)
        if (typeof glassBlur === 'number') applyGlassToDOM(glassBlur)
        if (density) applyDensityToDOM(density as any)
        if (accentGradient) {
          const ag = accentGradient as any
          applyGradientAccentToDOM(ag.enabled, ag.color2, ag.angle, (accentColor as string) || '#ffffff')
        }
        if (bgImage) applyBgImageToDOM(bgImage as any)
        if (rainbowAccent) applyRainbowAccentToDOM(true)
      } catch { /* ok */ }
    }
    applyVisualSettings()
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
    if (theme === 'custom') {
      const st = useUIStore.getState()
      const ct = st.customThemes.find(t => t.id === st.activeCustomThemeId)
      if (ct) applyCustomThemeToDOM(ct)
    } else {
      applyCustomThemeToDOM(null)
    }
  }, [theme])

  const glassBlur = useUIStore(s => s.glassBlur)
  useEffect(() => { applyGlassToDOM(glassBlur) }, [glassBlur])

  const density = useUIStore(s => s.density)
  useEffect(() => { applyDensityToDOM(density) }, [density])

  const accentGradient = useUIStore(s => s.accentGradient)
  const accentColor = useUIStore(s => s.accentColor)
  useEffect(() => {
    applyGradientAccentToDOM(accentGradient.enabled, accentGradient.color2, accentGradient.angle, accentColor)
  }, [accentGradient, accentColor])

  const bgImage = useUIStore(s => s.bgImage)
  useEffect(() => { applyBgImageToDOM(bgImage) }, [bgImage])

  const customThemes = useUIStore(s => s.customThemes)
  const activeCustomThemeId = useUIStore(s => s.activeCustomThemeId)
  useEffect(() => {
    if (useUIStore.getState().theme === 'custom' && activeCustomThemeId) {
      const ct = customThemes.find(t => t.id === activeCustomThemeId)
      if (ct) applyCustomThemeToDOM(ct)
    }
  }, [customThemes, activeCustomThemeId])

  const rainbowAccent = useUIStore(s => s.rainbowAccent)
  useEffect(() => {
    if (rainbowAccent) {
      applyRainbowAccentToDOM(true)
    } else {
      applyRainbowAccentToDOM(false)
      applyAccentToDOM(useUIStore.getState().accentColor)
    }
  }, [rainbowAccent])

  useEffect(() => {
    return startThemeScheduler(
      () => useUIStore.getState().themeSchedule,
      () => useUIStore.getState().customThemes,
      (theme, custom) => {
        const st = useUIStore.getState()
        if (custom) {
          st.setCustomThemes(st.customThemes)
          st.setActiveCustomThemeId(custom.id)
          st.setTheme('custom')
          applyCustomThemeToDOM(custom)
          window.syntee.settings.set('activeCustomThemeId', custom.id)
          window.syntee.settings.set('theme', 'custom')
        } else {
          st.setTheme(theme as any)
          applyCustomThemeToDOM(null)
          window.syntee.settings.set('theme', theme)
        }
      }
    )
  }, [])

  // Синхронизируем флаг звуков при изменении в store.
  // Селектор — без него useUIStore() подписывается на ВЕСЬ store,
  // и App ре-рендерится при любом изменении (agentPanelOpen, agentPanelWidth и т.д.)
  const uiSounds = useUIStore(s => s.uiSounds)
  useEffect(() => { setUiSoundsFlag(uiSounds) }, [uiSounds])

  // Проверяем наличие сохранённой сессии при старте.
  // Логика:
  //  1. Есть токены → тянем профиль. Если профиль есть — 'app', иначе 'login'.
  //  2. Нет токенов, но юзер ранее выбрал "гостевой режим" (loginSkipped=true)
  //     → сразу 'app', без экрана входа.
  //  3. Нет токенов и не пропускал → 'login' (первый запуск / явный logout).
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const isLoggedIn = await window.syntee.auth.isLoggedIn()
        if (cancelled) return
        if (isLoggedIn) {
          await authLoad()
          if (cancelled) return
          const user = useAuthStore.getState().user
          setAuthBoot(user ? 'app' : 'login')
        } else {
          // Нет токенов — проверяем, выбирал ли юзер гостевой режим ранее.
          const skipped = await window.syntee.settings.get('loginSkipped')
          if (cancelled) return
          setAuthBoot(skipped === true ? 'app' : 'login')
        }
      } catch {
        if (!cancelled) setAuthBoot('login')
      }
    }
    check()
    const fallback = setTimeout(() => {
      if (!cancelled) setAuthBoot(prev => prev ?? 'login')
    }, 5000)
    return () => { cancelled = true; clearTimeout(fallback) }
  }, [authLoad])

  // Подписка на logout из main-процесса (например, при истечении сессии)
  useEffect(() => {
    const off = window.syntee.auth.onLoggedOut(() => {
      useAuthStore.setState({ user: null })
      setAuthBoot('login')
    })
    return () => { off() }
  }, [])

  // Когда юзер появился (успешный вход через браузер) — переключаемся в app.
  // Сбрасываем loginSkipped — юзер явно вошёл, больше не гость.
  useEffect(() => {
    if (authUser && authBoot !== 'app') {
      window.syntee.settings.set('loginSkipped', false)
      setAuthBoot('app')
    }
  }, [authUser, authBoot])

  // ── Syntee-Gateway: загрузка моделей + polling статусов ─────────────────
  // При появлении юзера тянем модели и запускаем polling раз в 60с.
  // При logout — store очистится автоматически (load() проверяет user).
  const gatewayLoad = useGatewayModelsStore(s => s.load)
  const gatewayLastFetch = useGatewayModelsStore(s => s.lastFetchAt)
  useEffect(() => {
    if (authUser) {
      gatewayLoad()
      const stop = startGatewayStatusPolling()
      return stop
    }
  }, [authUser, gatewayLoad])

  // Авто-назначение ролей на модели gateway — один раз после первого fetch.
  useEffect(() => {
    if (authUser && gatewayLastFetch > 0 && !isAutoAssignDone()) {
      autoAssignGatewayModels().then((changed) => {
        if (changed) {
          // Перезагружаем чат-клиент чтобы новые назначения подхватились.
          window.syntee.chat.reloadClient().catch(() => {})
        }
        markAutoAssignDone()
      })
    }
  }, [authUser, gatewayLastFetch])

  // ── Биллинг: загрузка при входе + polling раз в 5 минут ──────────────────
  const billingLoad = useBillingStore(s => s.load)
  useEffect(() => {
    if (authUser) {
      billingLoad()
      const timer = setInterval(() => billingLoad(true), 300_000)
      return () => clearInterval(timer)
    }
  }, [authUser, billingLoad])

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

  // Пока проверяем — ничего не показываем.
  // authLoading НЕ должен блокировать UI — он нужен только для индикатора
  // внутри LoginScreen. Изначально loading=true, но если юзер не залогинен,
  // load() не вызывается и loading никогда не сбросится → пустой экран.
  if (authBoot === null) return null

  // Не залогинен — экран входа (с возможностью пропуска как гость).
  if (authBoot === 'login') {
    return (
      <LoginScreen
        onContinueAsGuest={() => {
          // Сохраняем флаг чтобы при следующем запуске не показывать
          // экран входа — юзер уже решил работать в гостевом режиме.
          window.syntee.settings.set('loginSkipped', true)
          setAuthBoot('app')
        }}
      />
    )
  }

  // Главное окно
  return (
    <div className="app-root">
      <AnimatedBackground />
      <TitleBar
        onSettingsClick={() => toggleMainPage('settings')}
        onAgentClick={() => {
          const st = useUIStore.getState()
          const next = !st.agentPanelOpen
          st.setAgentPanelOpen(next)
          window.syntee.settings.set('agentPanelOpen', next)
        }}
        onMemoryClick={() => toggleMainPage('memory')}
        onProfileClick={() => openSettings('profile')}
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
      <QuestionPanel />
    </div>
  )
}
