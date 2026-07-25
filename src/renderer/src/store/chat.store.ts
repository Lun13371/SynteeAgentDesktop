import { create } from 'zustand'
import type { Chat, Message, ChatMode, Project, ToolStep, QueueItemMeta } from '../../../shared/types'

// ── Per-chat live state ────────────────────────────────────────────────
// Раньше всё live-состояние (стриминг-текст, шаги тулов, thinking, todo)
// лежало в useState одного компонента ChatPage и не было разделено по chatId.
// При переключении чатов оно утекало в чужой чат или терялось. Теперь это
//.per-chat словарь в Zustand: каждый активный чат имеет свой LiveState,
// привязанный к chatId. ChatPage читает только liveByChat[currentChatId].
export interface LiveIter {
  textBefore: string
  thinking?: string
  thinkingMs?: number
  steps: ToolStep[]
}

export interface ChatLiveState {
  msgId: string | null
  text: string
  thinking: string
  thinkingMs?: number
  isThinkingLive: boolean
  iters: LiveIter[]
  steps: ToolStep[]
  todo: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>
  agentStatus: string | null
  rateLimitSec: number
  isTyping: boolean
  isAgentRunning: boolean
  /** Live progress для долгих тулов (get_fast_context): {toolName → {stage, detail, files...}} */
  toolProgress: Record<string, { stage: string; detail?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }>; ts: number }>
}

export type RunStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface RunStatusInfo {
  status: RunStatus
  error?: string
  msgId?: string
  ts: number
}

// Терминальные статусы, после которых показываем бейдж ✓/✗ в сайдбаре.
// 'queued' и 'running' — spinner, не бейдж.
export const TERMINAL_RUN_STATUSES: ReadonlyArray<RunStatus> = ['done', 'error', 'cancelled']

export const EMPTY_LIVE: ChatLiveState = {
  msgId: null,
  text: '',
  thinking: '',
  isThinkingLive: false,
  iters: [],
  steps: [],
  todo: [],
  agentStatus: null,
  rateLimitSec: 0,
  isTyping: false,
  isAgentRunning: false,
  toolProgress: {},
}

// ── Side chat (параллельный доп-чат в правой панели) ───────────────────
// Эфемерный чат-в-чате: хранится только в памяти (Zustand), не пишется в БД.
// Ключ — parentId (id основного чата). Один side-чат на основной чат.
// ИИ side-чата получает сводку основного чата в системном промпте + тул
// get_main_chat_messages для запроса конкретных сообщений по мере нужды.
export interface SideChatState {
  messages: Message[]
  live: ChatLiveState
  runStatus: RunStatus | null
}

export const EMPTY_SIDE_CHAT: SideChatState = {
  messages: [],
  live: { ...EMPTY_LIVE },
  runStatus: null,
}

interface ChatStore {
  chats: Chat[]
  projects: Project[]
  activeProjectId: string | null
  currentChatId: string | null
  messages: Message[]
  isTyping: boolean
  streamingText: string
  pinnedMessages: Message[]
  isIncognito: boolean
  activeMode: ChatMode  // оставлен как 'code' — Work-режим удалён, но поле нужно для обратной совместимости с IPC

  // Per-chat live state — ключом является chatId. Параллельные чаты
  // каждый имеют свой LiveState, не перетирая друг друга.
  liveByChat: Record<string, ChatLiveState>
  // Статус запуска chat:send для каждого chatId — для сайдбар-индикатора.
  runStatusByChat: Record<string, RunStatusInfo>
  // Непрочитанные терминальные статусы — для бейджа ✓/✗ в сайдбаре.
  // Сбрасывается в markChatRead когда пользователь открыл чат.
  unreadStatusByChat: Record<string, RunStatus>

  // ── Очередь запросов чата ──
  // Ожидающие запросы (queued) по chatId — для UI-панели очереди.
  queueByChat: Record<string, QueueItemMeta[]>
  // Активный запуск (running) по chatId. null если ничего не выполняется.
  // Отличается от runStatusByChat тем, что хранит preview/startedAt для
  // отображения в панели; сбрасывается в null на терминальном статусе.
  activeRunByChat: Record<string, QueueItemMeta | null>

  // Actions
  setChats: (chats: Chat[]) => void
  setProjects: (projects: Project[]) => void
  setActiveProject: (id: string | null) => void
  setCurrentChat: (id: string | null) => void
  setMessages: (messages: Message[]) => void
  addMessage: (message: Message) => void
  appendStreamToken: (token: string) => void
  clearStream: () => void
  setTyping: (typing: boolean) => void
  pinMessage: (id: string) => void
  unpinMessage: (id: string) => void
  toggleIncognito: () => void
  setActiveMode: (mode: ChatMode) => void

  // Live-state actions
  setLiveState: (chatId: string, partial: Partial<ChatLiveState>) => void
  hydrateLiveState: (chatId: string, full: Partial<ChatLiveState> & { msgId: string | null }) => void
  clearLiveState: (chatId: string) => void
  setRunStatus: (chatId: string, status: RunStatus, error?: string, msgId?: string) => void
  markChatRead: (chatId: string) => void
  dropChatState: (chatId: string) => void

  // ── Очередь запросов ──
  setQueue: (chatId: string, queue: QueueItemMeta[]) => void
  setActiveRun: (chatId: string, meta: QueueItemMeta | null) => void

  // ── Side chat (параллельный доп-чат) ──
  sideChatByChat: Record<string, SideChatState>
  addSideMessage: (parentId: string, message: Message) => void
  setSideLiveState: (parentId: string, partial: Partial<ChatLiveState>) => void
  hydrateSideLiveState: (parentId: string, full: Partial<ChatLiveState> & { msgId: string | null }) => void
  clearSideLiveState: (parentId: string) => void
  setSideRunStatus: (parentId: string, status: RunStatus | null) => void
  resetSideChat: (parentId: string) => void
}

export const useChatStore = create<ChatStore>((set) => ({
  chats: [],
  projects: [],
  activeProjectId: null,
  currentChatId: null,
  messages: [],
  isTyping: false,
  streamingText: '',
  pinnedMessages: [],
  isIncognito: false,
  activeMode: 'code',

  liveByChat: {},
  runStatusByChat: {},
  unreadStatusByChat: {},

  queueByChat: {},
  activeRunByChat: {},

  sideChatByChat: {},

  setChats: (chats) => set({ chats }),
  setProjects: (projects) => set({ projects }),
  setActiveProject: (activeProjectId) => set({ activeProjectId }),
  setCurrentChat: (currentChatId) => set({ currentChatId }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) =>
    set((s) => {
      if (s.messages.some(m => m.id === message.id)) return s
      return { messages: [...s.messages, message] }
    }),
  appendStreamToken: (token) =>
    set((s) => ({ streamingText: s.streamingText + token })),
  clearStream: () => set({ streamingText: '', isTyping: false }),
  setTyping: (isTyping) => set({ isTyping }),
  pinMessage: (id) =>
    set((s) => {
      const msg = s.messages.find((m) => m.id === id)
      if (!msg) return s
      return { pinnedMessages: [...s.pinnedMessages, msg] }
    }),
  unpinMessage: (id) =>
    set((s) => ({ pinnedMessages: s.pinnedMessages.filter((m) => m.id !== id) })),
  toggleIncognito: () => set((s) => ({ isIncognito: !s.isIncognito })),
  setActiveMode: (activeMode) => set({ activeMode }),

  setLiveState: (chatId, partial) =>
    set((s) => {
      const prev = s.liveByChat[chatId] ?? EMPTY_LIVE
      return {
        liveByChat: {
          ...s.liveByChat,
          [chatId]: { ...prev, ...partial },
        },
      }
    }),

  hydrateLiveState: (chatId, full) =>
    set((s) => ({
      liveByChat: {
        ...s.liveByChat,
        [chatId]: { ...EMPTY_LIVE, ...full },
      },
    })),

  clearLiveState: (chatId) =>
    set((s) => {
      if (!s.liveByChat[chatId]) return s
      const next = { ...s.liveByChat }
      delete next[chatId]
      return { liveByChat: next }
    }),

  setRunStatus: (chatId, status, error, msgId) =>
    set((s) => {
      const nextRunStatus: RunStatusInfo = { status, error, msgId, ts: Date.now() }
      // Для терминальных статусов — помечаем как unread (бейдж в сайдбаре).
      // Для running/queued — просто обновляем runStatus (spinner).
      const isTerminal = TERMINAL_RUN_STATUSES.includes(status)
      return {
        runStatusByChat: {
          ...s.runStatusByChat,
          [chatId]: nextRunStatus,
        },
        unreadStatusByChat: isTerminal
          ? { ...s.unreadStatusByChat, [chatId]: status }
          : s.unreadStatusByChat,
      }
    }),

  markChatRead: (chatId) =>
    set((s) => {
      if (!s.unreadStatusByChat[chatId]) return s
      const next = { ...s.unreadStatusByChat }
      delete next[chatId]
      return { unreadStatusByChat: next }
    }),

  dropChatState: (chatId) =>
    set((s) => {
      const nextLive = { ...s.liveByChat }
      const nextRun = { ...s.runStatusByChat }
      const nextUnread = { ...s.unreadStatusByChat }
      const nextQueue = { ...s.queueByChat }
      const nextActive = { ...s.activeRunByChat }
      const nextSide = { ...s.sideChatByChat }
      delete nextLive[chatId]
      delete nextRun[chatId]
      delete nextUnread[chatId]
      delete nextQueue[chatId]
      delete nextActive[chatId]
      delete nextSide[chatId]
      return {
        liveByChat: nextLive,
        runStatusByChat: nextRun,
        unreadStatusByChat: nextUnread,
        queueByChat: nextQueue,
        activeRunByChat: nextActive,
        sideChatByChat: nextSide,
      }
    }),

  setQueue: (chatId, queue) =>
    set((s) => ({
      queueByChat: { ...s.queueByChat, [chatId]: queue },
    })),

  setActiveRun: (chatId, meta) =>
    set((s) => {
      const next = { ...s.activeRunByChat }
      if (meta === null) delete next[chatId]
      else next[chatId] = meta
      return { activeRunByChat: next }
    }),

  // ── Side chat actions ──
  addSideMessage: (parentId, message) =>
    set((s) => {
      const prev = s.sideChatByChat[parentId] ?? EMPTY_SIDE_CHAT
      if (prev.messages.some(m => m.id === message.id)) return s
      return {
        sideChatByChat: {
          ...s.sideChatByChat,
          [parentId]: { ...prev, messages: [...prev.messages, message] },
        },
      }
    }),

  setSideLiveState: (parentId, partial) =>
    set((s) => {
      const prev = s.sideChatByChat[parentId] ?? EMPTY_SIDE_CHAT
      return {
        sideChatByChat: {
          ...s.sideChatByChat,
          [parentId]: { ...prev, live: { ...prev.live, ...partial } },
        },
      }
    }),

  hydrateSideLiveState: (parentId, full) =>
    set((s) => {
      const prev = s.sideChatByChat[parentId] ?? EMPTY_SIDE_CHAT
      return {
        sideChatByChat: {
          ...s.sideChatByChat,
          [parentId]: { ...prev, live: { ...EMPTY_LIVE, ...full } },
        },
      }
    }),

  clearSideLiveState: (parentId) =>
    set((s) => {
      const prev = s.sideChatByChat[parentId]
      if (!prev) return s
      return {
        sideChatByChat: {
          ...s.sideChatByChat,
          [parentId]: { ...prev, live: { ...EMPTY_LIVE } },
        },
      }
    }),

  setSideRunStatus: (parentId, status) =>
    set((s) => {
      const prev = s.sideChatByChat[parentId] ?? EMPTY_SIDE_CHAT
      return {
        sideChatByChat: {
          ...s.sideChatByChat,
          [parentId]: { ...prev, runStatus: status },
        },
      }
    }),

  resetSideChat: (parentId) =>
    set((s) => {
      const next = { ...s.sideChatByChat }
      delete next[parentId]
      return { sideChatByChat: next }
    }),
}))
