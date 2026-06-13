import { create } from 'zustand'
import type { Chat, Message } from '../../../shared/types'

interface ChatStore {
  chats: Chat[]
  currentChatId: string | null
  messages: Message[]
  isTyping: boolean
  streamingText: string
  pinnedMessages: Message[]
  isIncognito: boolean
  // Actions
  setChats: (chats: Chat[]) => void
  setCurrentChat: (id: string | null) => void
  setMessages: (messages: Message[]) => void
  addMessage: (message: Message) => void
  appendStreamToken: (token: string) => void
  clearStream: () => void
  setTyping: (typing: boolean) => void
  pinMessage: (id: string) => void
  unpinMessage: (id: string) => void
  toggleIncognito: () => void
}

export const useChatStore = create<ChatStore>((set) => ({
  chats: [],
  currentChatId: null,
  messages: [],
  isTyping: false,
  streamingText: '',
  pinnedMessages: [],
  isIncognito: false,

  setChats: (chats) => set({ chats }),
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
}))
