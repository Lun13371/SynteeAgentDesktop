import { create } from 'zustand'

export type MainPage = 'chat' | 'settings' | 'memory' | 'messenger' | 'dots'
export type SettingsSection = string

interface NavStore {
  mainPage: MainPage
  /** Активная секция в настройках (когда mainPage === 'settings'). */
  settingsSection: SettingsSection
  /** История навигации для кнопок мыши X1 (назад) / X2 (вперёд). */
  history: MainPage[]
  historyIndex: number
  setMainPage: (p: MainPage) => void
  toggleMainPage: (p: MainPage) => void
  openSettings: (section?: SettingsSection) => void
  setSettingsSection: (section: SettingsSection) => void
  goBack: () => boolean
  goForward: () => boolean
  canGoBack: () => boolean
  canGoForward: () => boolean
}

export const useNavStore = create<NavStore>((set, get) => {
  // Внутренний helper: обрезает forward-хвост после текущего индекса и
  // добавляет новую страницу в историю. no-op если та же страница что текущая.
  const pushHistory = (p: MainPage) => {
    const { history, historyIndex } = get()
    if (history[historyIndex] === p) return
    const next = history.slice(0, historyIndex + 1)
    next.push(p)
    set({ history: next, historyIndex: next.length - 1 })
  }

  return {
    mainPage: 'chat',
    settingsSection: 'general',
    history: ['chat'],
    historyIndex: 0,
    setMainPage: (p) => {
      set({ mainPage: p })
      pushHistory(p)
    },
    toggleMainPage: (p) => {
      const next = get().mainPage === p ? 'chat' : p
      set({ mainPage: next })
      pushHistory(next)
    },
    openSettings: (section) => {
      set({ mainPage: 'settings', settingsSection: section ?? 'general' })
      pushHistory('settings')
    },
    setSettingsSection: (section) => set({ settingsSection: section }),
    goBack: () => {
      const { historyIndex, history } = get()
      if (historyIndex <= 0) return false
      const newIndex = historyIndex - 1
      set({ historyIndex: newIndex, mainPage: history[newIndex] })
      return true
    },
    goForward: () => {
      const { historyIndex, history } = get()
      if (historyIndex >= history.length - 1) return false
      const newIndex = historyIndex + 1
      set({ historyIndex: newIndex, mainPage: history[newIndex] })
      return true
    },
    canGoBack: () => get().historyIndex > 0,
    canGoForward: () => get().historyIndex < get().history.length - 1,
  }
})
