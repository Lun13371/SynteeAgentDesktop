/**
 * LauncherBridge — ensures updater.exe exists next to the client.
 *
 * The Go launcher (syntee-launcher) copies itself into current/updater.exe
 * after every install and update. This module verifies the file exists and,
 * if missing, downloads a fresh copy from the gateway so the client can
 * always self-heal.
 *
 * The updater.exe is the same binary as syntee-launcher.exe — it just has
 * a different filename so the client can find it by convention.
 */
import { app } from 'electron'
import { existsSync, writeFileSync, statSync } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import { updatesBase } from './config'

/** URL for downloading the launcher binary from the gateway. */
const UPDATER_DOWNLOAD_URL = `${updatesBase.replace('/api/public/updates', '/api/public/launcher')}`

/** Minimum size in bytes for a valid updater (sanity check). */
const MIN_UPDATER_SIZE = 2 * 1024 * 1024 // 2 MB

/**
 * Find updater.exe in the client's working directory or the install dir.
 * The launcher installs to %LOCALAPPDATA%\Programs\Syntee Helper\ and copies
 * itself to current\updater.exe after every install/update.
 */
export function findUpdater(): string | null {
  const cwd = process.cwd()
  const exeDir = app.isPackaged ? process.resourcesPath : cwd
  const localAppData = process.env.LOCALAPPDATA || ''
  const installDir = localAppData
    ? join(localAppData, 'Programs', 'Syntee Helper')
    : ''

  // Check: cwd/updater.exe, exeDir/updater.exe, ../updater.exe, install dir
  const candidates = [
    join(cwd, 'updater.exe'),
    join(exeDir, 'updater.exe'),
    join(exeDir, '..', 'updater.exe'),
  ]
  if (installDir) {
    candidates.push(join(installDir, 'current', 'updater.exe'))
    candidates.push(join(installDir, 'syntee-launcher.exe'))
  }

  for (const p of candidates) {
    try {
      if (existsSync(p) && statSync(p).size >= MIN_UPDATER_SIZE) {
        return p
      }
    } catch {
      // stat failed — skip
    }
  }
  return null
}

/**
 * Download updater.exe from the website. Returns the path where it was saved,
 * or null on failure.
 */
export async function downloadUpdater(): Promise<string | null> {
  const dst = join(process.cwd(), 'updater.exe')
  try {
    const res = await fetch(UPDATER_DOWNLOAD_URL, { redirect: 'follow' })
    if (!res.ok) {
      console.error(`[LauncherBridge] download failed: HTTP ${res.status}`)
      return null
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < MIN_UPDATER_SIZE) {
      console.error(`[LauncherBridge] downloaded file too small: ${buf.length} bytes`)
      return null
    }
    writeFileSync(dst, buf)
    console.log(`[LauncherBridge] updater downloaded -> ${dst} (${buf.length} bytes)`)
    return dst
  } catch (err) {
    console.error(`[LauncherBridge] download error:`, err)
    return null
  }
}

/**
 * Ensure updater.exe exists. If not, download it from the website.
 * Returns the path to the updater, or null if it couldn't be found/downloaded.
 */
export async function ensureUpdater(): Promise<string | null> {
  let path = findUpdater()
  if (path) {
    return path
  }
  console.warn('[LauncherBridge] updater.exe not found, downloading from website...')
  path = await downloadUpdater()
  return path
}

/**
 * Launch the updater (launcher) with optional arguments.
 * The updater will check for updates, download, apply, and relaunch the client.
 */
export function launchUpdater(updaterPath: string, args: string[] = []): void {
  const child = spawn(updaterPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()
  console.log(`[LauncherBridge] launched updater: ${updaterPath} ${args.join(' ')}`)
}

/**
 * Check for updates by launching the updater.
 * This is an alternative to the in-app update checker — it launches the
 * Go launcher which has its own GUI for download/apply.
 */
export async function checkUpdatesViaLauncher(): Promise<boolean> {
  const updaterPath = await ensureUpdater()
  if (!updaterPath) {
    console.error('[LauncherBridge] cannot check updates: updater not available')
    return false
  }
  launchUpdater(updaterPath)
  return true
}
