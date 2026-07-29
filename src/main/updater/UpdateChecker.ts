/**
 * UpdateChecker — main-process module that polls the gateway for new client
 * releases and broadcasts the result to the renderer via IPC.
 *
 * The launcher (syntee-launcher) does the REAL download + apply; this module
 * is purely informational: it shows the blue badge in the titlebar, the
 * changelog modal, and the non-dismissable force modal. When the user accepts
 * an update we call app.quit() — the launcher catches the exit, sees a staged
 * zip (downloaded in the background), and applies it before relaunching.
 *
 * Polling cadence: 30 minutes after the first check (which happens ~10s after
 * app ready so a cold start isn't blocked). A manual check is exposed via the
 * 'updates:check' IPC handler.
 */
import { app } from 'electron'
import Store from 'electron-store'
import type { UpdateManifest, UpdateState, UpdateStatus } from '../../shared/types'
import { checkUrl } from './config'

const POLL_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes
const FIRST_CHECK_DELAY_MS = 10_000

let state: UpdateState = {
  status: 'idle',
  available: null,
  dismissed: [],
  lastCheckedAt: 0,
  error: null,
}

let store: Store<Record<string, unknown>> | null = null
let listeners: Array<(s: UpdateState) => void> = []
let pollTimer: NodeJS.Timeout | null = null

function getStore(): Store<Record<string, unknown>> {
  if (!store) {
    store = new Store<Record<string, unknown>>({ name: 'updates', cwd: undefined })
    const saved = store.get('dismissedUpdates')
    if (Array.isArray(saved)) state.dismissed = saved as string[]
  }
  return store
}

function persistDismissed(): void {
  getStore().set('dismissedUpdates', state.dismissed)
}

function notify(): void {
  for (const fn of listeners) {
    try {
      fn(state)
    } catch {
      /* listener errors are non-fatal */
    }
  }
}

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  notify()
}

export function getUpdateState(): UpdateState {
  return state
}

export function subscribeUpdates(fn: (s: UpdateState) => void): () => void {
  listeners.push(fn)
  return () => {
    listeners = listeners.filter((l) => l !== fn)
  }
}

/**
 * Query the gateway for an update. Updates `state` and notifies listeners.
 * Safe to call manually (from the settings "Check now" button) — it sets
 * status='checking' for UI feedback.
 */
export async function checkForUpdates(): Promise<UpdateState> {
  setState({ status: 'checking', error: null })
  try {
    const current = app.getVersion()
    const channel = 'stable'
    const url = checkUrl(channel, current)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    let res: Response
    try {
      res = await fetch(url, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (res.status === 204) {
      // Up to date.
      setState({ status: 'no-update', available: null, lastCheckedAt: Date.now() })
      return state
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    const manifest = (await res.json()) as UpdateManifest
    // If the user dismissed this version, don't re-show the badge — but keep
    // it in state so the settings page can still see it.
    const dismissed = state.dismissed.includes(manifest.version)
    setState({
      status: dismissed ? 'no-update' : 'available',
      available: manifest,
      lastCheckedAt: Date.now(),
      error: null,
    })
    return state
  } catch (err) {
    setState({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      lastCheckedAt: Date.now(),
    })
    return state
  }
}

/**
 * Dismiss the currently-available update so the badge disappears. The version
 * is recorded in electron-store so it stays dismissed across restarts. A
 * force update ignores the dismiss list (handled in the renderer).
 */
export function dismissUpdate(version: string): void {
  if (!state.dismissed.includes(version)) {
    state.dismissed = [...state.dismissed, version]
    persistDismissed()
  }
  setState({ status: 'no-update' })
}

/**
 * Quit the app so the launcher can apply a staged update. The launcher sees
 * the client exit, finds a downloaded zip in staging/, swaps it in, and
 * relaunches the new build.
 */
export function quitAndInstall(): void {
  app.quit()
}

/**
 * Start the periodic poll. Called from src/main/index.ts after app.whenReady.
 */
export function startUpdatePolling(): void {
  // First check after a short delay so the app window is up before we hit
  // the network (cold start stays snappy).
  setTimeout(() => {
    checkForUpdates().catch(() => {})
  }, FIRST_CHECK_DELAY_MS)
  pollTimer = setInterval(() => {
    checkForUpdates().catch(() => {})
  }, POLL_INTERVAL_MS)
}

export function stopUpdatePolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

export type { UpdateStatus, UpdateManifest }
