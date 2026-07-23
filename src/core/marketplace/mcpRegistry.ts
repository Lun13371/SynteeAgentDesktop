/**
 * Клиент официального MCP Registry (registry.modelcontextprotocol.io).
 *
 * API: GET /v0/servers?search={query}&limit={n}&cursor={cursor}
 * Возвращает { servers: [{ server, _meta }], metadata: { nextCursor, count } }.
 *
 * Фильтруем только isLatest + status active/deprecated (не берём старые версии).
 * Кэшируем результаты поиска на 5 минут (простой in-memory LRU-подобный кэш).
 */

import type { MarketplaceMcpServer, McpRemoteOption, McpPackageOption } from '../../shared/types'

const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io/v0'
const CACHE_TTL_MS = 5 * 60 * 1000

interface RegistryHeader {
  name: string
  description?: string
  isRequired?: boolean
  isSecret?: boolean
  value?: string
}
interface RegistryRemote {
  type: string
  url: string
  headers?: RegistryHeader[]
}
interface RegistryEnvVar {
  name: string
  description?: string
  isRequired?: boolean
  isSecret?: boolean
}
interface RegistryPackage {
  registryType: string
  identifier: string
  version: string
  runtimeHint?: string
  packageArguments?: Array<{ value: string; type: string }>
  environmentVariables?: RegistryEnvVar[]
}
interface RegistryServerEntry {
  name: string
  title?: string
  description?: string
  version: string
  websiteUrl?: string
  icons?: Array<{ src: string }>
  repository?: { url: string }
  remotes?: RegistryRemote[]
  packages?: RegistryPackage[]
}
interface RegistryItem {
  server: RegistryServerEntry
  _meta?: {
    'io.modelcontextprotocol.registry/official'?: {
      status?: string
      isLatest?: boolean
    }
  }
}
interface RegistryResponse {
  servers: RegistryItem[]
  metadata?: { nextCursor?: string; count?: number }
}

interface CacheEntry {
  data: { servers: MarketplaceMcpServer[]; nextCursor?: string }
  expiresAt: number
}
const cache = new Map<string, CacheEntry>()

function mapEntry(item: RegistryItem): MarketplaceMcpServer {
  const s = item.server
  const remotes: McpRemoteOption[] = (s.remotes ?? [])
    .filter(r => r.type === 'sse' || r.type === 'streamable-http')
    .map(r => ({
      type: r.type as 'sse' | 'streamable-http',
      url: r.url,
      headers: r.headers?.map(h => ({
        name: h.name,
        description: h.description ?? '',
        isRequired: h.isRequired ?? false,
        isSecret: h.isSecret ?? false,
        value: h.value,
      })),
    }))
  const packages: McpPackageOption[] = (s.packages ?? [])
    .filter(p => p.registryType === 'npm' || p.registryType === 'pypi' || p.registryType === 'oci')
    .map(p => ({
      registryType: p.registryType as 'npm' | 'pypi' | 'oci',
      identifier: p.identifier,
      version: p.version,
      runtimeHint: p.runtimeHint,
      packageArguments: p.packageArguments?.map(a => a.value),
      environmentVariables: p.environmentVariables?.map(e => ({
        name: e.name,
        description: e.description ?? '',
        isRequired: e.isRequired ?? false,
        isSecret: e.isSecret ?? false,
      })),
    }))
  return {
    id: s.name,
    title: s.title ?? s.name,
    description: s.description ?? '',
    version: s.version,
    repositoryUrl: s.repository?.url,
    websiteUrl: s.websiteUrl,
    iconUrl: s.icons?.[0]?.src,
    remotes,
    packages,
  }
}

/**
 * Поиск MCP-серверов в официальном реестре.
 * @param query   поисковый запрос (пустая строка = все сервера)
 * @param limit   размер страницы (по умолчанию 30)
 * @param cursor  курсор пагинации (из предыдущего ответа)
 */
/** Комбинирует несколько AbortSignal в один (abort когда любой aborted). */
function combineSignals(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const valid = signals.filter((s): s is AbortSignal => !!s && !s.aborted)
  if (valid.length === 0) {
    // Если какой-то уже aborted — вернём его
    const aborted = signals.find(s => s?.aborted)
    return aborted
  }
  if (valid.length === 1) return valid[0]
  const controller = new AbortController()
  for (const sig of valid) {
    sig.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return controller.signal
}

export async function searchMcpServers(
  query: string,
  limit = 30,
  cursor?: string,
  externalSignal?: AbortSignal,
): Promise<{ servers: MarketplaceMcpServer[]; nextCursor?: string }> {
  const cacheKey = `${query}|${limit}|${cursor ?? ''}`
  const cached = cache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.data

  const url = new URL(`${REGISTRY_BASE}/servers`)
  if (query.trim()) url.searchParams.set('search', query.trim())
  url.searchParams.set('limit', String(limit))
  if (cursor) url.searchParams.set('cursor', cursor)

  // Официальный registry.modelcontextprotocol.io заметно медленный на практике
  // (наблюдались ответы 5-24с даже без поискового запроса) — 10с таймаута
  // не хватало и запрос падал по AbortSignal раньше, чем реестр успевал
  // ответить. 25с — компромисс между отказом от зависания UI навечно и
  // реальной латентностью стороннего API.
  const timeoutSignal = AbortSignal.timeout(25_000)
  const signal = combineSignals([timeoutSignal, externalSignal])
  const res = await fetch(url.toString(), { signal })
  if (!res.ok) throw new Error(`MCP Registry вернул ${res.status}`)
  const json = (await res.json()) as RegistryResponse

  const seen = new Set<string>()
  const servers: MarketplaceMcpServer[] = []
  for (const item of json.servers ?? []) {
    const meta = item._meta?.['io.modelcontextprotocol.registry/official']
    if (meta?.isLatest === false) continue
    if (meta?.status === 'deleted') continue
    if (seen.has(item.server.name)) continue
    seen.add(item.server.name)
    // Пропускаем сервера без единого способа подключения
    const mapped = mapEntry(item)
    if (mapped.remotes.length === 0 && mapped.packages.length === 0) continue
    servers.push(mapped)
  }

  const result = { servers, nextCursor: json.metadata?.nextCursor }
  cache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_TTL_MS })
  return result
}
