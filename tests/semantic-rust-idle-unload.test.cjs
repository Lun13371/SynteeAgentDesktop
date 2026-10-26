/* global require, __dirname, process */
/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

// В простое sidecar не должен держать E5-модель: замер 26.10.2026 — 399 МБ RSS
// с загруженной моделью против 34 МБ без неё (~365 МБ на ровном месте).
//
// Проверяем три вещи:
//   1. явная выгрузка (`semanticUnload`) освобождает модель;
//   2. после выгрузки модель МОЖНО загрузить снова (иначе выгрузка ломала бы
//      поиск до перезапуска приложения — ort разрешает только одно окружение
//      на процесс, поэтому окружение живёт глобально);
//   3. сторож по простою выгружает модель сам, без команды из TS.

const root = path.join(__dirname, '..')
const binaryName = process.platform === 'win32' ? 'syntee-sidecar.exe' : 'syntee-sidecar'
const binary = [
  path.join(root, 'resources', 'sidecar', binaryName),
  path.join(root, 'Sidecar', 'target', 'release', binaryName),
].find(candidate => fs.existsSync(candidate))

const cacheRoot = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'SynteeHelper',
  'transformers-cache',
)
const modelDir = path.join(cacheRoot, 'Xenova', 'multilingual-e5-small')
const modelPath = path.join(modelDir, 'onnx', 'model_quantized.onnx')
const tokenizerPath = path.join(modelDir, 'tokenizer.json')

const skip = binary && fs.existsSync(modelPath) && fs.existsSync(tokenizerPath)
  ? false
  : !binary
    ? 'sidecar binary not built'
    : 'E5 model not cached'

/** Поднимает sidecar и возвращает минимальный RPC-клиент. */
function startSidecar(env = {}) {
  const child = spawn(binary, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...env },
  })
  let buffer = ''
  const waiters = new Map()
  child.stdout.on('data', chunk => {
    buffer += chunk.toString()
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      const row = JSON.parse(line)
      const resolve = waiters.get(row.id)
      if (resolve) {
        waiters.delete(row.id)
        resolve(row)
      }
    }
  })
  let nextId = 0
  return {
    child,
    call(method, params) {
      const id = String(++nextId)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 180_000)
        waiters.set(id, row => {
          clearTimeout(timer)
          resolve(row)
        })
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      })
    },
    async close() {
      try { await this.call('shutdown', {}) } catch { /* ignore */ }
      try { child.stdin.end() } catch { /* ignore */ }
      await new Promise(resolve => setTimeout(resolve, 300))
      try { if (!child.killed) child.kill() } catch { /* ignore */ }
    },
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function embed(client) {
  return client.call('semanticEmbed', {
    modelPath,
    tokenizerPath,
    texts: ['проверка выгрузки модели'],
    prefix: 'passage',
  })
}

test('explicit unload frees the model and the next call reloads it', { skip, timeout: 300_000 }, async () => {
  const client = startSidecar()
  try {
    await sleep(800)
    const first = await embed(client)
    assert.equal(first.ok, true, JSON.stringify(first.error))

    const unloaded = await client.call('semanticUnload', {})
    assert.equal(unloaded.ok, true, JSON.stringify(unloaded.error))
    assert.equal(unloaded.result.status, 'unloaded', 'the model was loaded, so unload must report it')

    // Повторная выгрузка на пустом кэше — не ошибка, просто «нечего».
    const again = await client.call('semanticUnload', {})
    assert.equal(again.result.status, 'idle')

    // Главное: выгрузка не ломает модель навсегда.
    const reloaded = await embed(client)
    assert.equal(reloaded.ok, true, JSON.stringify(reloaded.error))
    assert.equal(reloaded.result.vectors.length, 1)
    assert.equal(reloaded.result.vectors[0].length, 384)
  } finally {
    await client.close()
  }
})

test('the idle watcher unloads the model without any command', { skip, timeout: 300_000 }, async () => {
  // Боевое окно — 5 минут; для теста сжимаем до 2 с.
  const client = startSidecar({ SYNTEE_SEMANTIC_IDLE_MS: '2000' })
  try {
    await sleep(800)
    const first = await embed(client)
    assert.equal(first.ok, true, JSON.stringify(first.error))

    // Ждём окно простоя плюс запас на тик сторожа.
    await sleep(6_000)

    // Модель выгружена — значит повторная выгрузка вернёт "idle".
    const forced = await client.call('semanticUnload', {})
    assert.equal(forced.ok, true, JSON.stringify(forced.error))
    assert.equal(
      forced.result.status,
      'idle',
      'idle watcher did not unload the model within the window',
    )

    // И, как в первом тесте, модель обязана загрузиться снова.
    const reloaded = await embed(client)
    assert.equal(reloaded.ok, true, JSON.stringify(reloaded.error))
  } finally {
    await client.close()
  }
})

test('unload keeps the process alive and the protocol responsive', { skip, timeout: 300_000 }, async () => {
  const client = startSidecar()
  try {
    await sleep(800)
    await embed(client)
    await client.call('semanticUnload', {})
    // Сторож не должен ронять процесс: токены продолжают считаться.
    const counted = await client.call('tokensCount', { text: 'hello world' })
    assert.equal(counted.ok, true, JSON.stringify(counted.error))
    assert.ok(counted.result.tokens > 0)
  } finally {
    await client.close()
  }
})
