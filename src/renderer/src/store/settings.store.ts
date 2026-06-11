import { create } from 'zustand'

interface SettingsStore {
  loaded: boolean
  settings: Record<string, unknown>
  // Actions
  load: () => Promise<void>
  set: (key: string, value: unknown) => Promise<void>
  get: <T>(key: string, fallback?: T) => T
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  loaded: false,
  settings: {},

  load: async () => {
    const all = await window.syntee.settings.getAll()
    set({ settings: all as Record<string, unknown>, loaded: true })
  },

  set: async (key, value) => {
    await window.syntee.settings.set(key, value)
    set((s) => ({ settings: { ...s.settings, [key]: value } }))
  },

  get: <T>(key: string, fallback?: T): T => {
    return (get().settings[key] as T) ?? (fallback as T)
  },
}))
