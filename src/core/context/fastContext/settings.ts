/**
 * Fast Context settings + progress types.
 *
 * Previously lived in indexer.ts next to a 500-line TypeScript indexer that the
 * Rust sidecar replaced. Only the settings reader and the progress shape are
 * still part of the live path.
 */

import type Store from 'electron-store'
import {
  DEFAULT_INDEXING_SETTINGS,
  getIndexSettingsFromRecord,
  type IndexingSettings,
} from '../fastContextSettings'

/** Reads IndexingSettings from electron-store, merging defaults. Main-only. */
export function getIndexSettings(store?: Store): IndexingSettings {
  const defaults = DEFAULT_INDEXING_SETTINGS
  if (!store) return defaults
  try {
    const all = (store as unknown as { store: Record<string, unknown> }).store
    return getIndexSettingsFromRecord(all)
  } catch {
    return defaults
  }
}

/** Progress events emitted to the tool UI while a request runs. */
export interface IndexProgress {
  stage: 'indexing' | 'retrieving' | 'summarizing' | 'done' | 'error'
  detail?: string
  filesProcessed?: number
  filesTotal?: number
  filesFound?: Array<{ path: string; score: number; why: string }>
}

export type ProgressCallback = (p: IndexProgress) => void
