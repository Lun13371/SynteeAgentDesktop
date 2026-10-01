// ── Dots store: список Dot'ов + подписка на push-события main ────────────
// DotsPage монтируется один раз; события DOTS_CHANGED/STATE обновляют
// список без полного refetch (STATE шлёт только статусы — main пересобирает
// Dot[] с состоянием, поэтому проще перечитать dots:list — он лёгкий).
import { create } from 'zustand'
import { IPC_EVENTS } from '../../../shared/constants'
import type { Dot, DotRun, DotSettings } from '../../../shared/types'

interface DotsStore {
  dots: Dot[]
  loaded: boolean
  loading: boolean
  /** Выбранный Dot (id) — его чат открыт справа. */
  selectedDotId: string | null
  /** История ранов выбранного Dot'а. */
  runsByDot: Record<string, DotRun[]>
  settings: DotSettings | null
  /** Визард создания/редактирования. dotId = редактирование. */
  wizard: { open: boolean; dotId?: string }
  setWizard: (open: boolean, dotId?: string) => void
  selectDot: (dotId: string | null) => void
  load: () => Promise<void>
  loadRuns: (dotId: string) => Promise<void>
  loadSettings: () => Promise<void>
  setSettings: (patch: Partial<DotSettings>) => Promise<void>
  initEvents: () => () => void
}

export const useDotsStore = create<DotsStore>((set, get) => ({
  dots: [],
  loaded: false,
  loading: false,
  selectedDotId: null,
  runsByDot: {},
  settings: null,
  wizard: { open: false },

  setWizard: (open, dotId) => set({ wizard: { open, dotId } }),
  selectDot: (dotId) => set({ selectedDotId: dotId }),

  load: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      const dots = await window.syntee.dots.list()
      set({ dots, loaded: true })
    } catch {
      set({ loaded: true })
    } finally {
      set({ loading: false })
    }
  },

  loadRuns: async (dotId) => {
    try {
      const runs = await window.syntee.dots.getRuns(dotId, 30)
      set(s => ({ runsByDot: { ...s.runsByDot, [dotId]: runs } }))
    } catch { /* ignore */ }
  },

  loadSettings: async () => {
    try {
      const settings = await window.syntee.dots.getSettings()
      set({ settings })
    } catch { /* ignore */ }
  },

  setSettings: async (patch) => {
    try {
      const settings = await window.syntee.dots.setSettings(patch)
      set({ settings })
    } catch { /* ignore */ }
  },

  initEvents: () => {
    // DOTS_CHANGED — CRUD (создан/удалён/обновлён) → перечитываем список.
    const offChanged = window.syntee.on(IPC_EVENTS.DOTS_CHANGED, () => {
      void get().load()
    })
    // DOTS_STATE — статус ранов (running/sleeping/...) → перечитываем
    // (main пересобирает Dot[] с живым состоянием — список маленький).
    const offState = window.syntee.on(IPC_EVENTS.DOTS_STATE, () => {
      void get().load()
    })
    // DOTS_RUN_FINISHED — ран завершился: обновить список + историю.
    const offRun = window.syntee.on(IPC_EVENTS.DOTS_RUN_FINISHED, (...args: unknown[]) => {
      const p = (args[0] ?? {}) as { dotId?: string }
      void get().load()
      if (p.dotId) void get().loadRuns(p.dotId)
    })
    return () => { offChanged(); offState(); offRun() }
  },
}))
