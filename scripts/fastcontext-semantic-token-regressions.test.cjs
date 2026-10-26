/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { getEncoding } = require('js-tiktoken')
const root = require('node:path').join(__dirname, '..')

// The TypeScript fast-context worker queue is gone: indexing/watching lives in
// the Rust sidecar. These regressions cover the remaining TypeScript pieces.

test('semantic indexing lives in Rust: no ONNX or foreground wait left in TypeScript', () => {
  const tsPath = require('node:path').join(root, 'src/core/memory/semanticIndex.ts')
  const ts = fs.readFileSync(tsPath, 'utf8')

  // TS остался тонким планировщиком: никакой модели, никакого ONNX в main.
  assert.doesNotMatch(ts, /@huggingface\/transformers/)
  assert.doesNotMatch(ts, /pipeline\('feature-extraction'/)
  assert.doesNotMatch(ts, /_e5Pipeline|initE5|embedPassage/)

  // Тяжёлая работа делегируется в sidecar.
  assert.match(ts, /sidecarSemanticIndex/)
  assert.match(ts, /sidecarSemanticSearch/)
  assert.match(ts, /resolveSemanticModelPaths/)

  // Планировщик обязан оставаться остановимым и не плодить параллельные циклы.
  assert.match(ts, /stopSemanticIndexer\(\): void \{\s*_stopRequested = true/)
  assert.match(ts, /if \(_running\) \{[\s\S]*return/)
})

test('Rust semantic indexer gates pages, skipped rows and orphan cleanup on foreground idle', () => {
  const indexPath = require('node:path').join(root, 'Sidecar/src/semantic/index.rs')
  const src = fs.readFileSync(indexPath, 'utf8')

  // 2-секундная тишина после активности пользователя — как было в TS.
  assert.match(src, /FOREGROUND_QUIET_MS: u64 = 2_000/)
  // Ожидание ограничено бюджетом цикла, а не бесконечное.
  assert.match(src, /fn wait_for_foreground_idle\(cycle_started: Instant, budget: Duration\) -> bool/)
  assert.match(src, /if cycle_started\.elapsed\(\) >= budget \{\s*return false/)

  // Гейт стоит перед страницей, перед skipped-строкой и перед очисткой.
  assert.match(src, /if !wait_for_foreground_idle\(cycle_started, budget\) \{\s*break;\s*\}\s*let rows = fetch_page/)
  assert.match(src, /content_hash == hash && model == E5_MODEL_TAG[\s\S]*wait_for_foreground_idle\(cycle_started, budget\)[\s\S]*stats\.skipped \+= 1/)
  assert.match(src, /wait_for_foreground_idle\(cycle_started, budget\)[\s\S]*cleanup_orphans\(connection, source\)/)

  // Бюджет на цикл — то, чего не было в TS (цикл растягивался на 16.7 минуты).
  assert.match(src, /DEFAULT_BUDGET_MS: u64 = 60_000/)
  assert.match(src, /budget_exhausted/)
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
