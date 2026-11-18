// ── Client auto-update (SynteeHelper desktop) ────────────────────────────
// Обновления приходят из GitHub Releases этого репозитория. Манифест
// собирается из ассетов релиза: .exe для Windows и .tar.zst для Linux.
// Скачивание и установка живут в src/main/updater/InstallerUpdater.ts.

/** Как ставится обновление. */
export type UpdateDelivery = 'installer' | 'archive'

export type UpdatePlatform = 'win32' | 'linux'

export interface UpdateManifest {
  /** NSIS-установщик (Windows) или переносимый архив (Linux). */
  delivery: UpdateDelivery
  /** Платформа, под которую собран артефакт. */
  platform: UpdatePlatform
  version: string
  channel: string
  zip_url: string
  zip_size: number
  sha256: string
  force: boolean
  min_version: string | null
  changelog: string | null
  released_at: string
}

export interface ChangelogEntry {
  version: string
  changelog: string | null
  released_at: string
  force: boolean
  is_current: boolean
}

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'no-update' | 'error'

/**
 * Фазы установки. Скачивание идёт в фоне сразу после обнаружения версии,
 * поэтому к моменту, когда пользователь жмёт «Перезапустить», файл обычно
 * уже проверен по SHA256.
 */
export type InstallPhase = 'idle' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'error'

export interface InstallState {
  phase: InstallPhase
  /** Сколько байт уже скачано. */
  received: number
  /** Полный размер файла (0, пока сервер не отдал content-length). */
  total: number
  error: string | null
}

export interface UpdateState {
  status: UpdateStatus
  available: UpdateManifest | null
  dismissed: string[]
  lastCheckedAt: number
  error: string | null
  install: InstallState
}

/**
 * Result of the quit-and-install flow (updates:quitAndInstall IPC). When
 * ok=false the app did NOT exit and the update was not applied — the UI shows
 * `error` and lets the user retry instead of dying silently.
 */
export interface QuitAndInstallResult {
  ok: boolean
  error?: string
}
