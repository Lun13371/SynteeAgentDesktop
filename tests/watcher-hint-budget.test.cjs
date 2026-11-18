/* global require, __dirname, TextEncoder */
/* eslint-disable @typescript-eslint/no-require-imports -- Exercise production hints with isolated memory search. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function load(file, dependencies) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { module, exports: module.exports, require: name => name in dependencies ? dependencies[name] : require(name), TextEncoder })
  return module.exports
}
const assistants = load('src/shared/assistants.ts', {})
const contextUsage = load('src/shared/contextUsage.ts', {})
const usage = load('src/core/tokens/usageTracker.ts', {
  './modelCatalog': {}, './gatewayModelsCache': {}, '../../shared/data/builtinModels': {},
  '../../shared/imageFormat': { IMAGE_TOKEN_COST: 1000 }, './ModelPricing': {},
  '../../shared/contextUsage': contextUsage,
})
const { consumeHintBudget } = load('src/core/context/hintBudget.ts', { '../tokens/usageTracker': usage, '../../shared/assistants': assistants })

function watcherHarness(initial = { enabled: true, global: true, project: true, chat: true }) {
  let flags = initial
  const calls = []
  let search = async options => [
    { sourceId: 'global', scope: 'global', content: 'global fact' },
    { sourceId: 'project-A', scope: 'project', projectId: 'A', content: 'private project A' },
    { sourceId: 'project-B', scope: 'project', projectId: 'B', content: 'private project B' },
  ].filter(row => row.scope === 'global' ? options.memoryGlobal : options.memoryProject && row.projectId === options.projectId).map(row => ({ ...row, source: 'memory', score: 0.9 }))
  const { Watcher } = load('src/core/agent/watcher.ts', {
    '../sidecar/sidecarClient': { resolveSemanticModelPaths: () => ({}), sidecarSemanticSearch: options => { calls.push(options); return search(options) } },
    '../skills/skillManager': { getSkillManager: () => ({ getActiveSkillsForChat: () => [] }) },
    '../context/embeddings': {}, '../logger': { log() {} },
    '../memory/globalMemorySettings': { getMemorySettings: () => flags },
  })
  return { calls, setFlags: value => { flags = value }, setSearch: value => { search = value }, make: projectId => new Watcher(assistants.DEFAULT_ASSISTANTS_SETTINGS, 'test-db', { projectId }) }
}

test('Watcher scopes E5 memory to the current project and forwards disabled scope flags', async () => {
  const harness = watcherHarness({ enabled: true, global: false, project: true, chat: false })
  const hintsA = await harness.make('A').onTrigger({ kind: 'user_message', text: 'project configuration' }, [], true)
  const hintsB = await harness.make('B').onTrigger({ kind: 'user_message', text: 'project configuration' }, [], true)
  assert.equal(hintsA.length, 1)
  assert.equal(hintsA[0].content, 'private project A')
  assert.equal(hintsB[0].content, 'private project B')
  assert.equal(harness.calls[0].projectId, 'A')
  assert.equal(harness.calls[0].crossProject, false)
  assert.equal(harness.calls[0].memoryGlobal, false)
  assert.equal(harness.calls[0].memoryChat, false)
})

test('disabled memory never reaches the sidecar, and disabling during a search discards its result', async () => {
  const harness = watcherHarness({ enabled: false, global: true, project: true, chat: true })
  assert.equal((await harness.make('A').onTrigger({ kind: 'task_start', text: 'configuration' })).length, 0)
  assert.equal(harness.calls.length, 0)
  harness.setFlags({ enabled: true, global: true, project: true, chat: true })
  let finish
  harness.setSearch(() => new Promise(resolve => { finish = resolve }))
  const pending = harness.make('A').onTrigger({ kind: 'task_start', text: 'configuration' })
  harness.setFlags({ enabled: false, global: true, project: true, chat: true })
  finish([{ source: 'memory', sourceId: 'private', score: 1, content: 'do not expose' }])
  assert.equal((await pending).length, 0)
})

test('project switches discard in-flight Watcher hits', async () => {
  const harness = watcherHarness()
  let finish
  harness.setSearch(() => new Promise(resolve => { finish = resolve }))
  const watcher = harness.make('A')
  const pending = watcher.onTrigger({ kind: 'task_start', text: 'configuration' }, [], true)
  watcher.updateProject({ projectId: 'B' })
  finish([{ source: 'memory', sourceId: 'A', score: 1, content: 'old project fact' }])
  assert.equal((await pending).length, 0)
})

test('hint token budget includes Russian marker, metadata and message overhead; deferred hints survive', () => {
  const hints = Array.from({ length: 3 }, (_, i) => ({ id: String(i), source: 'memory', title: 'Память проекта', content: 'Сохрани конфигурацию проекта и важные факты. '.repeat(7), score: 1 }))
  const first = consumeHintBudget(hints, 160)
  assert.equal(first.selected.length, 1)
  assert.equal(first.remaining.length, 2)
  assert.ok(first.selected.reduce((sum, item) => sum + usage.estimateTokens(item.message) + 4, 0) <= 160)
  const second = consumeHintBudget(first.remaining, 160)
  assert.equal(second.selected[0].hint.id, '1')
  assert.equal(second.remaining[0].id, '2')
})

test('huge advisory and a disabled budget cannot exceed token budget or grow the pending queue', () => {
  const queue = Array.from({ length: 30 }, (_, i) => ({ id: String(i), source: 'navigator', content: '🚀 日本語 контекст '.repeat(2000), score: 1 }))
  const bounded = consumeHintBudget(queue, 100)
  assert.equal(bounded.selected.length, 1)
  assert.ok(usage.estimateTokens(bounded.selected[0].message) + 4 <= 100)
  assert.ok(bounded.remaining.length <= 3)
  const disabled = consumeHintBudget(queue, 0)
  assert.equal(disabled.selected.length, 0)
  assert.equal(disabled.remaining.length, 3)
})
