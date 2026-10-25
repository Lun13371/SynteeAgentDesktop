/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const fastContext = path.join(root, 'src/core/context/fastContext')

// Fast Context is Rust-only: indexing, parsing, ranking and watching live in
// Sidecar/. These assertions exist because the TypeScript path was deleted once
// already and nothing stopped it from quietly growing back.

test('the deleted TypeScript fast-context modules stay deleted', () => {
  for (const name of [
    'indexer.ts',
    'symbols.ts',
    'symbolsCache.ts',
    'invertedIndex.ts',
    'fileHash.ts',
    'state.ts',
    'artifacts.ts',
  ]) {
    assert.equal(fs.existsSync(path.join(fastContext, name)), false, `${name} should not exist`)
  }
})

test('the fast-context barrel exposes only the Rust-backed API', () => {
  const src = fs.readFileSync(path.join(fastContext, 'index.ts'), 'utf8')
  for (const gone of ['buildRepoMapSlice', 'extractSymbols', 'getParsedSymbols', 'buildInvertedIndex', 'quickHash']) {
    assert.ok(!src.includes(gone), `barrel should not re-export ${gone}`)
  }
  assert.match(src, /export \{ runFastContext \} from '\.\/orchestrator'/)
  assert.match(src, /getIndexSettings/)
})

test('no source file loads WASM tree-sitter grammars any more', () => {
  const offenders = []
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) continue
      const src = fs.readFileSync(full, 'utf8')
      if (/require\(['"]web-tree-sitter|from ['"]web-tree-sitter|tree-sitter-wasms|initFastContextWasmDir/.test(src)) {
        offenders.push(path.relative(root, full))
      }
    }
  }
  walk(path.join(root, 'src'))
  walk(path.join(root, 'scripts'))
  assert.deepEqual(offenders, [])
})

test('usageTracker stays renderer-safe (no node built-ins, no child process)', () => {
  const src = fs.readFileSync(path.join(root, 'src/core/tokens/usageTracker.ts'), 'utf8')
  for (const forbidden of ["from 'fs'", "from 'path'", "from 'child_process'", 'sidecarClient']) {
    assert.ok(!src.includes(forbidden), `usageTracker must not import ${forbidden}`)
  }
  // The Rust counter is injected, not imported: the renderer pulls
  // DEFAULT_CONTEXT_SETTINGS through contextManager → usageTracker.
  assert.match(src, /export function setRemoteTokenCounter/)
  assert.match(src, /export async function estimateMessagesTokensAsync/)
  assert.match(src, /export async function truncateToTokensAsync/)
})

test('the Rust protocol advertises the token and symbol methods', () => {
  const src = fs.readFileSync(path.join(root, 'Sidecar/src/commands.rs'), 'utf8')
  for (const method of ['tokensCount', 'tokensCountBatch', 'tokensTruncate', 'symbols']) {
    assert.ok(src.includes(`"${method}"`), `commands.rs should expose ${method}`)
  }
  assert.match(src, /parser_backend: "tree-sitter/)
  assert.match(src, /ranking: "field-weighted/)
  assert.ok(fs.existsSync(path.join(root, 'Sidecar/src/tokens.rs')))
  assert.ok(fs.existsSync(path.join(root, 'Sidecar/src/ast.rs')))
})

test('the index uses the same tree-sitter parser as the symbols command', () => {
  // Regression guard: the index used to be built by the lexical scanner while
  // only the on-demand `symbols` call used tree-sitter, so everything the
  // search ranked came from line regexes.
  const indexer = fs.readFileSync(path.join(root, 'Sidecar/src/indexer.rs'), 'utf8')
  assert.match(indexer, /ast::extract/)
  const walker = fs.readFileSync(path.join(root, 'Sidecar/src/walker.rs'), 'utf8')
  // One traversal, source files ordered before artifacts.
  assert.equal((walker.match(/WalkDir::new/g) ?? []).length, 2, 'walk_project + walk_subtree only')
})

test('the retrieval quality switches stay wired end to end', () => {
  const search = fs.readFileSync(path.join(root, 'Sidecar/src/search.rs'), 'utf8')
  assert.match(search, /synonyms::translations/, 'RU→EN bridging must stay enabled')
  assert.match(search, /MAX_DEFINITIONS_PER_HIT/)
  assert.match(search, /enum MatchKind/)
  assert.ok(fs.existsSync(path.join(root, 'Sidecar/src/synonyms.rs')))
  assert.ok(fs.existsSync(path.join(root, 'Sidecar/src/text.rs')))

  const client = fs.readFileSync(path.join(root, 'src/core/context/fastContext/sidecarClient.ts'), 'utf8')
  assert.match(client, /matchKind/, 'the search result type must carry matchKind')
  assert.match(client, /maxAgeMs/, 'index must accept a freshness window')

  const orchestrator = fs.readFileSync(path.join(root, 'src/core/context/fastContext/orchestrator.ts'), 'utf8')
  assert.match(orchestrator, /INDEX_MAX_AGE_MS/, 'a query must not re-walk a fresh index')
})
