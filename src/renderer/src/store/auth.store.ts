import { create } from 'zustand'

export interface GatewayUser {
  id: string
  email: string
  role: string
  display_name?: string | null
  avatar_url?: string | null
}

interface AuthStore {
  user: GatewayUser | null
  loading: boolean
  error: string | null
  load: () => Promise<void>
  logout: () => Promise<void>
  clearError: () => void
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null })
    try {
      const user = await window.syntee.auth.me()
      set({ user, loading: false })
    } catch (err) {
      set({
        user: null,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load user',
      })
    }
  },

  logout: async () => {
    await window.syntee.auth.logout()
    set({ user: null, error: null })
  },

  clearError: () => set({ error: null }),
}))
