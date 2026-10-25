/* global require, __dirname, process */
/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const { getEncoding } = require('js-tiktoken')

// The Rust sidecar replaced js-tiktoken on the hot paths. Both must agree
// token-for-token, otherwise the context indicator and the compaction thresholds
// would shift depending on which counter answered.

const root = path.join(__dirname, '..')
const binaryName = process.platform === 'win32' ? 'syntee-sidecar.exe' : 'syntee-sidecar'
const candidates = [
  path.join(root, 'resources', 'sidecar', binaryName),
  path.join(root, 'Sidecar', 'target', 'release', binaryName),
  path.join(root, 'Sidecar', 'target', 'debug', binaryName),
]
const binary = candidates.find(candidate => fs.existsSync(candidate))

const SAMPLES = [
  '',
  'hello world',
  'Hello, world!',
  'ordinary text <|endoftext|>',
  'Привет, мир — это проверка cl100k для кириллицы.',
  'const x = await sidecarTokensCountBatch(texts)\n  return counts.map(c => c * 2)',
  '中文句子也需要能够被正确计数。',
  'mixed 文本 with `code` and 1234 numbers\n\nmultiple\nlines',
  'a'.repeat(5000),
  'function f() { return 1 }\nexport class C { constructor() {} method() { return f() } }\n',
]

test('Rust cl100k_base counts match js-tiktoken exactly', { skip: binary ? false : 'sidecar binary not built' }, () => {
  const encoder = getEncoding('cl100k_base')
  const expected = SAMPLES.map(text => {
    try {
      return encoder.encode(text, [], ['all']).length
    } catch {
      // The production path treats special-token spellings as ordinary text.
      return encoder.encode(text.replace(/<\|[^|]*\|>/g, ''), [], []).length
    }
  })

  const request = JSON.stringify({ id: 'parity', method: 'tokensCountBatch', params: { texts: SAMPLES } })
  const shutdown = JSON.stringify({ id: 'bye', method: 'shutdown', params: {} })
  const result = spawnSync(binary, [], {
    input: `${request}\n${shutdown}\n`,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
  assert.equal(result.status, 0, result.stderr)

  const lines = result.stdout.split('\n').filter(Boolean)
  const response = lines.map(line => JSON.parse(line)).find(row => row.id === 'parity')
  assert.ok(response, `no parity response in ${result.stdout.slice(0, 400)}`)
  assert.equal(response.ok, true, JSON.stringify(response.error))
  assert.deepEqual(response.result.tokens, expected)
})

test('truncation never exceeds the requested budget', { skip: binary ? false : 'sidecar binary not built' }, () => {
  const encoder = getEncoding('cl100k_base')
  const text = 'The quick brown fox jumps over the lazy dog, again and again, forever and ever.'
  const request = JSON.stringify({ id: 'trunc', method: 'tokensTruncate', params: { text, maxTokens: 7 } })
  const shutdown = JSON.stringify({ id: 'bye', method: 'shutdown', params: {} })
  const result = spawnSync(binary, [], {
    input: `${request}\n${shutdown}\n`,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
  const response = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(row => row.id === 'trunc')
  assert.ok(response && response.ok, `truncate failed: ${result.stdout.slice(0, 400)}`)
  assert.equal(response.result.truncated, true)
  assert.ok(response.result.tokens <= 7, `returned ${response.result.tokens} tokens for a budget of 7`)
  assert.ok(text.startsWith(response.result.text.trim()), 'truncated text must be a prefix of the input')
  assert.equal(encoder.encode(response.result.text, [], ['all']).length, response.result.tokens)
})
