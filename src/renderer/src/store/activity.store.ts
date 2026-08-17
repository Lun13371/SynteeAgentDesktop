import { create } from 'zustand'

export type ActivityStatus = 'idle' | 'running' | 'done' | 'error'
export type ActivityPhase = 'thinking' | 'tool' | 'idle'

export interface ActivityStep {
  id: string
  toolName: string
  status: 'running' | 'done' | 'error'
  args?: Record<string, unknown>
  result?: string
  ts: number
}

export interface ToolProgress {
  toolName: string
  stage: string
  detail?: string
  filesProcessed?: number
  filesTotal?: number
}

interface ActivityStore {
  status: ActivityStatus
  phase: ActivityPhase
  currentTool: string | null
  toolProgress: ToolProgress | null
  stepsLog: ActivityStep[]
  startedAt: number | null
  visible: boolean

  setRunning: () => void
  setDone: () => void
  setError: () => void
  setPhase: (phase: ActivityPhase) => void
  setCurrentTool: (tool: string | null) => void
  setToolProgress: (progress: ToolProgress | null) => void
  addStep: (step: ActivityStep) => void
  updateStep: (id: string, updates: Partial<ActivityStep>) => void
  setVisible: (visible: boolean) => void
  showWidget: () => void
  reset: () => void
}

const MAX_STEPS = 6

export const useActivityStore = create<ActivityStore>((set) => ({
  status: 'idle',
  phase: 'idle',
  currentTool: null,
  toolProgress: null,
  stepsLog: [],
  startedAt: null,
  visible: false,

  setRunning: () => set({
    status: 'running',
    phase: 'thinking',
    stepsLog: [],
    toolProgress: null,
    currentTool: null,
    startedAt: Date.now(),
    // НЕ ставим visible: true здесь — visible ставится только через
    // activity:show (из minimize/blur listener или onRunStatus когда
    // shouldShow=true). Иначе виджет появляется даже когда окно активно.
  }),

  setDone: () => set({
    status: 'done',
    phase: 'idle',
    currentTool: null,
    toolProgress: null,
  }),

  setError: () => set({
    status: 'error',
    phase: 'idle',
    currentTool: null,
    toolProgress: null,
  }),

  setPhase: (phase) => set({ phase }),

  setCurrentTool: (tool) => set({ currentTool: tool }),

  setToolProgress: (progress) => set({ toolProgress: progress }),

  addStep: (step) => set(state => ({
    stepsLog: [...state.stepsLog, step].slice(-MAX_STEPS),
  })),

  updateStep: (id, updates) => set(state => ({
    stepsLog: state.stepsLog.map(s => s.id === id ? { ...s, ...updates } : s),
  })),

  setVisible: (visible) => set({ visible }),

  /** Показать виджет без сброса состояния (для minimize listener) */
  showWidget: () => set(state => ({
    visible: state.status === 'running',
  })),

  reset: () => set({
    status: 'idle',
    phase: 'idle',
    currentTool: null,
    toolProgress: null,
    stepsLog: [],
    startedAt: null,
    visible: false,
  }),
}))
