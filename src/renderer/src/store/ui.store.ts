import { create } from 'zustand'

type Theme = 'dark' | 'light' | 'midnight' | 'forest' | 'amber' | 'rose' | 'paper' | 'slate' | 'crimson'
type Page = 'chat' | 'settings' | 'tasks' | 'notes' | 'stats'

export type AvatarStyle = 'hex' | 'circle' | 'letter' | 'emoji' | 'none'
export type ShowTime = 'always' | 'hover' | 'never'

export const AGENT_PANEL_WIDTH_MIN = 280
export const AGENT_PANEL_WIDTH_DEFAULT = 420

// Максимальная ширина панели — динамическая, зависит от ширины окна:
// 70% от окна, но не больше 1600px. На большом мониторе панель может
// быть шире, на маленьком — уже, при этом область чата остаётся читаемой.
export function getAgentPanelWidthMax(): number {
  if (typeof window === 'undefined') return 720
  return Math.min(Math.floor(window.innerWidth * 0.7), 1600)
}

interface UIStore {
  theme: Theme
  accentColor: string
  agentPanelWidth: number
  agentPanelOpen: boolean
  animatedBackground: boolean
  bgStyle: string
  msgAnim: string
  avatarStyle: AvatarStyle
  showTime: ShowTime
  userMarkdown: boolean
  uiSounds: boolean
  sendEffect: boolean
  currentPage: Page
  isLoading: boolean
  // Actions
  setTheme: (theme: Theme) => void
  setAccentColor: (color: string) => void
  setAgentPanelWidth: (width: number) => void
  setAgentPanelOpen: (open: boolean) => void
  setCurrentPage: (page: Page) => void
  setLoading: (loading: boolean) => void
  setBgStyle: (style: string) => void
  setMsgAnim: (anim: string) => void
  setAnimatedBackground: (v: boolean) => void
  setAvatarStyle: (v: AvatarStyle) => void
  setShowTime: (v: ShowTime) => void
  setUserMarkdown: (v: boolean) => void
  setUiSounds: (v: boolean) => void
  setSendEffect: (v: boolean) => void
}

function clampAgentPanelWidth(w: number): number {
  if (!Number.isFinite(w)) return AGENT_PANEL_WIDTH_DEFAULT
  return Math.min(getAgentPanelWidthMax(), Math.max(AGENT_PANEL_WIDTH_MIN, Math.round(w)))
}

export const useUIStore = create<UIStore>((set) => ({
  theme: 'dark',
  accentColor: '#ffffff',
  agentPanelWidth: AGENT_PANEL_WIDTH_DEFAULT,
  agentPanelOpen: false,
  animatedBackground: true,
  bgStyle: 'particles',
  msgAnim: 'slide',
  avatarStyle: 'hex',
  showTime: 'hover',
  userMarkdown: false,
  uiSounds: true,
  sendEffect: true,
  currentPage: 'chat',
  isLoading: false,

  setTheme: (theme) => set({ theme }),
  setAccentColor: (accentColor) => set({ accentColor }),
  setAgentPanelWidth: (agentPanelWidth) => set({ agentPanelWidth: clampAgentPanelWidth(agentPanelWidth) }),
  setAgentPanelOpen: (agentPanelOpen) => set({ agentPanelOpen }),
  setCurrentPage: (currentPage) => set({ currentPage }),
  setLoading: (isLoading) => set({ isLoading }),
  setBgStyle: (bgStyle) => set({ bgStyle }),
  setMsgAnim: (msgAnim) => set({ msgAnim }),
  setAnimatedBackground: (animatedBackground) => set({ animatedBackground }),
  setAvatarStyle: (avatarStyle) => set({ avatarStyle }),
  setShowTime: (showTime) => set({ showTime }),
  setUserMarkdown: (userMarkdown) => set({ userMarkdown }),
  setUiSounds: (uiSounds) => set({ uiSounds }),
  setSendEffect: (sendEffect) => set({ sendEffect }),
}))
