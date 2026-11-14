/**
 * Rust token counter adapter.
 *
 * Wires the sidecar's cl100k_base BPE (Sidecar/src/tokens.rs) into the
 * renderer-safe token API in usageTracker.ts. Import this only from main-process
 * or worker-thread code: it pulls in the sidecar client, which uses node
 * built-ins and spawns a child process.
 *
 * The registration is idempotent — main and every ai-worker thread own their own
 * sidecar child, so each thread registers its own adapter pointing at that child.
 */

import { sidecarTokensCountBatch, sidecarTokensTruncate } from '../sidecar/sidecarClient'
import { setRemoteTokenCounter, hasRemoteTokenCounter } from './usageTracker'

/**
 * A sidecar that is missing or crash-looping must not turn every token count
 * into a thrown promise. After a few consecutive failures the counter steps
 * aside and usageTracker falls back to the in-process estimate; the next
 * install (worker start / app restart) tries again.
 */
const MAX_CONSECUTIVE_FAILURES = 3
let consecutiveFailures = 0

function noteFailure(error: unknown): void {
  consecutiveFailures++
  if (consecutiveFailures === MAX_CONSECUTIVE_FAILURES) {
    console.warn(
      '[tokens] Rust token counter unavailable after %d attempts, using in-process estimate: %s',
      consecutiveFailures,
      error instanceof Error ? error.message : String(error),
    )
    setRemoteTokenCounter(null)
  }
}

function noteSuccess(): void {
  consecutiveFailures = 0
}

export function installRustTokenCounter(): void {
  if (hasRemoteTokenCounter()) return
  consecutiveFailures = 0
  setRemoteTokenCounter({
    countBatch: async texts => {
      try {
        const counts = await sidecarTokensCountBatch(texts)
        noteSuccess()
        return counts
      } catch (error) {
        noteFailure(error)
        return null
      }
    },
    truncate: async (text, maxTokens) => {
      try {
        const result = await sidecarTokensTruncate(text, maxTokens)
        noteSuccess()
        return result
      } catch (error) {
        noteFailure(error)
        throw error
      }
    },
  })
}

export function uninstallRustTokenCounter(): void {
  setRemoteTokenCounter(null)
}
