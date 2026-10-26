const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { executeCode, EphemeralArtifactStore } = require('../src/core/codeMode/index.ts')
const call = async (name, args) => {
  if (name === 'first') return { success: true, output: String(args.n + 1) }
  if (name === 'second') return { success: true, output: `got:${args.v}` }
  if (name === 'fail') return { success: false, output: '', error: 'expected failure' }
  if (name === 'execute_code') throw new Error('should never call')
  return { success: true, output: JSON.stringify(args) }
}
test('basic TypeScript execution', async () => {
  const r = await executeCode({ code: 'const n: number = 2; return n * 3;', callTool: call })
  assert.equal(r.success, true); assert.match(r.output, /6/)
})
test('dependent and parallel tools; structured failure returned', async () => {
  const r = await executeCode({ code: "const a = await tools.first({n: 4}); const b = await tools.second({v: a.output}); const both = await Promise.all([tools.first({n:1}), tools.first({n:2})]); const bad = await tools.fail({}); return [b.output, both.length, bad.success];", callTool: call })
  assert.equal(r.success, true); assert.match(r.output, /got:5/)
})
test('recursive execute_code is denied', async () => {
  const r = await executeCode({ code: "return await tools.call('execute_code', {});", callTool: call })
  assert.equal(r.success, true); assert.match(r.output, /Recursive Code Mode/)
})
test('infinite loop respects interrupt timeout', async () => {
  const r = await executeCode({ code: 'while (true) {}', callTool: call, timeoutMs: 100 })
  assert.equal(r.success, false); assert.match(r.error, /timed out/i)
})
test('abort is honored', async () => {
  const controller = new AbortController(); setTimeout(() => controller.abort(), 30)
  const r = await executeCode({ code: "await tools.wait({}); return 'done';", callTool: async () => new Promise(resolve => setTimeout(() => resolve({success:true, output:'ok'}), 300)), signal: controller.signal, timeoutMs: 3000 })
  assert.equal(r.success, false); assert.match(r.error, /abort/i)
})
test('host globals unavailable', async () => {
  const r = await executeCode({ code: "return [typeof process, typeof require, typeof fetch, typeof Buffer];", callTool: call })
  assert.equal(r.success, true); assert.match(r.output, /undefined/)
})
test('artifacts are scoped by chat and require chatId', () => {
  const store = new EphemeralArtifactStore()
  const id = store.save('chat-a', { secret: 'x' })
  assert.deepEqual(store.load('chat-a', id), { secret: 'x' }); assert.equal(store.load('chat-b', id), undefined)
  assert.throws(() => store.save('', 1), /chatId/)
})
test('artifact API works inside guest', async () => {
  const r = await executeCode({ chatId: 'chat', artifacts: new EphemeralArtifactStore(), callTool: call, code: "const id = await artifacts.save({n: 7}); return await artifacts.load(id);" })
  assert.equal(r.success, true); assert.match(r.output, /7/)
})
test('long host call does not consume the script time budget', async () => {
  // Бюджет CPU гостя отдельно от абсолютного лимита wall-clock.
  const r = await executeCode({
    code: "const a = await tools.slow({}); return 'ok:' + a.success;",
    callTool: async () => new Promise(resolve => setTimeout(() => resolve({ success: true, output: 'slow done' }), 300)),
    timeoutMs: 100,
    wallTimeoutMs: 1000,
  })
  assert.equal(r.success, true); assert.match(r.output, /ok:true/)
})
test('a hung host call hits the absolute wall-clock limit and aborts its signal', async () => {
  let sawAbort = false
  const r = await executeCode({
    code: "await tools.never({}); return 'should not finish';",
    callTool: (_name, _args, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => { sawAbort = true; resolve({ success: false, output: '', error: 'aborted' }) }, { once: true })
    }),
    timeoutMs: 10_000,
    wallTimeoutMs: 80,
  })
  assert.equal(r.success, false)
  assert.match(r.error, /wall-clock limit/i)
  assert.equal(sawAbort, true)
})
test('failed nested tool output preserves the error text in its trace', async () => {
  const r = await executeCode({
    code: "await tools.fail({}); return 'done';",
    callTool: async () => ({ success: false, output: '', error: 'blocked by approval' }),
  })
  assert.equal(r.success, true)
  assert.equal(r.trace?.[0]?.status, 'failure')
  assert.equal(r.trace?.[0]?.result, 'blocked by approval')
})
test('denied nested call is returned to the guest instead of aborting the program', async () => {
  const r = await executeCode({
    code: "const denied = await tools.write_file({ path: 'x' }); const next = await tools.read_file({ path: 'y' }); return [denied.success, String(denied.error || '').includes('Rejected'), next.success];",
    callTool: async name => name === 'write_file'
      ? { success: false, output: 'Rejected by the user', error: 'Rejected by the user' }
      : { success: true, output: 'file body' },
  })
  assert.equal(r.success, true); assert.match(r.output, /false,true,true/)
})
test('Agent blocks get_fast_context inside execute_code at the bridge', () => {
  const source = readFileSync('src/core/agent/Agent.ts', 'utf8')
  assert.match(source, /toolName === 'get_fast_context'/)
  assert.match(source, /get_fast_context is not available inside execute_code/)
})
test('ToolChain shows execute_code calls in the collapsed card and arguments/results after opening', () => {
  const source = readFileSync('src/renderer/src/components/ui/ToolChain/ToolChain.tsx', 'utf8')
  assert.ok(source.includes('function CodeModeSummary'))
  assert.ok(source.includes('<CodeModeSummary trace={iter.result.codeMode.trace} />'))
  assert.ok(source.includes('codeTraceArgs(entry.args)'))
  assert.ok(source.includes('entry.result || \'(пустой вывод)\''))
  assert.ok(source.includes('Показать TypeScript-код'))
})
test('live agent:step preserves execute_code trace in ToolStep', () => {
  const source = readFileSync('src/renderer/src/hooks/useToolProgress.ts', 'utf8')
  assert.match(source, /codeMode\?: \{ code: string; trace\?: Array/)
  assert.match(source, /codeMode: step\.codeMode/)
})
test('Agent does not abort the script when a nested call is blocked', () => {
  const source = readFileSync('src/core/agent/Agent.ts', 'utf8')
  assert.ok(!source.includes('if (blocked) codeAbort.abort()'), 'blocked nested call must not kill the script')
  assert.ok(!source.includes("codeModeEnabled"), 'execute_code must not be gated by a global setting')
})
