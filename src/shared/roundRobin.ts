import type { Provider } from './types'

/**
 * Round-robin: возвращает следующий ключ провайдера и обновляет индекс.
 * Мутирует список на месте — вызывающий код сохраняет в store.
 * Если apiKeys пустой — возвращает apiKey (основной ключ).
 */
export function getNextApiKey(providers: Provider[], providerId: string): {
  key: string
  updatedProviders: Provider[]
} {
  const list = providers.map(p => ({ ...p }))
  const idx = list.findIndex(p => p.id === providerId)
  if (idx < 0) return { key: '', updatedProviders: list }

  const p = list[idx]
  const keys = (p.apiKeys || []).filter(k => k.trim())

  // Нет доп. ключей — возвращаем основной
  if (keys.length === 0) return { key: p.apiKey || '', updatedProviders: list }
  if (keys.length === 1) return { key: keys[0], updatedProviders: list }

  // Round-robin
  const current = (p.rrIndex ?? 0) % keys.length
  list[idx] = { ...p, rrIndex: (current + 1) % keys.length }
  return { key: keys[current], updatedProviders: list }
}
