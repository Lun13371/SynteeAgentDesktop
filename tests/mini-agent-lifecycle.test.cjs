/* global require, __dirname, console, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, process, Buffer */
/* eslint-disable @typescript-eslint/no-require-imports -- Exercise production lifecycle code with isolated dependencies. */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const ts = require('typescript')

function load(file, stubs, globals = {}) {
  const module = { exports: {} }
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, {
    module, exports: module.exports,
    require: name => Object.hasOwn(stubs, name) ? stubs[name] : require(name),
    console, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval,
    process, Buffer, ...globals,
  })
  return module.exports
}

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

function managerHarness() {
  const requests = []
  const queueTimers = new Set()
  const manager = load('src/main/localModels/LocalModelManager.ts', {
    electron: { app: {}, webContents: { getAllWebContents: () => [] } },
    '../../core/logger': { log: () => {} },
    '../assistants/modelManager': {
      detectModelSize: () => '1.2B', resolveCtxSize: () => 4096, isModelDownloaded: () => true,
    },
    '../assistants/binaryManager': {},
    'node:timers/promises': { setTimeout: async () => {} },
  }, {
    setTimeout: (fn, ms) => {
      if (ms !== 45000) return setTimeout(fn, ms)
      const timer = { fire: fn }
      queueTimers.add(timer)
      return timer
    },
    clearTimeout: timer => queueTimers.has(timer) ? queueTimers.delete(timer) : clearTimeout(timer),
    fetch: (_url, options) => new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error('aborted'))
      options.signal.addEventListener('abort', onAbort, { once: true })
      requests.push({
        prompt: JSON.parse(options.body).messages[0].content,
        finish: () => {
          options.signal.removeEventListener('abort', onAbort)
          resolve({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) })
        },
      })
    }),
  }).localModels
  manager.state = 'ready'
  manager.prepareBinary = async () => ({ flavor: 'cpu' })
  manager.spawnServer = async () => true
  manager.startWatchdog = () => {}
  return { manager, requests, queueTimers }
}

test('cancelling one chat removes queued work and frees an active slot for another chat', async () => {
  const { manager, requests, queueTimers } = managerHarness()
  const a = new AbortController()
  const queued = new AbortController()
  const pa = manager.complete('chat A running', { signal: a.signal }).catch(error => error.message)
  await tick()
  const pb = manager.complete('chat B running')
  await tick()
  const pq = manager.complete('chat A queued', { signal: queued.signal }).catch(error => error.message)
  const pc = manager.complete('chat C queued')
  await tick()
  assert.equal(requests.length, 2)
  queued.abort()
  assert.match(await pq, /cancel/i)
  assert.equal(manager.queue.length, 1)
  a.abort()
  assert.match(await pa, /aborted/)
  await tick()
  assert.equal(requests.length, 3)
  assert.equal(requests[2].prompt, 'chat C queued')
  requests[1].finish()
  requests[2].finish()
  assert.equal(await pb, 'ok')
  assert.equal(await pc, 'ok')
  assert.equal(queueTimers.size, 0)
})

test('recovered server resumes retained queued jobs without a new completion request', async () => {
  const { manager, requests } = managerHarness()
  const start = deferred()
  manager.spawnServer = () => start.promise
  const pa = manager.complete('a').catch(() => '')
  const pb = manager.complete('b').catch(() => '')
  const pc = manager.complete('survives crash')
  await tick()
  const recovery = manager.handleCrash(manager.lifecycle.signal)
  await tick()
  assert.equal(manager.inFlight, 0)
  assert.equal(manager.queue.length, 1)
  start.resolve(true)
  await recovery
  await tick()
  assert.equal(requests[2].prompt, 'survives crash')
  requests[2].finish()
  assert.equal(await pc, 'ok')
  await Promise.all([pa, pb])
})

test('queued jobs expire while all slots are occupied', async () => {
  const { manager, requests, queueTimers } = managerHarness()
  const pa = manager.complete('a')
  const pb = manager.complete('b')
  const pq = manager.complete('expires').catch(error => error.message)
  await tick()
  assert.equal(queueTimers.size, 1)
  for (const timer of [...queueTimers]) timer.fire()
  assert.match(await pq, /queue timed out/)
  assert.equal(manager.queue.length, 0)
  requests.forEach(request => request.finish())
  await Promise.all([pa, pb])
})

test('cancellation during cold start settles before startup completes and never queues the job', async () => {
  const { manager } = managerHarness()
  const start = deferred()
  manager.ensureReady = () => start.promise
  const controller = new AbortController()
  const completion = manager.complete('cancel cold start', { signal: controller.signal }).catch(() => 'cancelled')
  controller.abort()
  assert.equal(await completion, 'cancelled')
  assert.equal(manager.queue.length, 0)
  start.resolve(true)
})

test('permanent startup failure rejects retained queued jobs and cleans deadline timers', async () => {
  const { manager, queueTimers } = managerHarness()
  manager.state = 'error'
  const completion = manager.enqueue('pending', {}).catch(error => error.message)
  manager.spawnServer = async () => false
  assert.equal(await manager.doEnsure(new AbortController().signal), false)
  assert.match(await completion, /failed to start/)
  assert.equal(queueTimers.size, 0)
})

test('488-tool semantic catalogue reuses embeddings and invalidates cache on embedding mode change', async () => {
  let calls = 0
  let mode = 'tfidf'
  const watcher = load('src/core/agent/watcher.ts', {
    '../memory/globalMemorySettings': { getMemorySettings: () => ({ enabled: false }) },
    '../sidecar/sidecarClient': {}, '../skills/skillManager': {}, '../logger': { log: () => {} },
    '../context/embeddings': {
      getEmbedder: async () => ({ mode, dim: 1, embed: async () => { calls++; return new Float32Array([1]) } }),
      cosineSimilarity: () => 1,
    },
  })
  const catalogue = Array.from({ length: 488 }, (_, i) => ({ id: String(i), name: `tool${i}`, desc: `description${i}` }))
  await watcher.scoreCapabilitiesSemantic(catalogue, 'query')
  assert.equal(calls, 489)
  await watcher.scoreCapabilitiesSemantic(catalogue, 'new query')
  assert.equal(calls, 490)
  mode = 'neural'
  await watcher.scoreCapabilitiesSemantic(catalogue, 'query')
  assert.equal(calls, 979)
})

function bridgeHarness(overrides = {}) {
  const counts = { wake: 0, saved: 0 }
  const settings = {
    enabled: true, watcherEnabled: true, navigatorEnabled: true, archivistEnabled: true,
    janitorEnabled: true, modelSize: 'auto', ctxSize: 'auto', device: 'auto',
  }
  const bridge = load('src/main/assistants/bridge.ts', {
    '../../core/agent/watcher': {
      Watcher: class { setSourceWeightProvider() {} updateSettings() {} async onTrigger(_trigger, _queries, memoryOnly) { return memoryOnly ? overrides.memoryHints ?? [] : [] } },
      prefilterCapabilities: catalogue => catalogue,
      hashContext: text => text,
    },
    '../../shared/assistants': { DEFAULT_ASSISTANTS_SETTINGS: settings },
    '../../core/logger': { log: () => {} },
    './llmClient': overrides.llm ?? {},
    './llmServer': { getServerState: () => overrides.ready === false ? 'idle' : 'ready' },
    '../../core/memory/MemoryStore': { saveMemoryItem: async () => { counts.saved++ }, decayAutoFacts: () => 0 },
    '../../core/sidecar/sidecarClient': { resolveSemanticModelPaths: () => null },
    '../localModels/LocalModelManager': {
      localModels: {
        setModelSize() {}, setCtxSetting() {}, setDevice() {}, shutdown() {},
        ensureReady: async () => { counts.wake++; return true }, getState: () => 'idle',
      },
    },
    './modelManager': { detectModelSize: () => '1.2B' },
  })
  bridge.initAssistants({ load: () => settings, persist: () => {}, dbPath: () => '' })
  function attach(chatId) {
    const worker = new EventEmitter()
    worker.messages = []
    worker.postMessage = message => worker.messages.push(message)
    bridge.attachAssistants(chatId, worker)
    return worker
  }
  return { bridge, attach, counts }
}

test('bookkeeping and disabled roles do not start a model or wait for readiness', async () => {
  const { bridge, attach, counts } = bridgeHarness({ ready: false })
  attach('a')
  for (const kind of ['capabilities', 'economist', 'briefing', 'janitor_skip']) {
    await bridge.onAssistantEvent('a', { kind, capabilities: [] })
  }
  bridge.updateAssistantsSettings({ navigatorEnabled: false })
  await bridge.onAssistantEvent('a', { kind: 'navigator' })
  assert.equal(counts.wake, 0)
})

test('replacing one worker aborts its jobs, rejects late hints, and preserves another chat', async () => {
  const tasks = []
  const { bridge, attach } = bridgeHarness({ llm: {
    judgeDrift: (...args) => { const task = deferred(); tasks.push({ ...task, signal: args[4] }); return task.promise },
  } })
  const oldA = attach('a')
  const workerB = attach('b')
  const pa = bridge.onAssistantEvent('a', { kind: 'navigator' })
  const pb = bridge.onAssistantEvent('b', { kind: 'navigator' })
  await tick()
  const newA = attach('a')
  oldA.emit('exit')
  assert.equal(tasks[0].signal.aborted, true)
  assert.equal(tasks[1].signal.aborted, false)
  tasks.forEach(task => task.resolve({ drift: true, reason: 'finish goal' }))
  await Promise.all([pa, pb])
  assert.equal(oldA.messages.filter(message => message.type === 'hint').length, 0)
  assert.equal(newA.messages.filter(message => message.type === 'hint').length, 0)
  assert.equal(workerB.messages.filter(message => message.type === 'hint').length, 1)
  bridge.detachAssistants('a')
  bridge.detachAssistants('b')
})

test('Archivist persists final-run facts after its worker exits', async () => {
  const result = deferred()
  const { bridge, attach, counts } = bridgeHarness({ llm: { distillSession: () => result.promise } })
  const worker = attach('a')
  const task = bridge.onAssistantEvent('a', { kind: 'archivist', transcript: 'durable project decisions '.repeat(30) })
  await tick()
  worker.emit('exit')
  result.resolve([{ content: 'Use the project convention for future code', kind: 'project' }])
  await task
  assert.equal(counts.saved, 1)
})

test('disable then re-enable cannot revive a stale advisory response', async () => {
  const result = deferred()
  const { bridge, attach } = bridgeHarness({ llm: { judgeDrift: () => result.promise } })
  const worker = attach('a')
  const pending = bridge.onAssistantEvent('a', { kind: 'navigator' })
  await tick()
  bridge.updateAssistantsSettings({ enabled: false })
  bridge.updateAssistantsSettings({ enabled: true })
  result.resolve({ drift: true, reason: 'old run judgement' })
  await pending
  assert.equal(worker.messages.filter(message => message.type === 'hint').length, 0)
  bridge.detachAssistants('a')
})

test('disabling a single role suppresses its already-running late response', async () => {
  const result = deferred()
  const { bridge, attach } = bridgeHarness({ llm: { judgeDrift: () => result.promise } })
  const worker = attach('a')
  const pending = bridge.onAssistantEvent('a', { kind: 'navigator' })
  await tick()
  bridge.updateAssistantsSettings({ navigatorEnabled: false })
  result.resolve({ drift: true, reason: 'late judgement' })
  await pending
  assert.equal(worker.messages.filter(message => message.type === 'hint').length, 0)
  bridge.detachAssistants('a')
})

test('role and source disable then re-enable cannot revive stale advisory work', async () => {
  for (const setting of ['navigatorEnabled', 'watcherEnabled', 'janitorEnabled', 'memory', 'skills']) {
    const tasks = []
    const { bridge, attach } = bridgeHarness({ llm: { judgeDrift: (...args) => {
      const task = deferred()
      tasks.push({ ...task, signal: args[4] })
      return task.promise
    } } })
    const worker = attach('a')
    const pending = bridge.onAssistantEvent('a', { kind: 'navigator' })
    await tick()
    const patch = enabled => ['memory', 'skills'].includes(setting)
      ? { sources: { memory: true, skills: true, [setting]: enabled } }
      : { [setting]: enabled }
    bridge.updateAssistantsSettings(patch(false))
    bridge.updateAssistantsSettings(patch(true))
    assert.equal(tasks[0].signal.aborted, true, setting)
    tasks[0].resolve({ drift: true, reason: `stale ${setting}` })
    await pending
    assert.equal(worker.messages.filter(message => message.type === 'hint').length, 0, setting)
    const fresh = bridge.onAssistantEvent('a', { kind: 'navigator' })
    await tick()
    assert.equal(tasks[1].signal.aborted, false, setting)
    tasks[1].resolve({ drift: true, reason: `fresh ${setting}` })
    await fresh
    assert.equal(worker.messages.filter(message => message.type === 'hint').length, 1, setting)
    bridge.detachAssistants('a')
  }
})

test('feedback judges actual hint instructions instead of opaque timestamp IDs', async () => {
  let judgement
  const { bridge, attach } = bridgeHarness({ llm: {
    judgeCapability: async () => ({ helpful: true, id: 'read_file', confidence: 1, action: 'Read package.json to identify the available build script' }),
    judgeRelevance: async (...args) => { judgement = args; return { relevant: true } },
  } })
  attach('a')
  await bridge.onAssistantEvent('a', { kind: 'capabilities', capabilities: [{ id: 'read_file', name: 'Read file', desc: 'Read project files' }] })
  await bridge.onAgentEvent('a', { kind: 'task_start', text: 'Build the application' })
  await bridge.onRunDone('a', 'Built application after reading the package.json build script', { tools: ['read_file'], skills: [] })
  assert.match(judgement[0], /Built application/)
  assert.match(judgement[1], /Read package.json/)
  assert.doesNotMatch(judgement[1], /cap-read_file-\d+/)
  bridge.detachAssistants('a')
})

test('semantic scoring stops after cancellation instead of computing the rest of the catalogue', async () => {
  const controller = new AbortController()
  let calls = 0
  const watcher = load('src/core/agent/watcher.ts', {
    '../memory/globalMemorySettings': { getMemorySettings: () => ({ enabled: false }) },
    '../sidecar/sidecarClient': {}, '../skills/skillManager': {}, '../logger': { log: () => {} },
    '../context/embeddings': {
      getEmbedder: async () => ({ mode: 'neural', dim: 1, embed: async () => {
        calls++
        if (calls === 2) controller.abort()
        return new Float32Array([1])
      } }),
      cosineSimilarity: () => 1,
    },
  })
  const catalogue = Array.from({ length: 488 }, (_, i) => ({ id: String(i), name: `tool${i}`, desc: 'description' }))
  const result = await watcher.scoreCapabilitiesSemantic(catalogue, 'query', controller.signal)
  assert.equal(result.length, 0)
  assert.equal(calls, 2)
})

test('worker cleanup preserves duplicate-hint suppression across successful turns', async () => {
  const { bridge, attach } = bridgeHarness({ llm: {
    judgeDrift: async () => ({ drift: true, reason: 'Check the pending goal before continuing' }),
  } })
  const first = attach('a')
  await bridge.onAssistantEvent('a', { kind: 'navigator' })
  assert.equal(first.messages.filter(message => message.type === 'hint').length, 1)
  first.emit('exit')
  const next = attach('a')
  await bridge.onAssistantEvent('a', { kind: 'navigator' })
  assert.equal(next.messages.filter(message => message.type === 'hint').length, 0)
  bridge.detachAssistants('a')
})

test('janitor burst keeps the queue bounded and releases every timer on shutdown', async () => {
  const { manager, queueTimers } = managerHarness()
  const tasks = Array.from({ length: 24 }, (_, i) => manager.complete(`refine ${i}`, { priority: 'janitor' }).catch(error => error.message))
  await tick()
  assert.equal(manager.inFlight, 2)
  assert.equal(manager.queue.length, 8)
  assert.equal(queueTimers.size, 8)
  manager.shutdown()
  const results = await Promise.all(tasks)
  assert.equal(results.filter(result => /overflow/.test(result)).length, 14)
  assert.equal(queueTimers.size, 0)
  assert.equal(manager.queue.length, 0)
  assert.equal(manager.inFlight, 0)
})

test('ready capability router also retrieves local memory without an extra generation or duplicate hint', async () => {
  let generations = 0
  const { bridge, attach } = bridgeHarness({
    memoryHints: [{ id: 'mem-a', source: 'memory', content: 'Use the existing project setting', score: 0.9 }],
    llm: { judgeCapability: async () => { generations++; return { helpful: false, confidence: 0 } } },
  })
  const worker = attach('memory-ready')
  await bridge.onAgentEvent('memory-ready', { kind: 'task_start', text: 'project configuration' })
  await bridge.onAgentEvent('memory-ready', { kind: 'task_start', text: 'project configuration' })
  assert.equal(generations, 2, 'exactly one existing capability judgement per trigger')
  assert.equal(worker.messages.filter(message => message.type === 'hint' && message.hint.source === 'memory').length, 1)
  bridge.detachAssistants('memory-ready')
})
