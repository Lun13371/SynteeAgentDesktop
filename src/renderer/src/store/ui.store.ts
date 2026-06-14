import { create } from 'zustand'

type Theme = 'dark' | 'light' | 'midnight' | 'forest'
type Page = 'chat' | 'settings' | 'tasks' | 'notes' | 'stats'

export type AvatarStyle = 'hex' | 'circle' | 'letter' | 'emoji' | 'none'
export type ShowTime = 'always' | 'hover' | 'never'

interface UIStore {
  theme: Theme
  accentColor: string
  sidebarOpen: boolean
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
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
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

export const useUIStore = create<UIStore>((set) => ({
  theme: 'dark',
  accentColor: '#ffffff',
  sidebarOpen: true,
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
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
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
