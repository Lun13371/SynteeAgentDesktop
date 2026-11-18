/**
 * Update store — zustand mirror of the main-process UpdateChecker state.
 *
 * The renderer never polls directly: the main process pushes state changes
 * via window.syntee.updates.onStateChanged, and this store subscribes on
 * first access. Components read from the store; the store is the single
 * source of truth for "is there an update?" / "is it force?" / "how far along
 * is the background download?".
 *
 * `install` приходит из main-процесса: скачивание начинается сразу после
 * обнаружения версии, поэтому к моменту открытия модалки файл обычно уже
 * готов (phase = 'ready') и кнопка установки активна.
 */
import { create } from 'zustand'
import type { InstallState, QuitAndInstallResult, UpdateManifest, UpdateState } from '../../../shared/types'

interface UpdateStore extends UpdateState {
  /** Hydrate from main on first mount of any component that needs update state. */
  init: () => Promise<void>
  /** Manual re-check (settings "Check now" button). */
  check: () => Promise<void>
  /** Dismiss the current update (badge disappears). No-op for force updates. */
  dismiss: () => Promise<void>
  /**
   * Применяет обновление: ставит уже скачанный файл (или докачивает),
   * запускает установщик и закрывает приложение. Возвращает { ok: false,
   * error }, если запустить не удалось — приложение продолжает работу.
   */
  quitAndInstall: () => Promise<QuitAndInstallResult>
}

const IDLE_INSTALL: InstallState = { phase: 'idle', received: 0, total: 0, error: null }

let initialized = false

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  status: 'idle',
  available: null,
  dismissed: [],
  lastCheckedAt: 0,
  error: null,
  install: { ...IDLE_INSTALL },

  init: async () => {
    if (initialized) return
    initialized = true
    // Subscribe to pushes from main.
    window.syntee.updates.onStateChanged((state) => set(state))
    // Fetch the initial snapshot.
    const state = await window.syntee.updates.getStatus()
    set(state)
  },

  check: async () => {
    const state = await window.syntee.updates.check()
    set(state)
  },

  dismiss: async () => {
    const { available } = get()
    if (!available) return
    const state = await window.syntee.updates.dismiss(available.version)
    set(state)
  },

  quitAndInstall: async () => {
    return window.syntee.updates.quitAndInstall()
  },
}))

/** Convenience selector: is there a non-dismissed update available? */
export const selectUpdateAvailable = (s: UpdateStore): boolean =>
  s.status === 'available' && s.available !== null

/** Convenience selector: is there a FORCE update (renders non-dismissable modal)? */
export const selectForceUpdate = (s: UpdateStore): UpdateManifest | null =>
  s.status === 'available' && s.available?.force ? s.available : null

/** Доля скачанного файла 0..1 (0, пока размер неизвестен). */
export const selectDownloadProgress = (s: UpdateStore): number => {
  const { received, total } = s.install
  if (!total || total <= 0) return 0
  return Math.min(1, received / total)
}
