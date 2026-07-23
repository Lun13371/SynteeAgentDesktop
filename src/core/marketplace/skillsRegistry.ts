/**
 * Клиент каталога Skills через GitHub Search API.
 *
 * Каждый "скилл" в каталоге — это GitHub-репозиторий, помеченный топиками
 * agent-skills / claude-skills / claude-code-skills. Репозиторий может
 * содержать несколько .md-файлов скиллов (например, в папке skills/).
 *
 * API: GET /search/repositories?q=topic:agent-skills+{query}&sort=stars
 * Rate limit: 10/min без токена, 30/min с токеном (store.integrations.github.token).
 */

import type { MarketplaceSkill } from '../../shared/types'

const CACHE_TTL_MS = 5 * 60 * 1000
const TOPICS = ['agent-skills', 'claude-skills', 'claude-code-skills']

interface GitHubRepoItem {
  full_name: string
  name: string
  description: string | null
  html_url: string
  stargazers_count: number
  language: string | null
  topics?: string[]
  license?: { spdx_id?: string; name?: string } | null
  updated_at: string
}
interface GitHubSearchResponse {
  total_count: number
  items: GitHubRepoItem[]
}

interface CacheEntry {
  data: { skills: MarketplaceSkill[]; hasMore: boolean }
  expiresAt: number
}
const cache = new Map<string, CacheEntry>()

function mapItem(item: GitHubRepoItem): MarketplaceSkill {
  return {
    id: item.full_name,
    name: item.name,
    fullName: item.full_name,
    description: item.description ?? '',
    htmlUrl: item.html_url,
    stars: item.stargazers_count,
    language: item.language,
    topics: item.topics ?? [],
    license: item.license?.spdx_id ?? item.license?.name ?? null,
    updatedAt: item.updated_at,
  }
}

/** Комбинирует несколько AbortSignal в один (abort когда любой aborted). */
function combineSignals(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const valid = signals.filter((s): s is AbortSignal => !!s && !s.aborted)
  if (valid.length === 0) {
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

/**
 * Поиск Skills-репозиториев по ключевому слову.
 * @param query    поисковый запрос (пустая строка = топ по звёздам)
 * @param page     номер страницы (с 1)
 * @param perPage  размер страницы (по умолчанию 24, макс 100)
 * @param githubToken  опциональный токен для повышения rate limit
 * @param externalSignal  внешний сигнал отмены (от кнопки "Отмена" в UI)
 */
export async function searchSkills(
  query: string,
  page = 1,
  perPage = 24,
  githubToken?: string,
  externalSignal?: AbortSignal,
): Promise<{ skills: MarketplaceSkill[]; hasMore: boolean }> {
  const cacheKey = `${query}|${page}|${perPage}`
  const cached = cache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.data

  const topicFilter = TOPICS.map(t => `topic:${t}`).join(' OR ')
  const q = query.trim()
    ? `(${topicFilter}) ${query.trim()}`
    : `topic:${TOPICS[0]}`

  const url = new URL('https://api.github.com/search/repositories')
  url.searchParams.set('q', q)
  url.searchParams.set('sort', 'stars')
  url.searchParams.set('order', 'desc')
  url.searchParams.set('page', String(page))
  url.searchParams.set('per_page', String(perPage))

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`

  const timeoutSignal = AbortSignal.timeout(10_000)
  const signal = combineSignals([timeoutSignal, externalSignal])
  const res = await fetch(url.toString(), { headers, signal })
  if (!res.ok) {
    if (res.status === 403) throw new Error('GitHub API rate limit превышен. Попробуйте позже или добавьте токен в настройках.')
    throw new Error(`GitHub Search API вернул ${res.status}`)
  }
  const json = (await res.json()) as GitHubSearchResponse

  const skills = json.items.map(mapItem)
  const hasMore = page * perPage < Math.min(json.total_count, 1000) // GitHub Search ограничен 1000 результатами

  const result = { skills, hasMore }
  cache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_TTL_MS })
  return result
}

/**
 * Получает содержимое README репозитория (для detail view).
 * @param fullName  "owner/repo"
 */
export async function getSkillReadme(fullName: string, githubToken?: string): Promise<string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.raw+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`

  const res = await fetch(`https://api.github.com/repos/${fullName}/readme`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) return ''
  return res.text()
}
