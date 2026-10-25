/* global require, __dirname, process */
/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const Database = require('better-sqlite3')

// End-to-end checks of the Rust retrieval path: what the index stores, what the
// ranking does with it, and what the incremental watcher path does to it.
// These pin behaviour that unit tests inside the sidecar cannot see — the wire
// shape the TypeScript side consumes.

const root = path.join(__dirname, '..')
const binaryName = process.platform === 'win32' ? 'syntee-sidecar.exe' : 'syntee-sidecar'
const candidates = [
  path.join(root, 'resources', 'sidecar', binaryName),
  path.join(root, 'Sidecar', 'target', 'release', binaryName),
  path.join(root, 'Sidecar', 'target', 'debug', binaryName),
]
const binary = candidates.find(candidate => fs.existsSync(candidate))
const skip = binary ? false : 'sidecar binary not built'

/** Run a fixed list of requests against one sidecar process. */
function run(requests) {
  const input = requests.map(request => JSON.stringify(request)).join('\n') + '\n'
  const result = spawnSync(binary, [], { input, encoding: 'utf8', timeout: 60_000, windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  const responses = new Map()
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    const row = JSON.parse(line)
    responses.set(String(row.id), row)
  }
  const shutdown = { id: 'shutdown', method: 'shutdown', params: {} }
  responses.set('shutdown', shutdown)
  return responses
}

function makeProject(label, files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `syntee-sidecar-${label}-`))
  const workdir = path.join(base, 'repo')
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(workdir, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  const dbPath = path.join(base, 'syntee.db')
  const db = new Database(dbPath)
  db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY)')
  db.close()
  return { base, workdir, dbPath, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) }
}

function openDb(dbPath) {
  return new Database(dbPath, { readonly: true })
}

test('search ranks definition owners and bridges a Russian query', { skip }, () => {
  const project = makeProject('retrieval', {
    'src/cacheStore.ts': 'export const cacheStore = { get(key: string) { return key } }\n',
    'src/Button.tsx': 'export function Button() { return null }\n',
    'tests/cache-store.test.cjs': "const { cacheStore } = require('../src/cacheStore')\nvoid cacheStore\n",
  })
  try {
    const responses = run([
      {
        id: 'index',
        method: 'index',
        params: { dbPath: project.dbPath, projectId: 'p', workdir: project.workdir, options: { ignoreDirs: [] } },
      },
      {
        id: 'russian',
        method: 'search',
        params: { dbPath: project.dbPath, projectId: 'p', query: 'кеш хранилище', maxFiles: 5, maxTokens: 1000 },
      },
      {
        id: 'english',
        method: 'search',
        params: { dbPath: project.dbPath, projectId: 'p', query: 'cache store', maxFiles: 5, maxTokens: 1000 },
      },
      {
        id: 'fresh',
        method: 'index',
        params: {
          dbPath: project.dbPath, projectId: 'p', workdir: project.workdir,
          options: { ignoreDirs: [] }, maxAgeMs: 60_000,
        },
      },
    ])

    assert.equal(responses.get('index').result.filesChanged, 3)
    assert.equal(responses.get('index').result.skipped, false)

    // A Russian query used to produce zero lexical matches and fall back to
    // "most structurally important files".
    const russian = responses.get('russian').result
    assert.notEqual(russian.matchKind, 'fallback')
    assert.ok(russian.topFiles[0].path.endsWith('cacheStore.ts'), russian.topFiles.map(f => f.path).join(', '))

    // The file that *defines* the symbol must outrank the test that imports it.
    const english = responses.get('english').result
    assert.ok(english.topFiles[0].path.endsWith('cacheStore.ts'), english.topFiles.map(f => f.path).join(', '))
    assert.equal(english.matchKind, 'exact')
    for (const file of english.topFiles) {
      assert.ok(file.definitions.length <= 12, `trimmed payload expected, got ${file.definitions.length}`)
    }

    assert.equal(responses.get('fresh').result.skipped, true)
    assert.equal(responses.get('fresh').result.filesFound, 3)
  } finally {
    project.cleanup()
  }
})

test('index stores precomputed search columns and gates the FTS mirror', { skip }, () => {
  const project = makeProject('columns', {
    'src/tokens.rs': 'pub fn count_tokens(text: &str) -> usize { text.len() }\n',
  })
  try {
    run([{
      id: 'index',
      method: 'index',
      params: { dbPath: project.dbPath, projectId: 'p', workdir: project.workdir, options: { ignoreDirs: [] } },
    }])
    const db = openDb(project.dbPath)
    try {
      const columns = db.prepare('PRAGMA table_info(fast_context_sidecar_index)').all().map(row => row.name)
      for (const column of ['search_path', 'search_names', 'search_body', 'definitions_count']) {
        assert.ok(columns.includes(column), `missing column ${column}`)
      }
      const row = db.prepare('SELECT search_names, search_body, search_path, definitions_count FROM fast_context_sidecar_index').get()
      // tree-sitter (not the lexical scanner) produced these names.
      assert.match(row.search_names, /count tokens/)
      assert.match(row.search_path, /tokens rs/)
      assert.ok(row.definitions_count >= 1)
      // One file is far below the scan threshold: no FTS writes to pay for.
      const fts = db.prepare('SELECT COUNT(*) AS rows FROM fast_context_sidecar_fts').get()
      assert.equal(fts.rows, 0)
    } finally {
      db.close()
    }
  } finally {
    project.cleanup()
  }
})

test('incremental indexing honours ignoreDirs, expands directories and prunes removals', { skip }, () => {
  const project = makeProject('incremental', { 'src/app.ts': 'export const app = 1\n' })
  try {
    const options = { ignoreDirs: ['node_modules'] }
    const common = { dbPath: project.dbPath, projectId: 'p', workdir: project.workdir, options }
    run([{ id: 'index', method: 'index', params: common }])

    // An edit inside an ignored directory must be refused.
    const ignoredDir = path.join(project.workdir, 'node_modules', 'pkg')
    fs.mkdirSync(ignoredDir, { recursive: true })
    fs.writeFileSync(path.join(ignoredDir, 'index.js'), 'module.exports = 1\n')

    // A new file and a new directory with files inside it.
    fs.writeFileSync(path.join(project.workdir, 'src', 'extra.ts'), 'export const extra = 2\n')
    const feature = path.join(project.workdir, 'src', 'feature')
    fs.mkdirSync(feature, { recursive: true })
    fs.writeFileSync(path.join(feature, 'one.ts'), 'export const one = 1\n')
    fs.writeFileSync(path.join(feature, 'two.ts'), 'export const two = 2\n')

    const responses = run([
      {
        id: 'ignored',
        method: 'indexChangedPaths',
        params: { ...common, changedPaths: [path.join(ignoredDir, 'index.js')] },
      },
      {
        id: 'file',
        method: 'indexChangedPaths',
        params: { ...common, changedPaths: [path.join(project.workdir, 'src', 'extra.ts')] },
      },
      { id: 'dir', method: 'indexChangedPaths', params: { ...common, changedPaths: [feature] } },
    ])
    assert.equal(responses.get('ignored').result.filesChanged, 0)
    assert.equal(responses.get('file').result.filesChanged, 1)
    assert.equal(responses.get('dir').result.filesFound, 2)

    let db = openDb(project.dbPath)
    const afterAdds = db.prepare('SELECT COUNT(*) AS rows FROM fast_context_sidecar_index').get().rows
    db.close()
    assert.equal(afterAdds, 4, 'app, extra and the two files in src/feature')

    // Removing the directory must remove its rows, not just the directory entry.
    fs.rmSync(feature, { recursive: true, force: true })
    const removal = run([{
      id: 'removed',
      method: 'indexChangedPaths',
      params: { ...common, changedPaths: [feature] },
    }])
    assert.ok(removal.get('removed').result.filesRemoved >= 1)

    db = openDb(project.dbPath)
    const afterRemoval = db.prepare('SELECT COUNT(*) AS rows FROM fast_context_sidecar_index').get().rows
    db.close()
    assert.equal(afterRemoval, 2, 'only src/app.ts and src/extra.ts remain')
  } finally {
    project.cleanup()
  }
})

test('symbols expose tree-sitter line ranges and a truncation flag', { skip }, () => {
  const project = makeProject('symbols', {
    'src/store.ts': 'export const loadUser = async (id: string) => {\n  return id\n}\n\nexport class Store {\n  private cache = new Map()\n}\n',
  })
  try {
    const responses = run([{
      id: 'symbols',
      method: 'symbols',
      params: { path: path.join(project.workdir, 'src', 'store.ts'), skipReferences: true },
    }])
    const result = responses.get('symbols').result
    assert.equal(result.parser, 'tree-sitter')
    assert.equal(result.truncated, false)
    const loadUser = result.definitions.find(definition => definition.name === 'loadUser')
    assert.ok(loadUser, JSON.stringify(result.definitions))
    // The `const` arrow function used to be invisible, and every range was one line.
    assert.equal(loadUser.lineStart, 1)
    assert.equal(loadUser.lineEnd, 3)
    assert.ok(result.definitions.some(definition => definition.name === 'Store'))
    assert.ok(result.definitions.some(definition => definition.name === 'cache'))
  } finally {
    project.cleanup()
  }
})