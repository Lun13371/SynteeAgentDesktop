/* global require, __dirname, process */
/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

// Semantic-индексация и поиск переехали из main-процесса в Rust sidecar.
// Векторы обязаны совпадать с JS-эталоном: инвалидация индекса стоит часов
// переэмбеддинга, а расхождение втихую ломает recall_memory.
//
// Порог 0.9999 — не «примерно похоже», а «тот же вектор с точностью до
// float32-арифметики». Ниже — сначала ищем причину, а не меняем тег модели.

const root = path.join(__dirname, '..')
const binaryName = process.platform === 'win32' ? 'syntee-sidecar.exe' : 'syntee-sidecar'
const binaryCandidates = [
  path.join(root, 'resources', 'sidecar', binaryName),
  path.join(root, 'Sidecar', 'target', 'release', binaryName),
  path.join(root, 'Sidecar', 'target', 'debug', binaryName),
]
const binary = binaryCandidates.find(candidate => fs.existsSync(candidate))

const MODEL_ID = 'Xenova/multilingual-e5-small'
const cacheRoot = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'SynteeHelper',
  'transformers-cache',
)
const modelDir = path.join(cacheRoot, MODEL_ID)
const modelPath = path.join(modelDir, 'onnx', 'model_quantized.onnx')
const tokenizerPath = path.join(modelDir, 'tokenizer.json')
const modelReady = fs.existsSync(modelPath) && fs.existsSync(tokenizerPath)

const SAMPLES = [
  'hello world',
  'Привет, мир — это проверка эмбеддингов для кириллицы.',
  '中文句子也需要能够被正确编码。',
  'const x = await sidecarTokensCountBatch(texts)\n  return counts.map(c => c * 2)',
  'Как мы ускорили индексацию файлового индекса?',
  'function f() { return 1 }\nexport class C { constructor() {} method() { return f() } }',
  'mixed 文本 with `code` and 1234 numbers\n\nmultiple\nlines',
  'Error: ENOENT no such file or directory, open C:\\Projects\\app\\package.json',
  'a'.repeat(2000),
  'The quick brown fox jumps over the lazy dog, again and again, forever and ever.',
]

function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function runSidecar(requests) {
  const input = requests.map(request => JSON.stringify(request)).join('\n') + '\n'
  const result = spawnSync(binary, [], {
    input,
    encoding: 'utf8',
    timeout: 180_000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

const skip = binary && modelReady
  ? false
  : !binary
    ? 'sidecar binary not built'
    : 'E5 model not cached'

test('Rust E5 vectors match the JS pipeline', { skip, timeout: 300_000 }, async () => {
  // JS-эталон: тот же model_quantized.onnx, тот же tokenizer.json, тот же
  // mean-pooling + L2, что делает production-путь transformers.js.
  const { pipeline, env } = require('@huggingface/transformers')
  env.cacheDir = cacheRoot
  const extractor = await pipeline('feature-extraction', MODEL_ID, {
    dtype: 'q8',
    cache_dir: cacheRoot,
  })
  const expected = []
  for (const sample of SAMPLES) {
    const output = await extractor([`passage: ${sample}`], { pooling: 'mean', normalize: true })
    expected.push(Array.from(output.data))
  }

  const responses = runSidecar([
    {
      id: 'embed',
      method: 'semanticEmbed',
      params: {
        modelPath,
        tokenizerPath,
        texts: SAMPLES,
        prefix: 'passage',
      },
    },
    { id: 'bye', method: 'shutdown', params: {} },
  ])

  const response = responses.find(row => row.id === 'embed')
  assert.ok(response, 'no semanticEmbed response')
  assert.equal(response.ok, true, JSON.stringify(response.error))
  assert.equal(response.result.dim, 384)
  assert.equal(response.result.vectors.length, SAMPLES.length)

  const scores = response.result.vectors.map((vector, index) => cosine(vector, expected[index]))
  const worst = Math.min(...scores)
  const details = scores
    .map((score, index) => `${score.toFixed(6)}  ${SAMPLES[index].slice(0, 40).replace(/\n/g, ' ')}`)
    .join('\n')
  assert.ok(
    worst >= 0.9999,
    `worst cosine ${worst.toFixed(6)} below 0.9999\n${details}`,
  )

  // Векторы обязаны быть L2-нормализованы — иначе cosine-поиск поедет.
  for (const vector of response.result.vectors) {
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
    assert.ok(Math.abs(norm - 1) < 1e-4, `vector norm ${norm} is not 1`)
  }
})

test('query prefix differs from passage prefix', { skip, timeout: 300_000 }, () => {
  const text = 'как устроена индексация памяти'
  const responses = runSidecar([
    {
      id: 'q',
      method: 'semanticEmbed',
      params: { modelPath, tokenizerPath, texts: [text], prefix: 'query' },
    },
    {
      id: 'p',
      method: 'semanticEmbed',
      params: { modelPath, tokenizerPath, texts: [text], prefix: 'passage' },
    },
    { id: 'bye', method: 'shutdown', params: {} },
  ])
  const query = responses.find(row => row.id === 'q')
  const passage = responses.find(row => row.id === 'p')
  assert.equal(query.ok, true, JSON.stringify(query.error))
  assert.equal(passage.ok, true, JSON.stringify(passage.error))
  const score = cosine(query.result.vectors[0], passage.result.vectors[0])
  // Один и тот же текст, но разные префиксы → E5 даёт разные векторы.
  assert.ok(score < 0.999, `query and passage prefixes must differ, got ${score}`)
  assert.ok(score > 0.5, `query and passage of the same text should stay related, got ${score}`)
})
