import { create } from 'zustand'
import { useAuthStore } from './auth.store'

// ── Types matching the billing IPC contract ──────────────────────────────

export interface Balance {
  balance: number
  held: number
}

export interface Transaction {
  id: string
  type: string
  amount: number
  balance_after: number
  description: string | null
  input_tokens: number | null
  output_tokens: number | null
  created_at: string
}

export interface UsageSummary {
  total_requests: number
  total_input_tokens: number
  total_output_tokens: number
  total_cost: number
}

export interface UsageTimeseriesPoint {
  timestamp: string
  requests: number
  input_tokens: number
  output_tokens: number
  cost: number
}

export interface UsageBreakdownRow {
  key: string
  requests: number
  input_tokens: number
  output_tokens: number
  tokens: number
  cost: number
  avg_latency_ms: number
}

export interface PlanInfo {
  code: string
  name: string
  price_rub: number
  price_usd: number
  five_hour_cost_limit: number
  weekly_cost_limit: number
  monthly_cost_limit: number
  rpm_limit: number
  is_recommended: boolean
  features: string[]
}

export interface UsageWindow {
  used: number
  limit: number
  reset_at: string
}

export interface PlanUsage {
  plan: PlanInfo
  usage: {
    five_hour: UsageWindow
    weekly: UsageWindow
    monthly: UsageWindow
    five_hour_total: number
    weekly_total: number
    monthly_total: number
  }
  balance: Balance
}

// ── Store ────────────────────────────────────────────────────────────────

interface BillingStore {
  balance: Balance | null
  planUsage: PlanUsage | null
  transactions: Transaction[]
  summary: UsageSummary | null
  timeseries: UsageTimeseriesPoint[]
  breakdown: UsageBreakdownRow[]
  loading: boolean
  error: string | null
  lastFetchAt: number
  load: (silent?: boolean) => Promise<void>
  loadTransactions: (limit?: number) => Promise<void>
  loadUsage: (hours?: number) => Promise<void>
}

export const useBillingStore = create<BillingStore>((set) => ({
  balance: null,
  planUsage: null,
  transactions: [],
  summary: null,
  timeseries: [],
  breakdown: [],
  loading: false,
  error: null,
  lastFetchAt: 0,

  load: async (silent = false) => {
    const user = useAuthStore.getState().user
    if (!user) {
      set({ balance: null, planUsage: null, summary: null })
      return
    }
    if (!silent) set({ loading: true, error: null })
    try {
      const [balance, planUsage, summary] = await Promise.all([
        window.syntee.billing.balance() as Promise<Balance | null>,
        window.syntee.billing.plan() as Promise<PlanUsage | null>,
        window.syntee.billing.summary({ hours: 24 }) as Promise<UsageSummary | null>,
      ])
      set({
        balance,
        planUsage,
        summary,
        loading: false,
        error: null,
        lastFetchAt: Date.now(),
      })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'Ошибка загрузки биллинга',
      })
    }
  },

  loadTransactions: async (limit = 20) => {
    const user = useAuthStore.getState().user
    if (!user) return
    try {
      const transactions = await window.syntee.billing.transactions({ limit }) as Transaction[]
      set({ transactions })
    } catch {
      // Тихо — не критично.
    }
  },

  loadUsage: async (hours = 24) => {
    const user = useAuthStore.getState().user
    if (!user) return
    try {
      const [timeseries, breakdown] = await Promise.all([
        window.syntee.billing.timeseries({ hours }) as Promise<UsageTimeseriesPoint[]>,
        window.syntee.billing.breakdown({ hours, by: 'model' }) as Promise<UsageBreakdownRow[]>,
      ])
      set({ timeseries, breakdown })
    } catch {
      // Тихо.
    }
  },
}))
