/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { getEncoding } = require('js-tiktoken')
const root = require('node:path').join(__dirname, '..')

// The TypeScript fast-context worker queue is gone: indexing/watching lives in
// the Rust sidecar. These regressions cover the remaining TypeScript pieces.

test('semantic foreground wait gates page SELECT, skipped rows and orphan cleanup, and requires 2s idle', () => {
  const src = fs.readFileSync(require('node:path').join(root, 'src/core/memory/semanticIndex.ts'), 'utf8')
  assert.match(src, /_foregroundQuietUntil = Date\.now\(\) \+ 2_000/)
  assert.match(src, /if \(Date\.now\(\) >= _foregroundQuietUntil\) return true/)
  assert.match(src, /if \(!await waitForForegroundIdle\(\)\) return stats\s*const rows = fetchSourcePage/)
  assert.match(src, /existing\.content_hash === hash[\s\S]*if \(!await waitForForegroundIdle\(\)\) return stats[\s\S]*stats\.skipped\+\+/)
  assert.match(src, /if \(!await waitForForegroundIdle\(\)\) return stats\s*const orphans = cleanupOrphans/)
  assert.match(src, /stopSemanticIndexer\(\): void \{\s*_stopRequested = true/)
})

test('usage token LRU source invokes tiktoken with allowed special token array; exact count matches installed API', () => {
  const src = fs.readFileSync(require('node:path').join(root, 'src/core/tokens/usageTracker.ts'), 'utf8')
  assert.match(src, /encode\(text, \[\], \['all'\]\)/)
  assert.match(src, /TOKEN_CACHE_MAX_ENTRIES = 500/)
  assert.match(src, /TOKEN_CACHE_MAX_BYTES = 4 \* 1024 \* 1024/)
  assert.match(src, /_tokenCache\.delete\(text\)[\s\S]*_tokenCache\.set\(text, cached\)/)
  const encoder = getEncoding('cl100k_base')
  const text = 'ordinary text <|endoftext|>'
  assert.throws(() => encoder.encode(text, [], 'all'), /special token/i)
  const exact = encoder.encode(text, [], ['all']).length
  assert.equal(exact, 8)
  assert.equal(encoder.encode(text, [], ['all']).length, exact)
})
