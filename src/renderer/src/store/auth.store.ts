import { create } from 'zustand'

export interface GatewayUser {
  id: string
  email: string
  username?: string | null
  username_is_auto?: boolean
  role: string
  display_name?: string | null
  avatar_url?: string | null
}

export type AuthAvailability = 'unknown' | 'authenticated' | 'unavailable' | 'unauthenticated'

interface AuthStore {
  user: GatewayUser | null
  loading: boolean
  error: string | null
  availability: AuthAvailability
  load: () => Promise<void>
  markUnavailable: () => void
  logout: () => Promise<void>
  clearError: () => void
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  loading: false,
  error: null,
  availability: 'unknown',

  load: async () => {
    set({ loading: true, error: null })
    try {
      const result = await window.syntee.auth.me()
      // auth:me сохраняет токены при offline/5xx и сообщает, что сессия
      // временно недоступна. Не превращаем это в локальный logout.
      if (result && typeof result === 'object' && 'status' in result) {
        set({
          user: result.user ?? null,
          loading: false,
          availability: result.status,
        })
      } else {
        // Совместимость со старым preload/кэшем приложения.
        set({ user: result ?? null, loading: false, availability: result ? 'authenticated' : 'unauthenticated' })
      }
    } catch (err) {
      set({
        loading: false,
        availability: 'unavailable',
        error: err instanceof Error ? err.message : 'Failed to load user',
      })
    }
  },

  markUnavailable: () => set(state => (
    state.availability === 'unauthenticated'
      ? state
      : { availability: 'unavailable' }
  )),

  logout: async () => {
    await window.syntee.auth.logout()
    set({ user: null, error: null, availability: 'unauthenticated' })
  },

  clearError: () => set({ error: null }),
}))
