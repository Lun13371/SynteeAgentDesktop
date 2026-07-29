/**
 * Update server configuration.
 *
 * The update URL is resolved in priority order:
 *   1. SYNTEE_UPDATE_URL env var (explicit override — used in tests)
 *   2. SYNTEE_API_URL env var (the gateway base URL — same as the gateway
 *      client in services/gatewayClient.ts)
 *   3. http://localhost:8000 (dev fallback)
 *
 * The gateway exposes the public updates API at /api/public/updates — we
 * hardcode the path here so callers can just use checkUrl/changelogUrl/etc.
 */

const BASE =
  (process.env.SYNTEE_UPDATE_URL ?? process.env.SYNTEE_API_URL ?? 'http://localhost:8000').replace(/\/$/, '')

export const updatesBase = `${BASE}/api/public/updates`

export const checkUrl = (channel: string, current: string): string =>
  `${updatesBase}/check?channel=${encodeURIComponent(channel)}&current=${encodeURIComponent(current)}`

export const manifestUrl = (channel: string): string =>
  `${updatesBase}/manifest/${encodeURIComponent(channel)}`

export const changelogUrl = (channel: string, limit: number, current?: string): string =>
  `${updatesBase}/changelog?channel=${encodeURIComponent(channel)}&limit=${limit}${
    current ? `&current=${encodeURIComponent(current)}` : ''
  }`
