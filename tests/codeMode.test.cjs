const { test } = require('node:test')
const assert = require('node:assert/strict')
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
