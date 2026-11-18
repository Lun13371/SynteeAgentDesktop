import type { UpdateManifest } from '../../shared/types'

/**
 * Обновления для standalone-инсталлятора (NSIS) читаются напрямую из GitHub
 * Releases этого репозитория. Пакетный канал лаунчера (`syntee-launcher` →
 * `syntee.fun/api/public/updates`) работает отдельно и этот файл не трогает.
 */
const repository = 'Lun13371/SynteeAgentDesktop'

/**
 * Текущая схема: один тег на релиз — `v<version>`, в нём лежат артефакты для
 * всех платформ. Старые релизы ставились под тегами `windows-v<version>`;
 * они всё ещё принимаются, чтобы уже установленные сборки не остались без
 * обновлений.
 */
const tagPrefixes = ['windows-v', 'v'] as const

type TagPrefix = (typeof tagPrefixes)[number]

const versionPattern = /^(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})$/

export function windowsInstallerUrl(version: string, tagPrefix: TagPrefix = 'v'): string | null {
  if (!versionPattern.test(version)) return null
  return `https://github.com/${repository}/releases/download/${tagPrefix}${version}/Syntee-Helper-Setup-${version}-x64.exe`
}

function splitTag(tag: string): { prefix: TagPrefix; version: string } | null {
  for (const prefix of tagPrefixes) {
    if (!tag.startsWith(prefix)) continue
    const version = tag.slice(prefix.length)
    if (versionPattern.test(version)) return { prefix, version }
  }
  return null
}

function compareVersions(a: string, b: string): number {
  const [am, an, ap] = a.split('.').map(Number)
  const [bm, bn, bp] = b.split('.').map(Number)
  return am - bm || an - bn || ap - bp
}

type Release = {
  draft?: boolean
  tag_name?: string
  body?: string
  published_at?: string
  assets?: Array<{ browser_download_url?: string; digest?: string; size?: number; state?: string }>
}

export function parseWindowsInstallerReleases(payload: unknown): UpdateManifest[] {
  if (!Array.isArray(payload)) throw new Error('Некорректный список релизов GitHub')
  const updates: UpdateManifest[] = []
  for (const release of payload as Release[]) {
    if (!release || release.draft !== false || typeof release.tag_name !== 'string') continue
    const tagged = splitTag(release.tag_name)
    if (!tagged) continue
    const { prefix, version } = tagged
    const url = windowsInstallerUrl(version, prefix)
    if (!url || typeof release.published_at !== 'string' || !Array.isArray(release.assets)) continue
    const asset = release.assets.find(item => item?.browser_download_url === url && item.state === 'uploaded')
    if (!asset || typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size <= 0
      || typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest)) continue
    updates.push({
      version, delivery: 'installer', channel: 'GitHub / Windows',
      zip_url: url, zip_size: asset.size, sha256: asset.digest.slice(7),
      force: false, min_version: null,
      changelog: typeof release.body === 'string' ? release.body : null,
      released_at: release.published_at,
    })
  }
  return updates.sort((a, b) => compareVersions(b.version, a.version))
}

export function findWindowsInstallerUpdate(releases: UpdateManifest[], current: string): UpdateManifest | null {
  if (!versionPattern.test(current)) return null
  return releases.find(release => compareVersions(release.version, current) > 0) ?? null
}

let pending: Promise<UpdateManifest[]> | undefined

export function fetchWindowsInstallerReleases(): Promise<UpdateManifest[]> {
  pending ??= fetch(`https://api.github.com/repos/${repository}/releases?per_page=100`, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(10_000),
  }).then(async response => {
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`)
    return parseWindowsInstallerReleases(await response.json())
  }).finally(() => { pending = undefined })
  return pending
}
