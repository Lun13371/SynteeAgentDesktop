/**
 * IPC handlers for the in-app update checker.
 *
 * The renderer calls these to:
 *   - check for updates (manual "Check now" button in settings)
 *   - get the current update state (badge visibility, manifest)
 *   - subscribe to state changes (badge appears/disappears in real time)
 *   - fetch the changelog history (for the settings "Changelog" tab)
 *   - dismiss the current update (badge goes away until a new version ships)
 *   - quit-and-install (triggers app.quit() → launcher applies staged update)
 *
 * The actual download + apply happens in syntee-launcher (Go); this module
 * only coordinates UI state. See src/main/updater/UpdateChecker.ts for the
 * polling logic and src/shared/types for UpdateManifest/UpdateState shapes.
 */
import { type BrowserWindow } from 'electron';
export declare function registerUpdatesIPC(getMainWindow: () => BrowserWindow | null): void;
