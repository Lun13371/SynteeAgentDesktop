import { create } from 'zustand'
import { useAuthStore } from './auth.store'

// ── Types matching the gateway IPC contract ──────────────────────────────

export type GatewayModelStatus = 'operational' | 'degraded' | 'down' | 'available' | 'unavailable'

export interface GatewayModel {
  id: string
  object: string
  created?: number
  owned_by?: string
  prefix?: string
  display_name?: string
  supports_streaming?: boolean
  supports_tools?: boolean
  supports_vision?: boolean
  max_tokens?: number
  pricing?: {
    input_price: number
    output_price: number
    unit: string
  }
  api_type?: string
  type?: string
  description?: string
  routing_mode?: string
  providers?: string[]
  status?: string
}

export interface UptimeBucket {
  timestamp: string
  requests: number
  success: number
  errors: number
  uptime: number
}

export interface ModelStatusBuckets {
  model: string
  buckets: UptimeBucket[]
}

export interface ProviderStatusRow {
  provider_id: string
  name: string
  prefix: string
  is_active: boolean
  status: string
  requests_1hr: number
  requests_10min: number
  success_count: number
  error_count: number
  uptime: number
  fallback_percentage: number
  total_keys: number
  active_keys: number
}

// ── Store ────────────────────────────────────────────────────────────────

/** ID виртуального провайдера Syntee-Gateway в списке Provider[]. */
export const GATEWAY_PROVIDER_ID = 'syntee-gateway'

interface GatewayModelsStore {
  /** Модели gateway (сырой ответ /v1/models). */
  models: GatewayModel[]
  /** Статусы по model id (operational/degraded/down/available/unavailable). */
  statusByModel: Record<string, GatewayModelStatus>
  /** Per-model uptime buckets для панели статуса. */
  modelStatusBuckets: ModelStatusBuckets[]
  /** Per-provider статистика. */
  providerStatus: ProviderStatusRow[]
  /** Загружается ли сейчас (для спиннеров). */
  loading: boolean
  /** Последняя ошибка загрузки (или null). */
  error: string | null
  /** Timestamp последней успешной загрузки (мс). */
  lastFetchAt: number
  /** Загрузить модели + статусы. Без аргументов — тихий режим (без loading). */
  load: (silent?: boolean) => Promise<void>
  /** Загрузить только статусы (для polling без смены списка моделей). */
  loadStatus: () => Promise<void>
}

const POLL_INTERVAL_MS = 60_000

let pollTimer: ReturnType<typeof setInterval> | null = null

export const useGatewayModelsStore = create<GatewayModelsStore>((set) => ({
  models: [],
  statusByModel: {},
  modelStatusBuckets: [],
  providerStatus: [],
  loading: false,
  error: null,
  lastFetchAt: 0,

  load: async (silent = false) => {
    const user = useAuthStore.getState().user
    if (!user) {
      set({ models: [], statusByModel: {}, modelStatusBuckets: [], providerStatus: [] })
      return
    }
    if (!silent) set({ loading: true, error: null })
    try {
      const [gatewayModels, buckets, providers] = await Promise.all([
        window.syntee.gateway.fetchModels() as Promise<GatewayModel[]>,
        window.syntee.gateway.fetchModelStatus() as Promise<ModelStatusBuckets[]>,
        window.syntee.gateway.fetchProviderStatus() as Promise<ProviderStatusRow[]>,
      ])

      const statusByModel: Record<string, GatewayModelStatus> = {}
      for (const m of gatewayModels) {
        if (m.id && m.status) {
          statusByModel[m.id] = m.status as GatewayModelStatus
        }
      }

      set({
        models: gatewayModels,
        statusByModel,
        modelStatusBuckets: buckets,
        providerStatus: providers,
        loading: false,
        error: null,
        lastFetchAt: Date.now(),
      })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'Ошибка загрузки моделей gateway',
      })
    }
  },

  loadStatus: async () => {
    const user = useAuthStore.getState().user
    if (!user) return
    try {
      const [buckets, providers] = await Promise.all([
        window.syntee.gateway.fetchModelStatus() as Promise<ModelStatusBuckets[]>,
        window.syntee.gateway.fetchProviderStatus() as Promise<ProviderStatusRow[]>,
      ])
      set({ modelStatusBuckets: buckets, providerStatus: providers })
    } catch {
      // Тихо — polling, не критично.
    }
  },
}))

/**
 * Запускает polling статусов каждые 60 секунд.
 * Возвращает функцию остановки. Безопасно вызывать多次 — новый таймер не запустится.
 */
export function startGatewayStatusPolling(): () => void {
  if (pollTimer) return () => {}
  pollTimer = setInterval(() => {
    useGatewayModelsStore.getState().loadStatus()
  }, POLL_INTERVAL_MS)
  return () => {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }
}

/**
 * Нормализует статус модели/группы из gateway в три категории для UI-бейджей.
 * Группы возвращают 'available'/'unavailable' — приводим к operational/down.
 */
export function normalizeStatus(
  status: GatewayModelStatus | undefined,
): 'operational' | 'degraded' | 'down' | 'unknown' {
  if (!status) return 'unknown'
  if (status === 'operational' || status === 'available') return 'operational'
  if (status === 'degraded') return 'degraded'
  if (status === 'down' || status === 'unavailable') return 'down'
  return 'unknown'
}
