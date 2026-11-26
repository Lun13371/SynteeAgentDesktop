/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports -- Exercise constitution and state migration without the app runtime. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

// vm-контекст создаёт массивы чужого realm'а — deepStrictEqual по ним сравнивает
// прототипы. Сравниваем через JSON.
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message)

function load(file, dependencies = {}) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { module, exports: module.exports, require: name => (name in dependencies ? dependencies[name] : require(name)) })
  return module.exports
}

const assistants = load('src/shared/assistants.ts')
const { Constitution } = load('src/core/context/constitution.ts', { '../../shared/assistants': assistants })
const state = load('src/core/context/assistantState.ts')

test('constitution keeps only explicit rules: /rule and "запомни правило:"', () => {
  const c = new Constitution()
  // Обычная просьба с императивом больше не закрепляется автоматически.
  same(c.addExplicit('не трогай миграции, просто посмотри схему'), [])
  same(c.addExplicit('всегда используй pnpm в этом проекте'), [])
  assert.equal(c.size, 0)

  same(c.addExplicit('/rule не трогай миграции'), ['не трогай миграции'])
  same(c.addExplicit('запомни правило: не коммить без тестов'), ['не коммить без тестов'])
  same(c.addExplicit('Remember rule: keep tests green'), ['keep tests green'])
  // Дубли и повторные упоминания не плодятся.
  same(c.addExplicit('/rule не трогай миграции'), [])
  assert.equal(c.size, 3)

  const block = c.serialize()
  assert.ok(block.startsWith(assistants.CONSTITUTION_MARKER))
  assert.equal(block.split(assistants.CONSTITUTION_MARKER).length - 1, 1, 'single marker → no double injection')
  assert.match(block, /не трогай миграции/)
})

test('constitution never mixes explicit and legacy auto text from the same message', () => {
  const c = new Constitution()
  const added = c.addExplicit('/rule не используй force-push\nа ещё, пожалуйста, никогда не удаляй ветки сам')
  same(added, ['не используй force-push'])
  assert.equal(c.size, 1)
})

test('assistant state v1 (auto-extracted constitution) is migrated: rules cleared, recall archive kept', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'syntee-state-migration-'))
  try {
    const dir = path.join(temp, 'assistants-state')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'legacy.json')
    const archive = [{ id: 'jan-1-1', summary: 'collapsed', originalMessages: [{ role: 'tool', content: 'raw', tool_call_id: 'c1' }], ts: 1 }]
    fs.writeFileSync(file, JSON.stringify({ constitution: ['всегда используй pnpm', 'не трогай миграции'], janitorArchive: archive }))

    const loaded = state.loadAssistantState(temp, 'legacy')
    assert.equal(loaded.migrated, true)
    assert.equal(loaded.version, state.ASSISTANT_STATE_VERSION)
    same(loaded.constitution, [], 'auto-extracted rules are not applied')
    assert.equal(loaded.janitorArchive.length, 1, 'recall archive survives the migration')

    state.saveAssistantState(temp, 'legacy', loaded)
    const reloaded = state.loadAssistantState(temp, 'legacy')
    assert.equal(reloaded.migrated, false, 'migration is written once')
    same(reloaded.constitution, [])
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('assistant state round-trips explicit rules with the current version', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'syntee-state-roundtrip-'))
  try {
    state.saveAssistantState(temp, 'explicit', { constitution: ['не трогай миграции'], janitorArchive: [] })
    const loaded = state.loadAssistantState(temp, 'explicit')
    assert.equal(loaded.migrated, false)
    same(loaded.constitution, ['не трогай миграции'])
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
