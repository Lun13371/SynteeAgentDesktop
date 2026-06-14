import { create } from 'zustand'

type Theme = 'dark' | 'light' | 'midnight' | 'forest'
type Page = 'chat' | 'settings' | 'tasks' | 'notes' | 'stats'

interface UIStore {
  theme: Theme
  accentColor: string
  sidebarOpen: boolean
  animatedBackground: boolean
  bgStyle: string
  msgAnim: string
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
}

export const useUIStore = create<UIStore>((set) => ({
  theme: 'dark',
  accentColor: '#ffffff',
  sidebarOpen: true,
  animatedBackground: true,
  bgStyle: 'particles',
  msgAnim: 'slide',
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
}))
