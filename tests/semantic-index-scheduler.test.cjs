/* global require, __dirname, console */
/* eslint-disable @typescript-eslint/no-require-imports -- Run the actual scheduler against an isolated SQLite fixture. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const Database = require('better-sqlite3')

const source = readFileSync(join(__dirname, '../src/core/memory/semanticIndex.ts'), 'utf8')
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS }
}).outputText

function harness() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE memory_items (id TEXT, title TEXT, content TEXT);
    CREATE TABLE messages (id TEXT, role TEXT, content TEXT);
    CREATE TABLE chat_summaries (chat_id TEXT, content TEXT);
    CREATE TABLE agent_logs (id TEXT, tool TEXT, result TEXT);
    CREATE TABLE pinned_messages (message_id TEXT);
    CREATE TABLE semantic_embeddings (source TEXT, source_id TEXT);
  `)
  const module = { exports: {} }
  const calls = { modelChecks: 0, cycles: 0 }
  vm.runInNewContext(code, {
    module, exports: module.exports, console,
    require: name => {
      if (name === '../db/handle') return { getDB: () => db }
      if (name === '../sidecar/sidecarClient') return {
        resolveSemanticModelPaths() {
          calls.modelChecks++
          return { modelPath: 'fixture.onnx', tokenizerPath: 'fixture.json' }
        },
        async sidecarSemanticIndex() {
          calls.cycles++
          return { totalIndexed: 0, totalFailed: 0, budgetExhausted: false }
        }
      }
      if (name === '../performanceDiagnostics') return { perfMark: () => 0, perfEvent() {} }
      if (name === './globalMemorySettings') return { getMemorySettings: () => ({}) }
      if (name === './store/_shared') return { rowToItem: row => row }
      if (name === 'path') return require('node:path')
      if (name === 'fs') return require('node:fs')
      throw Error(`Unexpected module ${name}`)
    }
  })
  return { db, calls, cycle: module.exports.runSemanticIndexingOnce }
}

test('empty profiles skip model preparation and resume when the first source appears', async () => {
  const h = harness()
  try {
    await h.cycle()
    assert.equal(h.calls.modelChecks, 0)
    assert.equal(h.calls.cycles, 0)
    h.db.exec("INSERT INTO messages VALUES ('first', 'user', 'hello')")
    await h.cycle()
    assert.equal(h.calls.cycles, 1)
  } finally { h.db.close() }
})

test('each Rust index source remains eligible, including rows with empty content', async () => {
  const inserts = [
    "INSERT INTO memory_items VALUES ('m', '', '')",
    "INSERT INTO messages VALUES ('m', 'user', '')",
    "INSERT INTO messages VALUES ('m', 'assistant', 'answer')",
    "INSERT INTO chat_summaries VALUES ('c', '')",
    "INSERT INTO agent_logs VALUES ('a', '', '')",
    "INSERT INTO messages VALUES ('m', 'system', 'pinned'); INSERT INTO pinned_messages VALUES ('m')"
  ]
  for (const insert of inserts) {
    const h = harness()
    try {
      h.db.exec(insert)
      await h.cycle()
      assert.equal(h.calls.cycles, 1, insert)
    } finally { h.db.close() }
  }
})

test('unpinned system messages and broken pin references do not load the model', async () => {
  const h = harness()
  try {
    h.db.exec("INSERT INTO messages VALUES ('system', 'system', 'divider'); INSERT INTO pinned_messages VALUES ('missing')")
    await h.cycle()
    assert.equal(h.calls.modelChecks, 0)
    assert.equal(h.calls.cycles, 0)
  } finally { h.db.close() }
})

test('orphan embeddings still trigger a cleanup cycle after sources are deleted', async () => {
  const h = harness()
  try {
    h.db.exec("INSERT INTO semantic_embeddings VALUES ('memory', 'deleted')")
    await h.cycle()
    assert.equal(h.calls.cycles, 1)
  } finally { h.db.close() }
})
