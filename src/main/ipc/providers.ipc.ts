import { ipcMain } from 'electron'
import type Store from 'electron-store'
import type { Provider, ModelMeta, ModelAssignment, ModelParams } from '../../shared/types'
import { BUILTIN_MODELS } from '../../shared/data/builtinModels'
import { getCatalogModel, inferSpeed, getCatalogStatus, type CatalogModelInfo } from '../../core/tokens/modelCatalog'

// ── Кэш enrichment для models:getAll ────────────────────────────────────────
// getCatalogModel() в худшем случае (проксирующие провайдеры) сканирует весь
// кэш models.dev (globalSearch), что дорого при большом списке custom/cached
// моделей. Кэшируем результат по паре providerId:modelId в памяти процесса
// и сбрасываем кэш, когда каталог сам обновился (см. lastFetch ниже) —
// иначе после refreshCatalog() (раз в 24ч) enrichment остался бы старым.
const enrichCache = new Map<string, CatalogModelInfo | null>()
let enrichCacheBuiltAtFetch: number | null = null

function getCatalogModelCached(providerId: string, modelId: string): CatalogModelInfo | null {
  const { lastFetch } = getCatalogStatus()
  if (lastFetch !== enrichCacheBuiltAtFetch) {
    enrichCache.clear()
    enrichCacheBuiltAtFetch = lastFetch
  }
  const key = `${providerId}:${modelId}`
  if (enrichCache.has(key)) return enrichCache.get(key) ?? null
  const result = getCatalogModel(providerId, modelId)
  enrichCache.set(key, result)
  return result
}

const DEFAULT_PARAMS: ModelParams = {
  temperature: 0.7,
  maxTokens: 4096,
  systemPrompt: '',
  streaming: true,
}

/**
 * Round-robin: возвращает следующий ключ провайдера и обновляет индекс в store.
 * Если apiKeys пустой или не задан — возвращает apiKey (основной).
 */
export function getNextApiKey(store: Store, providerId: string): string {
  const list = store.get('providers', []) as Provider[]
  const idx = list.findIndex(p => p.id === providerId)
  if (idx < 0) return ''
  const p = list[idx]
  const keys = (p.apiKeys || []).filter(k => k.trim())
  if (keys.length === 0) return p.apiKey || ''
  if (keys.length === 1) return keys[0]
  const current = (p.rrIndex ?? 0) % keys.length
  const key = keys[current]
  list[idx] = { ...p, rrIndex: (current + 1) % keys.length }
  store.set('providers', list)
  return key
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

  // ── Round-robin helper (экспортируем для AIClient) ─────────────────────────
  // Возвращает следующий ключ для провайдера и сохраняет индекс в store
  // Вызывается из AIClient перед каждым запросом

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
    if (!provider) return { ok: false, error: 'Провайдер не найден', models: [] }

    let fetched: ModelMeta[] = []
    let error: string | null = null

    try {
      const url = provider.baseUrl.replace(/\/$/, '') + '/models'
      const res = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${provider.apiKey || ''}`,
          'Content-Type': 'application/json',
        },
      })
      if (!res.ok) {
        error = `HTTP ${res.status}: ${res.statusText}`
      } else {
        const data = await res.json() as { data?: { id: string }[]; models?: { id: string }[] }
        // Поддерживаем оба формата: { data: [...] } и { models: [...] }
        const items = data.data || data.models || []
        const ids: string[] = items.map((m: { id: string }) => m.id).filter(Boolean)

        fetched = ids.map(id => {
          const known = BUILTIN_MODELS.find(b => b.id === id)
          if (known) return { ...known, providerId }
          // Пытаемся получить статы из каталога models.dev
          const fromCatalog = getCatalogModel(providerId, id)
          return {
            id, providerId,
            name: fromCatalog?.displayName ?? id,
            contextWindow: fromCatalog?.contextWindow ?? 0,
            inputPrice: fromCatalog ? fromCatalog.inputPricePerM / 100 : undefined,
            outputPrice: fromCatalog ? fromCatalog.outputPricePerM / 100 : undefined,
            speed: inferSpeed(id),
            capabilities: fromCatalog?.capabilities ?? [],
            description: fromCatalog?.description ?? '',
          }
        })

        // Обновляем timestamp провайдера
        const idx = list.findIndex(p => p.id === providerId)
        if (idx >= 0) {
          list[idx].lastModelsFetch = Date.now()
          store.set('providers', list)
        }

        // Сохраняем модели в cachedModels — убираем старые от этого провайдера, добавляем новые
        const cached = store.get('cachedModels', []) as ModelMeta[]
        const filtered = cached.filter(m => m.providerId !== providerId)
        store.set('cachedModels', [...filtered, ...fetched])
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }

    // Добавляем ручные переопределения
    const overrides = provider.modelsOverride || []
    for (const id of overrides) {
      if (!fetched.find(m => m.id === id)) {
        const fromCatalog = getCatalogModel(providerId, id)
        fetched.push({
          id, providerId,
          name: fromCatalog?.displayName ?? id,
          contextWindow: fromCatalog?.contextWindow ?? 0,
          inputPrice: fromCatalog ? fromCatalog.inputPricePerM / 100 : undefined,
          outputPrice: fromCatalog ? fromCatalog.outputPricePerM / 100 : undefined,
          speed: inferSpeed(id),
          capabilities: fromCatalog?.capabilities ?? [],
          description: fromCatalog?.description ?? '',
        })
      }
    }

    return { ok: !error, error, models: fetched, count: fetched.length }
  })

  // ── Models ─────────────────────────────────────────────────────────────────

  ipcMain.handle('models:getAll', () => {
    const providers = store.get('providers', []) as Provider[]
    const custom = store.get('customModels', []) as ModelMeta[]
    const cached = store.get('cachedModels', []) as ModelMeta[]

    // Если провайдеры ещё не настроены — показываем все встроенные
    // Если настроены — только для тех у которых есть ключ (enabled)
    const enabledIds = providers.filter(p => p.enabled).map(p => p.id)
    const builtin = enabledIds.length > 0
      ? BUILTIN_MODELS.filter(m => enabledIds.includes(m.providerId))
      : BUILTIN_MODELS

    const all = [...builtin]

    // Cached/custom модели. Если модель сохранена до расширения каталога
    // (пустые capabilities + нет description) — дозаполняем статы «на лету».
    for (const m of [...cached, ...custom]) {
      if (all.find(x => x.id === m.id && x.providerId === m.providerId)) continue
      const needsEnrich = m.capabilities.length === 0 && !m.description
      if (needsEnrich) {
        const fromCatalog = getCatalogModelCached(m.providerId, m.id)
        if (fromCatalog) {
          all.push({
            ...m,
            name: m.name === m.id ? (fromCatalog.displayName ?? m.name) : m.name,
            contextWindow: m.contextWindow || fromCatalog.contextWindow,
            inputPrice: m.inputPrice ?? (fromCatalog ? fromCatalog.inputPricePerM / 100 : undefined),
            outputPrice: m.outputPrice ?? (fromCatalog ? fromCatalog.outputPricePerM / 100 : undefined),
            capabilities: fromCatalog.capabilities ?? m.capabilities,
            description: fromCatalog.description ?? m.description,
          })
          continue
        }
      }
      all.push(m)
    }

    for (const p of providers) {
      for (const id of (p.modelsOverride || [])) {
        if (!all.find(x => x.id === id && x.providerId === p.id)) {
          const fromCatalog = getCatalogModelCached(p.id, id)
          all.push({
            id, providerId: p.id,
            name: fromCatalog?.displayName ?? id,
            contextWindow: fromCatalog?.contextWindow ?? 0,
            inputPrice: fromCatalog ? fromCatalog.inputPricePerM / 100 : undefined,
            outputPrice: fromCatalog ? fromCatalog.outputPricePerM / 100 : undefined,
            speed: inferSpeed(id),
            capabilities: fromCatalog?.capabilities ?? [],
            description: fromCatalog?.description ?? '',
          })
        }
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
