import { create } from 'zustand'

export type MainPage = 'chat' | 'settings' | 'memory'
export type SettingsSection = string

interface NavStore {
  mainPage: MainPage
  /** Активная секция в настройках (когда mainPage === 'settings'). */
  settingsSection: SettingsSection
  setMainPage: (p: MainPage) => void
  toggleMainPage: (p: MainPage) => void
  openSettings: (section?: SettingsSection) => void
  setSettingsSection: (section: SettingsSection) => void
}

export const useNavStore = create<NavStore>((set) => ({
  mainPage: 'chat',
  settingsSection: 'general',
  setMainPage: (p) => set({ mainPage: p }),
  toggleMainPage: (p) =>
    set((s) => ({ mainPage: s.mainPage === p ? 'chat' : p })),
  openSettings: (section) =>
    set({ mainPage: 'settings', settingsSection: section ?? 'general' }),
  setSettingsSection: (section) => set({ settingsSection: section }),
}))
