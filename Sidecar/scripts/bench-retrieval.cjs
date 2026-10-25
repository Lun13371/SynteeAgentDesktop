/* Development harness: measure index and search timings against a real project.
 *
 * Usage (from the repo root):
 *   node Sidecar/scripts/bench-retrieval.cjs [projectId] [workdir]
 *
 * It works on a COPY of the live database, so it never writes to the app's
 * index, and it always removes the copy afterwards. Without arguments it uses
 * the first project in the database and its workdir.
 */
/* global require, __dirname, process, console */
/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const Database = require('better-sqlite3')

const repoRoot = path.join(__dirname, '..', '..')
const binaryName = process.platform === 'win32' ? 'syntee-sidecar.exe' : 'syntee-sidecar'
const binary = [
  path.join(repoRoot, 'resources', 'sidecar', binaryName),
  path.join(repoRoot, 'Sidecar', 'target', 'release', binaryName),
  path.join(repoRoot, 'Sidecar', 'target', 'debug', binaryName),
].find(candidate => fs.existsSync(candidate))
if (!binary) {
  console.error('sidecar binary not found; run Sidecar/scripts/build.ps1 first')
  process.exit(1)
}

const sourceDb = process.env.SYNTEE_DB_PATH || path.join(process.env.APPDATA || '', 'SynteeHelper', 'syntee.db')
if (!fs.existsSync(sourceDb)) {
  console.error(`database not found: ${sourceDb}`)
  process.exit(1)
}

const reader = new Database(sourceDb, { readonly: true })
const project = process.argv[2]
  ? reader.prepare('SELECT id, workdir FROM projects WHERE id = ?').get(process.argv[2])
  : reader.prepare('SELECT id, workdir FROM projects ORDER BY last_used DESC LIMIT 1').get()
reader.close()
if (!project) {
  console.error('no project found in the database')
  process.exit(1)
}
const projectId = project.id
const workdir = process.argv[3] || project.workdir
console.log(`project: ${projectId}\nworkdir: ${workdir}\nbinary:  ${binary}\n`)

const tempDb = path.join(os.tmpdir(), `syntee-bench-${process.pid}.db`)
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(tempDb + suffix) } catch { /* fresh copy */ }
}
fs.copyFileSync(sourceDb, tempDb)
try { fs.copyFileSync(`${sourceDb}-wal`, `${tempDb}-wal`) } catch { /* no wal */ }

const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] })
let buffer = ''
const pending = new Map()
child.stdout.on('data', chunk => {
  buffer += chunk.toString('utf8')
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    const resolve = pending.get(message.id)
    if (resolve) { pending.delete(message.id); resolve(message) }
  }
})
child.stderr.on('data', chunk => process.stderr.write(`[sidecar] ${chunk}`))
let nextId = 1
function call(method, params) {
  const id = nextId++
  return new Promise(resolve => {
    pending.set(id, resolve)
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })
}

const queries = process.argv.slice(4).length
  ? process.argv.slice(4)
  : ['fast context index', 'token counting', 'кеш индексация', 'как работает поиск файлов']

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tempDb + suffix) } catch { /* already gone */ }
  }
}

;(async () => {
  const capabilities = await call('capabilities', {})
  console.log('capabilities:', JSON.stringify(capabilities.result))

  for (const [label, params] of [
    ['cold ', { dbPath: tempDb, projectId, workdir }],
    ['warm ', { dbPath: tempDb, projectId, workdir }],
    ['fresh', { dbPath: tempDb, projectId, workdir, maxAgeMs: 60000 }],
  ]) {
    const started = Date.now()
    const response = await call('index', params)
    console.log(`index ${label}: ${Date.now() - started}ms ${JSON.stringify(response.result ?? response.error)}`)
  }

  for (const query of queries) {
    const started = Date.now()
    const response = await call('search', { dbPath: tempDb, projectId, query, maxFiles: 50, maxTokens: 8000 })
    const ms = Date.now() - started
    const result = response.result
    if (!result) {
      console.log(`search "${query}" ERROR ${JSON.stringify(response.error)}`)
      continue
    }
    const definitions = result.topFiles.reduce((sum, file) => sum + file.definitions.length, 0)
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8')
    const top = result.topFiles.slice(0, 3).map(file => `${path.basename(file.path)}:${file.score.toFixed(1)}`)
    console.log(
      `search "${query}" ${ms}ms kind=${result.matchKind} files=${result.topFiles.length} defs=${definitions} json=${bytes}\n    ${top.join(' ')}`
    )
  }

  await call('shutdown', {})
  child.kill()
  setTimeout(() => { cleanup(); process.exit(0) }, 300)
})().catch(error => {
  console.error(error)
  child.kill()
  setTimeout(() => { cleanup(); process.exit(1) }, 300)
})