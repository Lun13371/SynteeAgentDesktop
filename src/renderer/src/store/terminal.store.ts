/**
 * Zustand-store для терминалов: метаданные сессий per-chat, активная сессия,
 * состояние dock (нижняя панель). Сами xterm-инстансы НЕ здесь (мутабельны,
 * живут в terminalRegistry.ts) — только UI-state.
 *
 * Единственный сигнал местоположения — dockOpen: если dock открыт, активная
 * сессия рендерится там (BottomDock); если закрыт — она доступна в табе
 * правой панели (TerminalPanel). Раньше было отдельное поле viewMode
 * ('right'|'bottom'), которое создавало тупиковые состояния (напр. dock
 * мог остаться навсегда невидимым) — убрано, dockOpen теперь единственный
 * источник правды.
 */
import { create } from 'zustand'

export interface TerminalSessionMeta {
  id: string
  chatId: string
  shell: string
  title: string
  source: 'user' | 'agent'
  createdAt: number
  dead: boolean
}

interface TerminalStore {
  /** Сессии по chatId (лениво загружаются через loadSessions). */
  sessionsByChat: Record<string, TerminalSessionMeta[]>
  /** Глобально активная сессия (рендерится в dock/right-tab). */
  activeSessionId: string | null
  /** Активный чат-контекст (для фильтрации списка). */
  activeChatId: string | null
  /** Открыт ли нижний dock — единственный сигнал местоположения терминала. */
  dockOpen: boolean
  /** Высота нижнего dock (persist в settings). */
  dockHeight: number

  // Actions
  setActiveChat: (chatId: string | null) => void
  loadSessions: (chatId: string) => Promise<void>
  createSession: (chatId: string, shell: string, cwd?: string) => Promise<string | null>
  closeSession: (sessionId: string) => Promise<void>
  switchSession: (sessionId: string) => void
  setDockOpen: (open: boolean) => void
  toggleDock: () => void
  setDockHeight: (h: number) => void
  removeSessionLocally: (sessionId: string) => void
}

export const DOCK_HEIGHT_MIN = 120
export const DOCK_HEIGHT_DEFAULT = 300

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  sessionsByChat: {},
  activeSessionId: null,
  activeChatId: null,
  dockOpen: false,
  dockHeight: DOCK_HEIGHT_DEFAULT,

  setActiveChat: (chatId) => {
    set({ activeChatId: chatId })
    if (chatId) get().loadSessions(chatId)
  },

  loadSessions: async (chatId) => {
    try {
      const sessions = (await window.syntee.pty.list(chatId)) as TerminalSessionMeta[]
      set((st) => ({ sessionsByChat: { ...st.sessionsByChat, [chatId]: sessions } }))
      // Если активная сессия умерла или не из этого чата — выбираем первую живую
      const active = get().activeSessionId
      const alive = sessions.filter(s => !s.dead)
      if (!active || !alive.find(s => s.id === active)) {
        set({ activeSessionId: alive[alive.length - 1]?.id ?? null })
      }
    } catch { /* ignore */ }
  },

  createSession: async (chatId, shell, cwd) => {
    try {
      const meta = (await window.syntee.pty.create({ chatId, shell, cwd, source: 'user' })) as TerminalSessionMeta | null
      if (!meta) return null
      set((st) => {
        const prev = st.sessionsByChat[chatId] ?? []
        return {
          sessionsByChat: { ...st.sessionsByChat, [chatId]: [...prev, meta] },
          activeSessionId: meta.id,
        }
      })
      return meta.id
    } catch {
      return null
    }
  },

  closeSession: async (sessionId) => {
    try { await window.syntee.pty.kill(sessionId) } catch { /* ignore */ }
    get().removeSessionLocally(sessionId)
  },

  removeSessionLocally: (sessionId) => {
    set((st) => {
      const chatId = get().activeChatId
      if (!chatId) return {}
      const prev = st.sessionsByChat[chatId] ?? []
      const next = prev.filter(s => s.id !== sessionId)
      let newActive = st.activeSessionId
      if (st.activeSessionId === sessionId) {
        const alive = next.filter(s => !s.dead)
        newActive = alive[alive.length - 1]?.id ?? null
      }
      return {
        sessionsByChat: { ...st.sessionsByChat, [chatId]: next },
        activeSessionId: newActive,
      }
    })
  },

  switchSession: (sessionId) => set({ activeSessionId: sessionId }),

  setDockOpen: (open) => set({ dockOpen: open }),
  toggleDock: () => set((st) => ({ dockOpen: !st.dockOpen })),
  setDockHeight: (h) => set({ dockHeight: Math.max(DOCK_HEIGHT_MIN, Math.round(h)) }),
}))

// Живая синхронизация: main-процесс шлёт 'pty:session-list-changed' при
// создании/закрытии/завершении PTY-сессии (в т.ч. агентом — AI создаёт
// сессию сам, без участия renderer). Без этого сессии появлялись в сторе
// только когда какой-то компонент явно вызывал loadSessions() при mount
// (переключение чата/таба) — сессия, созданная агентом посреди диалога,
// не появлялась в открытом доке/панели без "лишнего" перехода.
if (typeof window !== 'undefined' && window.syntee) {
  window.syntee.on('pty:session-list-changed', (chatId: unknown) => {
    if (typeof chatId === 'string') useTerminalStore.getState().loadSessions(chatId)
  })
}
