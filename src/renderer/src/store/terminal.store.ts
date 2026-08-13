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
  /** SessionId где AI сейчас выполняет run_command (ввод заблокирован). */
  aiBusySessionIds: Set<string>

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
  markAiBusy: (sessionId: string, busy: boolean) => void
}

export const DOCK_HEIGHT_MIN = 120
export const DOCK_HEIGHT_DEFAULT = 300

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  sessionsByChat: {},
  activeSessionId: null,
  activeChatId: null,
  dockOpen: false,
  dockHeight: DOCK_HEIGHT_DEFAULT,
  aiBusySessionIds: new Set<string>(),

  setActiveChat: (chatId) => {
    set({ activeChatId: chatId })
    if (chatId) get().loadSessions(chatId)
  },

  loadSessions: async (chatId) => {
    try {
      const sessions = (await window.syntee.pty.list(chatId)) as TerminalSessionMeta[]
      set((st) => ({ sessionsByChat: { ...st.sessionsByChat, [chatId]: sessions } }))
      // Если активная сессия умерла или не из этого чата — выбираем замену.
      // Предпочитаем user-сессию: agent-сессия управляется AI, пользователь
      // не должен случайно оказаться в ней и печатать в чужой ввод.
      const active = get().activeSessionId
      const alive = sessions.filter(s => !s.dead)
      if (!active || !alive.find(s => s.id === active)) {
        const userSession = alive.find(s => s.source === 'user')
        set({ activeSessionId: userSession?.id ?? alive[alive.length - 1]?.id ?? null })
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
        const userSession = alive.find(s => s.source === 'user')
        newActive = userSession?.id ?? alive[alive.length - 1]?.id ?? null
      }
      return {
        sessionsByChat: { ...st.sessionsByChat, [chatId]: next },
        activeSessionId: newActive,
      }
    })
  },

  switchSession: (sessionId) => set({ activeSessionId: sessionId }),

  setDockOpen: (open) => {
    set({ dockOpen: open })
    import('../utils/sounds').then((m) => open ? m.playPanelOpenSound() : m.playPanelCloseSound())
  },
  toggleDock: () => {
    const next = !get().dockOpen
    set({ dockOpen: next })
    import('../utils/sounds').then((m) => next ? m.playPanelOpenSound() : m.playPanelCloseSound())
  },
  setDockHeight: (h) => set({ dockHeight: Math.max(DOCK_HEIGHT_MIN, Math.round(h)) }),
  markAiBusy: (sessionId, busy) => set((st) => {
    const next = new Set(st.aiBusySessionIds)
    if (busy) next.add(sessionId); else next.delete(sessionId)
    return { aiBusySessionIds: next }
  }),
}))

// Живая синхронизация: main-процесс шлёт 'pty:session-list-changed' при
// создании/закрытии/завершении PTY-сессии (в т.ч. агентом — AI создаёт
// сессию сам, без участия renderer). Без этого сессии появлялись в сторе
// только когда какой-то компонент явно вызывал loadSessions() при mount
// (переключение чата/таба) — сессия, созданная агентом посреди диалога,
// не появлялась в открытом доке/панели без "лишнего" перехода.
//
// agent:tool_progress — AI начал/закончил run_command. На 'start' помечаем
// сессию занятой (ввод заблокирован в PtyManager.write), на 'done'/'error'
// снимаем отметку. pty:exit — процесс умер, тоже снимаем отметку.
// done/error не несут sessionId, поэтому держим chatId→sessionId map.
const aiBusyByChat: Record<string, string> = {}
if (typeof window !== 'undefined' && window.syntee) {
  window.syntee.on('pty:session-list-changed', (chatId: unknown) => {
    if (typeof chatId === 'string') useTerminalStore.getState().loadSessions(chatId)
  })
  window.syntee.on('agent:tool_progress', (data: unknown) => {
    const d = data as { chatId?: string; toolName?: string; stage?: string; sessionId?: string }
    if (d.toolName !== 'run_command' || !d.chatId) return
    if (d.stage === 'start' && d.sessionId) {
      aiBusyByChat[d.chatId] = d.sessionId
      useTerminalStore.getState().markAiBusy(d.sessionId, true)
    } else if (d.stage === 'done' || d.stage === 'error') {
      const sid = aiBusyByChat[d.chatId]
      if (sid) {
        delete aiBusyByChat[d.chatId]
        useTerminalStore.getState().markAiBusy(sid, false)
      }
    }
  })
  window.syntee.on('pty:exit', (sessionId: unknown) => {
    if (typeof sessionId === 'string') {
      useTerminalStore.getState().markAiBusy(sessionId, false)
      // Немедленно убираем dead-сессию из UI — иначе она висит до следующего
      // loadSessions (переключение чата/таба). pty:session-list-changed тоже
      // триггерит loadSessions, но pty:exit приходит раньше и обновляет UI мгновенно.
      useTerminalStore.getState().removeSessionLocally(sessionId)
    }
  })
}
