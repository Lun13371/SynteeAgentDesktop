import { create } from 'zustand'
import type { ModelMeta, Provider } from '../../../shared/types'
import { getBrandLogo, getProviderColor, type BrandLogo } from '../utils/modelFormat'

export interface RecentModel {
  modelId: string
  providerId: string
  usedAt: number
}

export interface PinnedModel {
  modelId: string
  providerId: string
}

interface RecentModelsStore {
  recent: RecentModel[]
  pinned: PinnedModel[]
  loaded: boolean
  load: () => Promise<void>
  addRecent: (modelId: string, providerId: string) => Promise<void>
  togglePin: (modelId: string, providerId: string) => Promise<void>
  isPinned: (modelId: string, providerId: string) => boolean
}

export const useRecentModelsStore = create<RecentModelsStore>((set, get) => ({
  recent: [],
  pinned: [],
  loaded: false,

  load: async () => {
    try {
      const [recent, pinned] = await Promise.all([
        window.syntee.models.getRecent() as Promise<RecentModel[]>,
        window.syntee.models.getPinned() as Promise<PinnedModel[]>,
      ])
      set({ recent: recent ?? [], pinned: pinned ?? [], loaded: true })
    } catch {
      set({ loaded: true })
    }
  },

  addRecent: async (modelId: string, providerId: string) => {
    // Оптимистичное обновление
    set(state => {
      const filtered = state.recent.filter(r => !(r.modelId === modelId && r.providerId === providerId))
      filtered.unshift({ modelId, providerId, usedAt: Date.now() })
      return { recent: filtered.slice(0, 5) }
    })
    try {
      await window.syntee.models.addRecent(modelId, providerId)
    } catch {
      // Тихо — не критично
    }
  },

  togglePin: async (modelId: string, providerId: string) => {
    // Оптимистичное обновление
    set(state => {
      const exists = state.pinned.some(p => p.modelId === modelId && p.providerId === providerId)
      if (exists) {
        return { pinned: state.pinned.filter(p => !(p.modelId === modelId && p.providerId === providerId)) }
      }
      return { pinned: [...state.pinned, { modelId, providerId }] }
    })
    try {
      const result = await window.syntee.models.togglePin(modelId, providerId) as PinnedModel[]
      set({ pinned: result ?? [] })
    } catch {
      // Тихо
    }
  },

  isPinned: (modelId: string, providerId: string) => {
    return get().pinned.some(p => p.modelId === modelId && p.providerId === providerId)
  },
}))

/**
 * Возвращает ModelMeta + Provider для каждого recent-элемента,
 * фильтруя те, которых больше нет в списках.
 */
export function resolveRecentModels(
  recent: RecentModel[],
  models: ModelMeta[],
  providers: Provider[],
): { model: ModelMeta; provider: Provider; logo: BrandLogo | null; color: string }[] {
  const providerMap = new Map(providers.map(p => [p.id, p]))
  const result: { model: ModelMeta; provider: Provider; logo: BrandLogo | null; color: string }[] = []
  for (const r of recent) {
    const model = models.find(m => m.id === r.modelId && m.providerId === r.providerId)
    if (!model) continue
    const provider = providerMap.get(r.providerId)
    if (!provider) continue
    const logo = getBrandLogo(provider.type, model.id, model.name, provider.iconUrl)
    const color = getProviderColor(r.providerId)
    result.push({ model, provider, logo, color })
  }
  return result
}

/**
 * Возвращает ModelMeta + Provider для каждого pinned-элемента.
 */
export function resolvePinnedModels(
  pinned: PinnedModel[],
  models: ModelMeta[],
  providers: Provider[],
): { model: ModelMeta; provider: Provider; logo: BrandLogo | null; color: string }[] {
  const providerMap = new Map(providers.map(p => [p.id, p]))
  const result: { model: ModelMeta; provider: Provider; logo: BrandLogo | null; color: string }[] = []
  for (const p of pinned) {
    const model = models.find(m => m.id === p.modelId && m.providerId === p.providerId)
    if (!model) continue
    const provider = providerMap.get(p.providerId)
    if (!provider) continue
    const logo = getBrandLogo(provider.type, model.id, model.name, provider.iconUrl)
    const color = getProviderColor(p.providerId)
    result.push({ model, provider, logo, color })
  }
  return result
}
