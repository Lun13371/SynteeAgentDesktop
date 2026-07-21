import { create } from 'zustand'

type Theme = 'dark' | 'light' | 'midnight' | 'forest' | 'amber' | 'rose' | 'paper' | 'slate' | 'crimson'
type Page = 'chat' | 'settings' | 'tasks' | 'notes' | 'stats'

export type AvatarStyle = 'hex' | 'circle' | 'letter' | 'emoji' | 'none'
export type ShowTime = 'always' | 'hover' | 'never'

export const AGENT_PANEL_WIDTH_MIN = 280
export const AGENT_PANEL_WIDTH_MAX = 720
export const AGENT_PANEL_WIDTH_DEFAULT = 420

interface UIStore {
  theme: Theme
  accentColor: string
  agentPanelWidth: number
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
  return Math.min(AGENT_PANEL_WIDTH_MAX, Math.max(AGENT_PANEL_WIDTH_MIN, Math.round(w)))
}

export const useUIStore = create<UIStore>((set) => ({
  theme: 'dark',
  accentColor: '#ffffff',
  agentPanelWidth: AGENT_PANEL_WIDTH_DEFAULT,
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
