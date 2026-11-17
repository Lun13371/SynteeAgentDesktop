/* global require, __dirname, process, module, AbortController */
/* eslint-disable @typescript-eslint/no-require-imports -- Use the project's real SDK and an isolated stdio server. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { EventEmitter } = require('node:events')
const Module = require('node:module')
const ts = require('typescript')
const { attachMcpWorkerBroker, requestMcpTool } = require('../src/core/mcp/mcpWorkerBroker.ts')
const { executeCode } = require('../src/core/codeMode/index.ts')
const timeoutSettings = require('../src/shared/mcpTimeout.ts')

const filename = join(__dirname, '../src/core/mcp/McpClient.ts')
const clientModule = new Module(filename, module)
const load = Module.createRequire(filename)
clientModule.require = name => {
  if (name === '../logger') return { log() {} }
  if (name === '../../shared/mcpTimeout') return timeoutSettings
  return load(name)
}
clientModule._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, filename)
const { McpClient } = clientModule.exports

const fixture = `
  const pending = new Map()
  let cancellations = 0
  const input = require('node:readline').createInterface({ input: process.stdin })
  input.on('line', line => {
    const { id, method, params } = JSON.parse(line)
    const reply = result => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }))
    const text = value => ({ content: [{ type: 'text', text: value }] })
    if (method === 'initialize') return reply({ protocolVersion: params.protocolVersion, serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } })
    if (method === 'tools/list') return reply({ tools: ['slow', 'failure', 'stats'].map(name => ({ name, inputSchema: { type: 'object' } })) })
    if (method === 'notifications/cancelled' && pending.has(params.requestId)) {
      clearTimeout(pending.get(params.requestId))
      pending.delete(params.requestId)
      cancellations++
    }
    if (method !== 'tools/call') return
    if (params.name === 'stats') return reply(text(String(cancellations)))
    if (params.name === 'failure') return reply({ ...text('fixture failure'), isError: true })
    const timer = setTimeout(() => { pending.delete(id); reply(text('analysis ready')) }, params.arguments?.ms ?? 1200)
    pending.set(id, timer)
  })
`

test('MCP applies configured SDK timeouts and propagates both timeout and user cancellation', async t => {
  const client = new McpClient({
    id: 'global:fixture', name: 'fixture', transport: 'stdio', command: process.execPath,
    args: ['-e', fixture], enabled: true, scope: { type: 'global' }, source: 'global',
  })
  t.after(() => client.disconnect())
  await client.connect()
  assert.equal(client.status, 'connected', client.error)
  assert.match((await client.callTool('slow', {}, 1)).error, /таймаут \(1 с\)/)
  assert.equal((await client.callTool('slow', {}, 2)).output, 'analysis ready')
  const abort = new AbortController()
  const pending = client.callTool('slow', { ms: 10_000 }, 30, abort.signal)
  await delay(30)
  abort.abort()
  assert.match((await pending).error, /отменён/)
  assert.equal((await client.callTool('stats', {})).output, '2')
  assert.deepEqual(await client.callTool('failure', {}), { success: false, output: '', error: 'fixture failure' })

  const code = await executeCode({
    code: "const analysis = await tools.call('mcp__fixture__slow', { ms: 700 }); return analysis.output.toUpperCase();",
    callTool: (name, args, signal) => client.callTool(name.replace('mcp__fixture__', ''), args, 2, signal),
    wallTimeoutMs: 400,
    mcpWaitBudgetMs: 2_000,
  })
  assert.equal(code.output, 'ANALYSIS READY')
})

test('worker broker cancels by reply ID and aborts outstanding calls on exit', async () => {
  const worker = new EventEmitter()
  const replies = new Map()
  worker.postMessage = reply => replies.get(reply.replyId)?.(reply)
  let backendSignal
  attachMcpWorkerBroker(worker, async (name, _args, signal) => {
    if (name === 'echo') return { success: true, output: 'ok' }
    backendSignal = signal
    return new Promise(resolve => signal.addEventListener('abort', () => resolve({ success: false, output: '' }), { once: true }))
  })
  const send = message => worker.emit('message', message)
  const abort = new AbortController()
  assert.equal((await requestMcpTool('echo', {}, replies, send, abort.signal)).output, 'ok')
  const pending = requestMcpTool('slow', {}, replies, send, abort.signal)
  abort.abort()
  assert.match((await pending).error, /отменён/)
  assert.equal(backendSignal.aborted, true)
  assert.equal(replies.size, 0)

  const fresh = new AbortController()
  const terminating = requestMcpTool('slow', {}, replies, send, fresh.signal)
  worker.emit('exit', 1)
  assert.equal(backendSignal.aborted, true)
  fresh.abort()
  await terminating
})
