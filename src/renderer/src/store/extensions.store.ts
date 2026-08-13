/**
 * Extensions store — состояние для MCP-серверов и Skills в renderer.
 *
 * Хранит:
 *   - skills: полный список скиллов (с состоянием) для popover
 *   - mcpServers: полный список MCP-серверов (с runtime) для popover
 *   - activeSkillsByChat / activeMcpByChat: кэш активных для бейджа
 *
 * Загрузка идёт через IPC (window.syntee.skills / window.syntee.mcp).
 * Store не персистит сам — состояние пишется в electron-store через IPC.
 *
 * Push-события от main (mcp:status, mcp:tools:updated) обновляют mcpServers
 * в реальном времени — подписка устанавливается в initExtensionsPushEvents().
 */
import { create } from 'zustand'
import type { Skill, SkillState, McpServerRuntime, MarketplaceMcpServer, MarketplaceSkill } from '../../../../../shared/types'
import { useChatStore } from './chat.store'

/**
 * Текущий chatId для push-обработчиков (mcp:servers-changed / skills:updated).
 * Обновляется из ChatStore подпиской — extensions.store не знает chatId сам.
 */
let _currentChatId: string | null = null
useChatStore.subscribe((s) => {
  if (s.currentChatId !== _currentChatId) {
    _currentChatId = s.currentChatId
  }
})

interface SkillWithState extends Skill {
  state: SkillState
}

// Счётчики для отбрасывания устаревших ответов поиска (см. searchMcpCatalog/
// searchSkillsCatalog) — реестры бывают медленными, и без этой защиты более
// быстрый ответ на СТАРЫЙ запрос может перезаписать актуальный результат.
let mcpSearchToken = 0
let skillsSearchToken = 0

type CatalogView = 'installed' | 'catalog' | 'detail'

interface ExtensionsStore {
  // ── Skills ──
  skills: SkillWithState[]
  skillsLoading: boolean

  // ── MCP ──
  mcpServers: McpServerRuntime[]
  mcpLoading: boolean

  // ── Активные для текущего чата (для бейджа) ──
  activeSkillIds: string[]
  activeMcpServerIds: string[]

  // ── Каталог MCP (маркетплейс) ──
  mcpCatalogView: CatalogView
  mcpCatalogSearch: string
  mcpCatalogResults: MarketplaceMcpServer[]
  mcpCatalogLoading: boolean
  mcpCatalogCursor?: string
  mcpCatalogDetail: MarketplaceMcpServer | null
  /** Текст ошибки последнего поиска (registry.modelcontextprotocol.io бывает медленным/недоступным). */
  mcpCatalogError: string | null

  // ── Каталог Skills (маркетплейс) ──
  skillsCatalogView: CatalogView
  skillsCatalogSearch: string
  skillsCatalogResults: MarketplaceSkill[]
  skillsCatalogLoading: boolean
  skillsCatalogPage: number
  skillsCatalogHasMore: boolean
  skillsCatalogDetail: MarketplaceSkill | null
  skillsCatalogReadme: string
  skillsCatalogReadmeLoading: boolean
  skillsCatalogError: string | null

  // ── Actions ──
  loadSkills: (projectId?: string) => Promise<void>
  loadMcpServers: (projectId?: string) => Promise<void>
  setSkillState: (skillId: string, state: SkillState, source: 'builtin' | 'user' | 'project') => Promise<void>
  reloadSkills: () => Promise<void>
  loadActiveForChat: (chatId: string, isIncognito?: boolean) => Promise<void>

  // ── Catalog actions ──
  setMcpCatalogView: (view: CatalogView) => void
  searchMcpCatalog: (query: string) => Promise<void>
  cancelMcpCatalogSearch: () => void
  loadMoreMcpCatalog: () => Promise<void>
  openMcpDetail: (item: MarketplaceMcpServer) => void

  setSkillsCatalogView: (view: CatalogView) => void
  searchSkillsCatalog: (query: string) => Promise<void>
  cancelSkillsCatalogSearch: () => void
  loadMoreSkillsCatalog: () => Promise<void>
  openSkillDetail: (item: MarketplaceSkill) => Promise<void>
}

export const useExtensionsStore = create<ExtensionsStore>((set, get) => ({
  skills: [],
  skillsLoading: false,
  mcpServers: [],
  mcpLoading: false,
  activeSkillIds: [],
  activeMcpServerIds: [],

  mcpCatalogView: 'installed',
  mcpCatalogSearch: '',
  mcpCatalogResults: [],
  mcpCatalogLoading: false,
  mcpCatalogCursor: undefined,
  mcpCatalogDetail: null,
  mcpCatalogError: null,

  skillsCatalogView: 'installed',
  skillsCatalogSearch: '',
  skillsCatalogResults: [],
  skillsCatalogLoading: false,
  skillsCatalogPage: 1,
  skillsCatalogHasMore: false,
  skillsCatalogDetail: null,
  skillsCatalogReadme: '',
  skillsCatalogReadmeLoading: false,
  skillsCatalogError: null,

  loadSkills: async (projectId?: string) => {
    set({ skillsLoading: true })
    try {
      const chatId = useChatStore.getState().currentChatId ?? undefined
      const list = await window.syntee.skills.getAll({ projectId, chatId }) as SkillWithState[]
      set({ skills: list ?? [], skillsLoading: false })
    } catch {
      set({ skillsLoading: false })
    }
  },

  loadMcpServers: async (projectId?: string) => {
    set({ mcpLoading: true })
    try {
      // Если projectId не передан, пробуем currentChatId — mcp:getAll
      // сам резолвит проект из чата (надёжнее чем activeProjectId в сторе).
      const chatId = useChatStore.getState().currentChatId ?? undefined
      const list = await window.syntee.mcp.getAll({ projectId, chatId }) as McpServerRuntime[]
      set({ mcpServers: list ?? [], mcpLoading: false })
    } catch {
      set({ mcpLoading: false })
    }
  },

  setSkillState: async (skillId, state, source) => {
    await window.syntee.skills.setState({ skillId, state, source })
    set(s => ({
      skills: s.skills.map(sk => sk.id === skillId ? { ...sk, state } : sk),
    }))
  },

  reloadSkills: async () => {
    await window.syntee.skills.reload()
    await get().loadSkills()
  },

  loadActiveForChat: async (chatId, isIncognito) => {
    if (isIncognito) {
      set({ activeSkillIds: [], activeMcpServerIds: [] })
      return
    }
    // Активные скиллы — IPC фильтрует по scope на бэкенде.
    try {
      const active = await window.syntee.skills.getActive({ chatId, isIncognito }) as Skill[]
      set({ activeSkillIds: (active ?? []).map(s => s.id) })
    } catch {
      set({ activeSkillIds: [] })
    }
    // Активные MCP — IPC фильтрует по enabled + scope + статусу на бэкенде.
    // Раньше фильтровали локально (только enabled+connected, без scope) —
    // из-за этого MCP с scope "только проект A" показывались в бейдже для чатов
    // проекта B. Теперь бэкенд получает projectId по chatId и фильтрует правильно.
    try {
      const activeIds = await window.syntee.mcp.getActiveForChat({ chatId, isIncognito }) as string[]
      set({ activeMcpServerIds: activeIds ?? [] })
    } catch {
      set({ activeMcpServerIds: [] })
    }
  },

  // ── MCP каталог ──

  setMcpCatalogView: (view) => set({ mcpCatalogView: view }),

  searchMcpCatalog: async (query: string) => {
    // Токен запроса — реестр может отвечать 5-25с; если пользователь успел
    // изменить запрос до ответа предыдущего, отбрасываем устаревший результат
    // (иначе более быстрый старый ответ перезапишет актуальный поиск).
    const token = ++mcpSearchToken
    set({ mcpCatalogLoading: true, mcpCatalogSearch: query, mcpCatalogCursor: undefined, mcpCatalogError: null })
    try {
      const res = await window.syntee.marketplace.searchMcp({ query, limit: 30 }) as { servers: MarketplaceMcpServer[]; nextCursor?: string }
      if (token !== mcpSearchToken) return
      set({ mcpCatalogResults: res.servers ?? [], mcpCatalogCursor: res.nextCursor, mcpCatalogLoading: false })
    } catch (e) {
      if (token !== mcpSearchToken) return
      const msg = (e as Error).message || 'Не удалось загрузить список серверов'
      // AbortError — пользователь нажал "Отмена", не показываем как ошибку
      if (msg.includes('abort') || msg.includes('Abort')) {
        set({ mcpCatalogLoading: false })
      } else {
        set({ mcpCatalogResults: [], mcpCatalogLoading: false, mcpCatalogError: msg })
      }
    }
  },

  cancelMcpCatalogSearch: () => {
    mcpSearchToken++ // инвалидируем ожидающий ответ
    set({ mcpCatalogLoading: false })
    try { window.syntee.marketplace.cancelMcpSearch() } catch { /* noop */ }
  },

  loadMoreMcpCatalog: async () => {
    const { mcpCatalogCursor, mcpCatalogSearch, mcpCatalogResults } = get()
    if (!mcpCatalogCursor) return
    set({ mcpCatalogLoading: true })
    try {
      const res = await window.syntee.marketplace.searchMcp({ query: mcpCatalogSearch, limit: 30, cursor: mcpCatalogCursor }) as { servers: MarketplaceMcpServer[]; nextCursor?: string }
      set({ mcpCatalogResults: [...mcpCatalogResults, ...(res.servers ?? [])], mcpCatalogCursor: res.nextCursor, mcpCatalogLoading: false })
    } catch {
      set({ mcpCatalogLoading: false })
    }
  },

  openMcpDetail: (item: MarketplaceMcpServer) => {
    set({ mcpCatalogDetail: item, mcpCatalogView: 'detail' })
  },

  // ── Skills каталог ──

  setSkillsCatalogView: (view) => set({ skillsCatalogView: view }),

  searchSkillsCatalog: async (query: string) => {
    const token = ++skillsSearchToken
    set({ skillsCatalogLoading: true, skillsCatalogSearch: query, skillsCatalogPage: 1, skillsCatalogError: null })
    try {
      const res = await window.syntee.marketplace.searchSkills({ query, page: 1, perPage: 24 }) as { skills: MarketplaceSkill[]; hasMore: boolean }
      if (token !== skillsSearchToken) return
      set({ skillsCatalogResults: res.skills ?? [], skillsCatalogHasMore: res.hasMore, skillsCatalogLoading: false })
    } catch (e) {
      if (token !== skillsSearchToken) return
      const msg = (e as Error).message || 'Не удалось загрузить список скиллов'
      if (msg.includes('abort') || msg.includes('Abort')) {
        set({ skillsCatalogLoading: false })
      } else {
        set({ skillsCatalogResults: [], skillsCatalogLoading: false, skillsCatalogError: msg })
      }
    }
  },

  cancelSkillsCatalogSearch: () => {
    skillsSearchToken++
    set({ skillsCatalogLoading: false })
    try { window.syntee.marketplace.cancelSkillsSearch() } catch { /* noop */ }
  },

  loadMoreSkillsCatalog: async () => {
    const { skillsCatalogPage, skillsCatalogSearch, skillsCatalogResults, skillsCatalogHasMore } = get()
    if (!skillsCatalogHasMore) return
    const nextPage = skillsCatalogPage + 1
    set({ skillsCatalogLoading: true })
    try {
      const res = await window.syntee.marketplace.searchSkills({ query: skillsCatalogSearch, page: nextPage, perPage: 24 }) as { skills: MarketplaceSkill[]; hasMore: boolean }
      set({ skillsCatalogResults: [...skillsCatalogResults, ...(res.skills ?? [])], skillsCatalogHasMore: res.hasMore, skillsCatalogPage: nextPage, skillsCatalogLoading: false })
    } catch {
      set({ skillsCatalogLoading: false })
    }
  },

  openSkillDetail: async (item: MarketplaceSkill) => {
    set({ skillsCatalogDetail: item, skillsCatalogView: 'detail', skillsCatalogReadme: '', skillsCatalogReadmeLoading: true })
    try {
      const readme = await window.syntee.marketplace.getSkillReadme({ fullName: item.fullName }) as string
      set({ skillsCatalogReadme: readme ?? '', skillsCatalogReadmeLoading: false })
    } catch {
      set({ skillsCatalogReadmeLoading: false })
    }
  },
}))

/** Селектор: суммарное кол-во активных расширений для бейджа. */
export function selectActiveExtensionsCount(state: ExtensionsStore): number {
  return state.activeSkillIds.length + state.activeMcpServerIds.length
}

/**
 * Подписка на push-события MCP (статус подключения, обновление тулов).
 * Вызывается один раз при старте renderer (например, в App.tsx).
 * Возвращает функцию отписки.
 */
let pushInitialized = false
export function initExtensionsPushEvents(): () => void {
  if (pushInitialized) return () => {}
  pushInitialized = true

  const offStatus = window.syntee.on('mcp:status', (data: unknown) => {
    const d = data as { serverId: string; status: string; error?: string; connectStartedAt?: number; logs?: McpServerRuntime['logs'] }
    useExtensionsStore.setState(s => ({
      mcpServers: s.mcpServers.map(srv => {
        if (srv.id !== d.serverId) return srv
        // Не перезаписываем error-статус на disconnected (race condition:
        // transport.onclose может стрелять после catch-блока и затирать
        // ошибку — карточка мигает и ошибка исчезает).
        const keepError = d.status === 'disconnected' && srv.status === 'error'
        // Логи обновляем ВСЕГДА — даже когда статус не меняется из-за race-guard.
        // Иначе при ошибке (где статус остаётся 'error' от более раннего события)
        // пользователь не увидит финальные записи журнала.
        return {
          ...srv,
          status: keepError ? srv.status : d.status as McpServerRuntime['status'],
          error: keepError ? srv.error : d.error,
          connectStartedAt: d.connectStartedAt,
          logs: d.logs ?? srv.logs,
        }
      }),
    }))
  })

  const offTools = window.syntee.on('mcp:tools:updated', (data: unknown) => {
    const d = data as { serverId: string; tools: McpServerRuntime['tools'] }
    useExtensionsStore.setState(s => ({
      mcpServers: s.mcpServers.map(srv =>
        srv.id === d.serverId ? { ...srv, tools: d.tools } : srv,
      ),
    }))
  })

  const offLogs = window.syntee.on('mcp:logs', (data: unknown) => {
    const d = data as { serverId: string; logs: McpServerRuntime['logs'] }
    useExtensionsStore.setState(s => ({
      mcpServers: s.mcpServers.map(srv =>
        srv.id === d.serverId ? { ...srv, logs: d.logs } : srv,
      ),
    }))
  })

  // skills:updated — extensions-watcher обнаружил новые/удалённые .md в
  // .syntee/skills/ активного проекта (например после /setup). Перезагружаем
  // список скиллов чтобы popover отразил авто-включённые новые скиллы.
  const offSkillsUpdated = window.syntee.on('skills:updated', () => {
    const pid = useChatStore.getState().activeProjectId ?? undefined
    useExtensionsStore.getState().loadSkills(pid)
  })

  // mcp:servers-changed — extensions-watcher перечитал .mcp.json и обнаружил
  // новые/удалённые серверы (после /setup или ручного редактирования файла).
  // Перезагружаем список серверов (новые появятся в popover со статусом
  // connecting) И активные для текущего чата (бейдж обновится сразу).
  const offServersChanged = window.syntee.on('mcp:servers-changed', (data: unknown) => {
    const d = data as { projectId?: string }
    const pid = d.projectId ?? useChatStore.getState().activeProjectId ?? undefined
    useExtensionsStore.getState().loadMcpServers(pid)
    if (_currentChatId) {
      useExtensionsStore.getState().loadActiveForChat(_currentChatId)
    }
  })
  return () => {
    offStatus?.()
    offTools?.()
    offLogs?.()
    offSkillsUpdated?.()
    offServersChanged?.()
    pushInitialized = false
  }
}
