import { create } from 'zustand'
import type { Chat, Message, ChatMode, Project } from '../../../shared/types'

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
}))
