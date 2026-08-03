import { create } from 'zustand'
import { useChatStore } from './chat.store'
import { useToast } from '../components/ui/Toast/Toast'
import type { Chat } from '../../../shared/types'

// ── Вкладки открытых чатов в шапке (как в браузере) ────────────────────
// openTabIds — порядок вкладок слева направо. Вкладка ≠ чат: закрытие
// вкладки НЕ удаляет чат (он остаётся в сайдбаре). Состав и порядок
// персистятся в electron-store ('openChatTabs') и восстанавливаются при
// запуске (preload в App.tsx). Активная вкладка персистится ChatPage
// в 'activeChatTab' при каждой смене currentChatId.

const SETTINGS_KEY = 'openChatTabs'

function persist(ids: string[]) {
  try {
    void window.syntee?.settings?.set(SETTINGS_KEY, ids)
  } catch { /* ок — вне electron (браузерный dev) */ }
}

interface TabsStore {
  openTabIds: string[]
  /** Полная установка (восстановление сессии при boot). */
  setTabs: (ids: string[]) => void
  /** Открыть вкладку (добавить в конец, если ещё нет). */
  openTab: (id: string) => void
  /** Закрыть вкладку. Возвращает id соседней (правая, иначе левая — как в
   *  Chrome), на которую надо переключиться если закрытая была активной. */
  closeTab: (id: string) => string | null
  /** Новый порядок после drag&drop (Reorder.Group onReorder). */
  reorderTabs: (ids: string[]) => void
}

export const useTabsStore = create<TabsStore>((set, get) => ({
  openTabIds: [],

  setTabs: (ids) => {
    set({ openTabIds: ids })
    persist(ids)
  },

  openTab: (id) => {
    const { openTabIds } = get()
    if (openTabIds.includes(id)) return
    const next = [...openTabIds, id]
    set({ openTabIds: next })
    persist(next)
  },

  closeTab: (id) => {
    const { openTabIds } = get()
    const idx = openTabIds.indexOf(id)
    if (idx === -1) return null
    const next = openTabIds.filter(t => t !== id)
    set({ openTabIds: next })
    persist(next)
    return next[idx] ?? next[idx - 1] ?? null
  },

  reorderTabs: (ids) => {
    set({ openTabIds: ids })
    persist(ids)
  },
}))

// Авточистка: чат удалили (сайдбар/контекстное меню) → его вкладка тоже
// закрывается. Покрывает все пути удаления, т.к. любой из них идёт через
// setChats. При boot гонки нет: восстановление вкладок в App.tsx идёт
// ПОСЛЕ setChats, поэтому к моменту появления tabIds chats уже живые.
// Гейт по ссылке на chats: subscribe стреляет на ЛЮБОЕ изменение chat.store
// (стриминг ~20×/сек), а фильтровать нужно только при смене списка чатов.
// Здесь же — автозакрытие сплита: чат удалён или заархивирован.
let lastChats: unknown = null
useChatStore.subscribe((s) => {
  if (s.chats === lastChats) return
  lastChats = s.chats
  const { openTabIds, setTabs } = useTabsStore.getState()
  const alive = new Set(s.chats.map(c => c.id))
  if (openTabIds.length > 0) {
    const pruned = openTabIds.filter(id => alive.has(id))
    if (pruned.length !== openTabIds.length) setTabs(pruned)
  }
  // Сплит: чат исчез или ушёл в архив → закрываем сплит.
  if (s.splitChatId) {
    const splitChat = s.chats.find(c => c.id === s.splitChatId)
    if (!splitChat || splitChat.isArchived) s.setSplitChat(null)
  }
})

// Сплит ≠ вкладка: сплит-чат не может одновременно быть основным. Если
// пользователь активировал сплит-чат (клик по вкладке/сайдбару — любой путь
// идёт через setCurrentChat) — закрываем сплит, иначе обе половины показывали
// бы один и тот же чат.
let lastCurrentChatId: string | null = null
useChatStore.subscribe((s) => {
  if (s.currentChatId === lastCurrentChatId) return
  lastCurrentChatId = s.currentChatId
  if (s.currentChatId && s.currentChatId === s.splitChatId) s.setSplitChat(null)
})

// Минимальная ширина окна для сплита: ~1200px = сайдбар (~280px) + по ~460px
// на каждую половину чата. Уже — чаты сжимаются до неюзабельных размеров.
const SPLIT_MIN_WINDOW_WIDTH = 1200

/**
 * Открыть чат во второй половине экрана (сплит 50/50).
 * Гейты: чат уже активный — тост-отказ; узкое окно — тост «недостаточно места».
 * Возвращает true, если сплит открыт (вызывающий может навигировать на
 * страницу чата — меню вкладки доступно с любой страницы).
 * Используется из контекстного меню сайдбара и меню вкладки в шапке.
 */
export function openInSplit(chat: Chat): boolean {
  const st = useChatStore.getState()
  if (chat.id === st.currentChatId) {
    useToast.getState().add('Это уже активный чат — выберите другой для сплита', 'info')
    return false
  }
  if (chat.id === st.splitChatId) return true // уже открыт в сплите
  if (window.innerWidth < SPLIT_MIN_WINDOW_WIDTH) {
    useToast.getState().add('Недостаточно места для сплита — расширьте окно', 'info')
    return false
  }
  st.setSplitChat(chat.id)
  return true
}

// Мост между TitleBar (рендерится в App) и ChatPage (владелец логики
// выбора/создания чатов). ChatPage регистрирует свои колбэки при
// монтировании; ChatPage keep-alive → регистрация живёт всю сессию.
// Не в Zustand — функции не данные, подписки на них не нужны.
export const tabActions: {
  selectChat: ((id: string) => void) | null
  /** Создать чат в контексте текущего: чат проекта → новый чат в том же
   *  проекте; чат без проекта → новый чат без проекта. */
  createInContext: (() => void) | null
} = {
  selectChat: null,
  createInContext: null,
}
