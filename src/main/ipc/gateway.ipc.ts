/**
 * Gateway models & status IPC handlers.
 *
 * Pulls the model catalog and live status from Syntee-Gateway:
 *  - /v1/models              → list of models/groups with capabilities + status
 *  - /v1/model-status/buckets → per-model hourly uptime (for status panel)
 *  - /v1/provider-status      → per-provider request counts + uptime
 *
 * All requests run from the main process with JWT bearer auth (auto-refresh
 * on 401). The renderer never sees the token — it goes through IPC.
 */
import { ipcMain } from 'electron'
import {
  getGatewayAuthToken,
  getGatewayApiUrl,
  GatewayAuthError,
} from '../services/gatewayClient'
import { hasTokens } from '../services/tokenStore'
import { setGatewayModelsCache } from './providers.ipc'
import type { ModelMeta } from '../../shared/types'

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
  /** 'operational' | 'degraded' | 'down' for models; 'available' | 'unavailable' for groups */
  status?: string
}

export interface GatewayModelsResponse {
  object: string
  data: GatewayModel[]
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

const GATEWAY_PROVIDER_ID = 'syntee-gateway'

/** Преобразует GatewayModel в ModelMeta для UI/ModelPicker. */
function toModelMeta(m: GatewayModel): ModelMeta {
  const caps: ModelMeta['capabilities'] = []
  if (m.supports_vision) caps.push('vision')
  if (m.supports_tools) caps.push('tools')
  if (m.supports_streaming) caps.push('code')
  if (!caps.length) caps.push('tools', 'code')

  let speed: ModelMeta['speed'] = 'fast'
  if (m.max_tokens && m.max_tokens > 200_000) speed = 'slow'
  else if (m.max_tokens && m.max_tokens > 32_000) speed = 'medium'

  // Цены gateway — per_1k_tokens; ModelMeta — за 1M (×1000).
  const inputPrice = m.pricing ? m.pricing.input_price * 1000 : undefined
  const outputPrice = m.pricing ? m.pricing.output_price * 1000 : undefined

  return {
    id: m.id,
    providerId: GATEWAY_PROVIDER_ID,
    name: m.display_name || m.id,
    contextWindow: m.max_tokens ?? 0,
    inputPrice,
    outputPrice,
    speed,
    capabilities: caps,
    description: m.description ?? (m.routing_mode ? `Маршрут: ${m.routing_mode}` : undefined),
  }
}

async function gatewayFetch<T>(path: string): Promise<T> {
  if (!hasTokens()) {
    throw new GatewayAuthError('Not authenticated with Syntee-Gateway')
  }
  const token = await getGatewayAuthToken()
  if (!token) {
    throw new GatewayAuthError('No valid session')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  let res: Response
  try {
    res = await fetch(`${getGatewayApiUrl()}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (res.status === 401) {
    throw new GatewayAuthError('Session expired', 401)
  }
  if (!res.ok) {
    throw new Error(`Gateway ${path} → HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

export function registerGatewayIPC(): void {
  ipcMain.handle('gateway:fetchModels', async (): Promise<GatewayModel[]> => {
    try {
      const data = await gatewayFetch<GatewayModelsResponse>('/v1/models')
      const models = data.data ?? []
      setGatewayModelsCache(models.map(toModelMeta))
      return models
    } catch {
      return []
    }
  })

  ipcMain.handle('gateway:fetchModelStatus', async (): Promise<ModelStatusBuckets[]> => {
    try {
      return await gatewayFetch<ModelStatusBuckets[]>('/v1/model-status/buckets?hours=12')
    } catch {
      return []
    }
  })

  ipcMain.handle('gateway:fetchProviderStatus', async (): Promise<ProviderStatusRow[]> => {
    try {
      return await gatewayFetch<ProviderStatusRow[]>('/v1/provider-status?hours=1')
    } catch {
      return []
    }
  })

  ipcMain.handle('gateway:isAvailable', () => hasTokens())
}
