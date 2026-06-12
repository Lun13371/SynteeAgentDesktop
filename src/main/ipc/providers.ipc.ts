import { ipcMain } from 'electron'
import type Store from 'electron-store'
import type { Provider, ModelMeta, ModelAssignment, ModelParams } from '../../shared/types'
import { BUILTIN_MODELS, BUILTIN_PROVIDERS_META } from '../../shared/data/builtinModels'

const DEFAULT_PARAMS: ModelParams = {
  temperature: 0.7,
  maxTokens: 4096,
  systemPrompt: '',
  streaming: true,
}

const DEFAULT_ASSIGNMENTS: ModelAssignment[] = [
  { role: 'main',      modelId: 'claude-sonnet-4-6', providerId: 'anthropic' },
  { role: 'fast',      modelId: 'claude-haiku-4-5',  providerId: 'anthropic' },
  { role: 'vision',    modelId: 'gpt-4o',             providerId: 'openai' },
  { role: 'stt',       modelId: '',                   providerId: '' },
  { role: 'tts',       modelId: '',                   providerId: '' },
  { role: 'embedding', modelId: '',                   providerId: '' },
  { role: 'memory',    modelId: 'claude-haiku-4-5',   providerId: 'anthropic' },
  { role: 'summary',   modelId: 'claude-haiku-4-5',   providerId: 'anthropic' },
]

export function registerProviderIPC(store: Store): void {

  // ── Providers ─────────────────────────────────────────────────────────────

  ipcMain.handle('providers:getAll', () => {
    return store.get('providers', []) as Provider[]
  })

  ipcMain.handle('providers:save', (_e, provider: Provider) => {
    const list = store.get('providers', []) as Provider[]
    const idx = list.findIndex(p => p.id === provider.id)
    if (idx >= 0) list[idx] = provider
    else list.push(provider)
    store.set('providers', list)
  })

  ipcMain.handle('providers:delete', (_e, id: string) => {
    const list = (store.get('providers', []) as Provider[]).filter(p => p.id !== id)
    store.set('providers', list)
    // Удаляем кастомные модели этого провайдера
    const models = (store.get('customModels', []) as ModelMeta[]).filter(m => m.providerId !== id)
    store.set('customModels', models)
  })

  ipcMain.handle('providers:testKey', async (_e, providerId: string) => {
    const list = store.get('providers', []) as Provider[]
    const provider = list.find(p => p.id === providerId)
    if (!provider) return { ok: false, error: 'Провайдер не найден' }
    try {
      const res = await fetch(`${provider.baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${provider.apiKey}`,
          'x-api-key': provider.apiKey,
        },
      })
      return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('providers:fetchModels', async (_e, providerId: string) => {
    const list = store.get('providers', []) as Provider[]
    const provider = list.find(p => p.id === providerId)
    if (!provider) return []

    let fetched: ModelMeta[] = []

    try {
      const res = await fetch(`${provider.baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${provider.apiKey}`,
          'x-api-key': provider.apiKey,
        },
      })
      if (res.ok) {
        const data = await res.json() as { data?: { id: string }[] }
        const ids: string[] = (data.data || []).map((m: { id: string }) => m.id)

        fetched = ids.map(id => {
          // Обогащаем метаданными из встроенной базы если есть
          const known = BUILTIN_MODELS.find(b => b.id === id && b.providerId === providerId)
          if (known) return known
          return {
            id,
            providerId,
            name: id,
            contextWindow: 0,
            speed: 'medium' as const,
            capabilities: [],
            description: '',
          }
        })

        // Сохраняем timestamp
        const idx = list.findIndex(p => p.id === providerId)
        if (idx >= 0) {
          list[idx].lastModelsFetch = Date.now()
          store.set('providers', list)
        }
      }
    } catch { /* провайдер недоступен */ }

    // Добавляем ручные переопределения
    const overrides = provider.modelsOverride || []
    for (const id of overrides) {
      if (!fetched.find(m => m.id === id)) {
        fetched.push({ id, providerId, name: id, contextWindow: 0, speed: 'medium', capabilities: [] })
      }
    }

    return fetched
  })

  // ── Models ─────────────────────────────────────────────────────────────────

  ipcMain.handle('models:getAll', () => {
    const providers = store.get('providers', []) as Provider[]
    const custom = store.get('customModels', []) as ModelMeta[]
    const cached = store.get('cachedModels', []) as ModelMeta[]

    // Встроенные модели для настроенных провайдеров
    const enabledIds = providers.filter(p => p.enabled).map(p => p.id)
    const builtin = BUILTIN_MODELS.filter(m => enabledIds.includes(m.providerId))

    // Мёрджим: кастомные и кэшированные перекрывают встроенные
    const all = [...builtin]
    for (const m of [...cached, ...custom]) {
      if (!all.find(x => x.id === m.id && x.providerId === m.providerId)) {
        all.push(m)
      }
    }
    return all
  })

  ipcMain.handle('models:saveCustom', (_e, model: ModelMeta) => {
    const list = store.get('customModels', []) as ModelMeta[]
    const idx = list.findIndex(m => m.id === model.id && m.providerId === model.providerId)
    if (idx >= 0) list[idx] = { ...model, isCustom: true }
    else list.push({ ...model, isCustom: true })
    store.set('customModels', list)
  })

  ipcMain.handle('models:deleteCustom', (_e, modelId: string, providerId: string) => {
    const list = (store.get('customModels', []) as ModelMeta[])
      .filter(m => !(m.id === modelId && m.providerId === providerId))
    store.set('customModels', list)
  })

  // ── Assignments ────────────────────────────────────────────────────────────

  ipcMain.handle('models:getAssignments', () => {
    return store.get('modelAssignments', DEFAULT_ASSIGNMENTS) as ModelAssignment[]
  })

  ipcMain.handle('models:setAssignment', (_e, assignment: ModelAssignment) => {
    const list = store.get('modelAssignments', DEFAULT_ASSIGNMENTS) as ModelAssignment[]
    const idx = list.findIndex(a => a.role === assignment.role)
    if (idx >= 0) list[idx] = assignment
    else list.push(assignment)
    store.set('modelAssignments', list)
  })

  // ── Params ─────────────────────────────────────────────────────────────────

  ipcMain.handle('models:getParams', () => {
    return store.get('modelParams', DEFAULT_PARAMS) as ModelParams
  })

  ipcMain.handle('models:setParams', (_e, params: Partial<ModelParams>) => {
    const current = store.get('modelParams', DEFAULT_PARAMS) as ModelParams
    store.set('modelParams', { ...current, ...params })
  })
}
