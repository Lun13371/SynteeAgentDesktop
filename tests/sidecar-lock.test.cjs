/* global require, __dirname, process, console */
/* eslint-disable @typescript-eslint/no-require-imports -- Node test harness transpiles TS on the fly. */
const assert = require('node:assert/strict')
const { Worker } = require('node:worker_threads')
const { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')

// The lock registry lives in TypeScript and is bundled by electron-vite, so the
// test transpiles just that file to run it in plain Node (main + worker thread).
const sourcePath = resolve(__dirname, '../src/core/context/fastContext/sidecarLock.ts')
const outDir = mkdtempSync(join(tmpdir(), 'syntee-lock-module-'))
const modulePath = join(outDir, 'sidecarLock.js')

function buildLockModule() {
  const source = readFileSync(sourcePath, 'utf-8')
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(modulePath, transpiled.outputText, 'utf-8')
  return modulePath
}

test('sidecar lock registry flags duplicates and releases cleanly', async () => {
  buildLockModule()
  const dataDir = mkdtempSync(join(tmpdir(), 'syntee-lock-data-'))
  const dbPath = join(dataDir, 'syntee.db')
  const previousDbPath = process.env.SYNTEE_DB_PATH
  process.env.SYNTEE_DB_PATH = dbPath
  try {
    const lock = require(modulePath)
    const first = lock.acquireSidecarLock()
    assert.equal(first.lockPath, join(dataDir, 'syntee-sidecar.lock'))
    assert.equal(first.duplicate, false)
    assert.equal(first.holders.length, 1)
    assert.equal(first.holders[0].owner, 'main')
    assert.ok(existsSync(first.lockPath), 'lock file must exist while a sidecar is running')

    const workerCode = `
      const { parentPort, workerData } = require('node:worker_threads')
      const lock = require(workerData.modulePath)
      const snapshot = lock.acquireSidecarLock()
      parentPort.postMessage({
        holders: snapshot.holders.length,
        duplicate: snapshot.duplicate,
        others: snapshot.others.length,
        owner: snapshot.holders.at(-1).owner,
      })
    `
    const message = await new Promise((resolvePromise, rejectPromise) => {
      const worker = new Worker(workerCode, { eval: true, workerData: { modulePath } })
      worker.once('message', value => { worker.terminate(); resolvePromise(value) })
      worker.once('error', error => { worker.terminate(); rejectPromise(error) })
    })

    assert.equal(message.holders, 2, 'both threads must be registered as sidecar owners')
    assert.equal(message.duplicate, true, 'a second sidecar in the same process is a duplicate')
    assert.equal(message.others, 1)
    assert.equal(message.owner, 'worker')

    const snapshot = lock.getSidecarLockSnapshot()
    assert.equal(snapshot.duplicate, true)
    assert.equal(snapshot.holders.length, 2)

    lock.releaseSidecarLock()
    const afterRelease = lock.getSidecarLockSnapshot()
    assert.equal(afterRelease.holders.length, 1, 'released holder must disappear')
    assert.equal(afterRelease.duplicate, false)
    assert.equal(JSON.parse(readFileSync(first.lockPath, 'utf-8')).length, 1)
  } finally {
    if (previousDbPath === undefined) delete process.env.SYNTEE_DB_PATH
    else process.env.SYNTEE_DB_PATH = previousDbPath
  }
})
