import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
const require = createRequire(import.meta.url)
const cache = new Map()
function load(path) {
  path = resolve(path)
  if (cache.has(path)) return cache.get(path).exports
  const source = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  cache.set(path, module)
  new Function('require', 'module', 'exports', source)(id => id.startsWith('.') ? load(resolve(dirname(path), `${id}.ts`)) : require(id), module, module.exports)
  return module.exports
}
const settings = load('src/shared/toolSettings.ts')
const { getToolSchemas } = load('src/core/tools/schemas/index.ts')
const names = options => getToolSchemas(options).map(s => s.function.name)

test('Master off preserves standard schemas and default settings enable optional tools', () => {
  assert.deepEqual(names({ customToolsEnabled: false, disabledTools: ['search_web', 'spawn_agent'] }), names({}))
  assert.deepEqual(names({ customToolsEnabled: true, disabledTools: [] }), names({}))
  assert.equal(settings.DEFAULT_TOOL_SETTINGS.customToolsEnabled, false)
  assert.deepEqual(settings.DEFAULT_TOOL_SETTINGS.disabledTools, [])
})
test('Custom list subtracts only optional builtins and cannot disable protected core or dynamic tools', () => {
  const disabledTools = ['search_web', 'read_file', 'request_access', 'mcp__s__t', 'plugin__p__t']
  const options = { customToolsEnabled: true, disabledTools, mcpTools: [{ name: 'mcp__s__t' }], pluginTools: [{ name: 'plugin__p__t' }] }
  const actual = names(options)
  assert.ok(!actual.includes('search_web'))
  for (const n of ['read_file', 'request_access', 'mcp__s__t', 'plugin__p__t']) assert.ok(actual.includes(n), n)
  assert.deepEqual(settings.normalizeDisabledTools([...disabledTools, 'search_web', null, 1]), ['search_web'])
})
test('Preferences never expand Ask/browser/image gating', () => {
  const actual = names({ askMode: true, customToolsEnabled: true, disabledTools: [] })
  for (const n of ['edit_file', 'write_file', 'run_command', 'generate_image', 'browser_navigate']) assert.ok(!actual.includes(n), n)
  assert.ok(names({ browserMode: true, customToolsEnabled: true, disabledTools: ['browser_click'] }).includes('browser_navigate'))
  assert.ok(!names({ browserMode: true, customToolsEnabled: true, disabledTools: ['browser_click'] }).includes('browser_click'))
})
test('request_access stays available until browser and image capabilities are both enabled', () => {
  assert.ok(names({}).includes('request_access'))
  assert.ok(names({ imageMode: true }).includes('request_access'))
  assert.ok(names({ browserMode: true }).includes('request_access'))
  assert.ok(!names({ imageMode: true, browserMode: true }).includes('request_access'))
  assert.ok(names({ imageMode: true }).includes('generate_image'))
  assert.ok(names({ browserMode: true }).includes('browser_navigate'))
  const schema = load('src/core/tools/schemas/browser.ts').REQUEST_ACCESS_SCHEMA
  assert.deepEqual(schema.function.parameters.properties.capability.enum, ['browser_control', 'image_generation'])
})

test('Media schemas are registered, enabled by default and can be disabled individually', () => {
  for (const name of ['analyze_video', 'analyze_audio']) {
    assert.ok(names({}).includes(name), name)
    assert.ok(names({ askMode: true }).includes(name), name)
    assert.ok(!names({ customToolsEnabled: true, disabledTools: [name] }).includes(name), name)
    assert.ok(settings.OPTIONAL_TOOL_GROUPS.some(group => group.tools.some(tool => tool.name === name)), name)
  }
})
test('execute_code is a normal registered tool: available in every mode, individually disableable', () => {
  assert.ok(names({}).includes('execute_code'))
  // Исследовательские режимы тоже: внутри можно вызвать только read-тулы.
  assert.ok(names({ askMode: true }).includes('execute_code'))
  assert.ok(names({ planningMode: true }).includes('execute_code'))
  assert.ok(!names({ customToolsEnabled: true, disabledTools: ['execute_code'] }).includes('execute_code'))
  assert.ok(settings.OPTIONAL_TOOL_GROUPS.some(group => group.tools.some(tool => tool.name === 'execute_code')))
})
test('execute_code description lists the tools available inside the script but excludes get_fast_context', () => {
  const schema = options => getToolSchemas(options).find(s => s.function.name === 'execute_code')
  const normal = schema({}).function.description
  assert.match(normal, /Tools available inside this run: /)
  assert.ok(normal.includes('read_file') && normal.includes('run_command'))
  assert.ok(!normal.includes('get_fast_context'))
  // Ordinary get_fast_context remains available as a direct tool in normal runs.
  assert.ok(names({}).includes('get_fast_context'))
  // Read-only run must not advertise mutation tools — the bridge would reject them.
  const ask = schema({ askMode: true }).function.description
  assert.ok(!ask.includes('run_command'), ask)
  assert.ok(!ask.includes('write_file,'), ask)
  assert.ok(!ask.includes('get_fast_context'), ask)
  // Long families are grouped, not enumerated (otherwise ~550 extra tokens per request).
  assert.ok(schema({ browserMode: true }).function.description.includes('browser_* (45)'))
})
test('Agent preserves worker array identity for live browser access and forwards media cancellation', () => {
  const source = readFileSync('src/core/agent/Agent.ts', 'utf8')
  assert.ok(source.includes('this.toolDispatcher.mediaSignal = signal'))
  assert.ok(source.includes('activeSchemas.splice(0, activeSchemas.length, ...filteredSchemas)'))
})
test('Unknown future optional builtin is enabled unless explicitly disabled', () => {
  assert.equal(settings.isToolDisabled('future_tool', { customToolsEnabled: true, disabledTools: [] }), false)
  assert.equal(settings.isToolDisabled('future_tool', { customToolsEnabled: false, disabledTools: ['future_tool'] }), false)
})
