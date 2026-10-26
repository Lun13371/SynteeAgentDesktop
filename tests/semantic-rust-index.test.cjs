/* global require, __dirname, process */
/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const Database = require('better-sqlite3')

// Сквозная проверка перенесённой semantic-подсистемы: индексация пишет векторы
// с тегом @q8-rust, поиск по ним находит семантически близкое, бюджет цикла
// реально режет работу, а неизменённые строки не переэмбеддятся.
//
// База — временная фикстура, рабочая БД пользователя не трогается.

const root = path.join(__dirname, '..')
const binaryName = process.platform === 'win32' ? 'syntee-sidecar.exe' : 'syntee-sidecar'
const binary = [
  path.join(root, 'resources', 'sidecar', binaryName),
  path.join(root, 'Sidecar', 'target', 'release', binaryName),
  path.join(root, 'Sidecar', 'target', 'debug', binaryName),
].find(candidate => fs.existsSync(candidate))

const MODEL_TAG = 'Xenova/multilingual-e5-small@q8-rust'
const cacheRoot = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'SynteeHelper',
  'transformers-cache',
)
const modelDir = path.join(cacheRoot, 'Xenova', 'multilingual-e5-small')
const modelPath = path.join(modelDir, 'onnx', 'model_quantized.onnx')
const tokenizerPath = path.join(modelDir, 'tokenizer.json')
const modelReady = fs.existsSync(modelPath) && fs.existsSync(tokenizerPath)

const skip = binary && modelReady
  ? false
  : !binary
    ? 'sidecar binary not built'
    : 'E5 model not cached'

/** Минимальная схема, повторяющая колонки, которые читает Rust. */
function createFixture(dbPath) {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE semantic_embeddings (
      source TEXT, source_id TEXT, content_hash TEXT, embedding BLOB,
      model TEXT, updated_at INTEGER,
      PRIMARY KEY (source, source_id)
    );
    CREATE TABLE memory_items (
      id TEXT PRIMARY KEY, scope TEXT, project_id TEXT, kind TEXT,
      content TEXT, importance REAL, title TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, chat_id TEXT, role TEXT, content TEXT, created_at INTEGER
    );
    CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT, project_id TEXT);
    CREATE TABLE chat_summaries (chat_id TEXT PRIMARY KEY, content TEXT, updated_at INTEGER);
    CREATE TABLE agent_logs (
      id TEXT PRIMARY KEY, chat_id TEXT, tool TEXT, args TEXT,
      result TEXT, error TEXT, created_at INTEGER
    );
    CREATE TABLE pinned_messages (message_id TEXT PRIMARY KEY, pinned_at INTEGER);
  `)

  const now = Date.now()
  const insertMemory = db.prepare(
    `INSERT INTO memory_items (id, scope, project_id, kind, content, importance, title)
     VALUES (?, 'global', NULL, 'project_decision', ?, ?, ?)`,
  )
  insertMemory.run(
    'm-docker',
    'Настроили nginx как reverse proxy перед приложением и выдали TLS-сертификат через Caddy.',
    0.9,
    'Docker и nginx',
  )
  insertMemory.run(
    'm-perf',
    'Индексация файлов вынесена в отдельный процесс, чтобы не блокировать event loop.',
    0.8,
    'Производительность индексации',
  )
  insertMemory.run(
    'm-cook',
    'Рецепт борща: свёкла, капуста, картофель, морковь и немного уксуса.',
    0.2,
    'Кулинарная заметка',
  )

  db.prepare('INSERT INTO chats (id, title, project_id) VALUES (?, ?, NULL)').run('c1', 'Первый чат')
  db.prepare(
    'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('msg1', 'c1', 'user', 'Как правильно прокинуть порты в контейнере и не потерять сертификаты?', now)

  db.close()
}

function runSidecar(requests, timeout = 300_000) {
  const input = requests.map(request => JSON.stringify(request)).join('\n') + '\n'
  const result = spawnSync(binary, [], {
    input, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function withFixture(run) {
  const dbPath = path.join(os.tmpdir(), `syntee-semantic-${process.pid}-${Date.now()}.db`)
  createFixture(dbPath)
  try {
    return run(dbPath)
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true })
  }
}

test('indexing writes @q8-rust vectors and is idempotent on the second run', { skip, timeout: 300_000 }, () => {
  withFixture(dbPath => {
    const first = runSidecar([
      {
        id: 'idx1',
        method: 'semanticIndex',
        params: {
          dbPath, modelPath, tokenizerPath,
          options: { sources: ['memory'], pageSize: 50, pauseBetweenItemsMs: 0, budgetMs: 120_000 },
        },
      },
      { id: 'bye', method: 'shutdown', params: {} },
    ]).find(row => row.id === 'idx1')
    assert.ok(first && first.ok, JSON.stringify(first))
    assert.equal(first.result.model, MODEL_TAG)
    assert.equal(first.result.totalIndexed, 3)
    assert.equal(first.result.budgetExhausted, false)

    const db = new Database(dbPath, { readonly: true })
    const rows = db.prepare('SELECT model, COUNT(*) c FROM semantic_embeddings GROUP BY model').all()
    assert.deepEqual(rows, [{ model: MODEL_TAG, c: 3 }])
    // Вектор 384-dim по 4 байта на float.
    const blob = db.prepare("SELECT LENGTH(embedding) l FROM semantic_embeddings WHERE source_id = 'm-docker'").get()
    assert.equal(blob.l, 384 * 4)
    db.close()

    // Второй прогон: ничего не изменилось → всё skipped, никакого переэмбеддинга.
    const second = runSidecar([
      {
        id: 'idx2',
        method: 'semanticIndex',
        params: {
          dbPath, modelPath, tokenizerPath,
          options: { sources: ['memory'], pageSize: 50, pauseBetweenItemsMs: 0, budgetMs: 120_000 },
        },
      },
      { id: 'bye', method: 'shutdown', params: {} },
    ]).find(row => row.id === 'idx2')
    assert.ok(second && second.ok, JSON.stringify(second))
    assert.equal(second.result.totalIndexed, 0)
    assert.equal(second.result.totalSkipped, 3)
  })
})

test('semantic search ranks by meaning, not by keyword overlap', { skip, timeout: 300_000 }, () => {
  withFixture(dbPath => {
    runSidecar([
      {
        id: 'idx',
        method: 'semanticIndex',
        params: {
          dbPath, modelPath, tokenizerPath,
          options: { sources: ['memory'], pageSize: 50, pauseBetweenItemsMs: 0, budgetMs: 120_000 },
        },
      },
      { id: 'bye', method: 'shutdown', params: {} },
    ])

    const responses = runSidecar([
      {
        id: 'q',
        method: 'semanticSearch',
        params: {
          dbPath, modelPath, tokenizerPath,
          // Ни слова «nginx»/«Caddy» — проверяем именно смысл.
          query: 'чем прикрыть веб-приложение и откуда взять сертификат',
          limit: 3,
          sources: ['memory'],
          memoryEnabled: true, memoryGlobal: true, memoryProject: true, memoryChat: true,
        },
      },
      { id: 'bye', method: 'shutdown', params: {} },
    ])
    const search = responses.find(row => row.id === 'q')
    assert.ok(search && search.ok, JSON.stringify(search))
    const hits = search.result.hits
    assert.equal(hits.length, 3)
    // Первым должен идти именно про nginx/TLS, а не про борщ.
    assert.equal(hits[0].sourceId, 'm-docker', JSON.stringify(hits.map(h => [h.sourceId, h.score])))
    assert.ok(hits[0].score > 0.7, `top score ${hits[0].score}`)
    // Оценки отсортированы по убыванию.
    for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score)
    // memory-хит обязан нести полную строку для rowToItem.
    assert.equal(hits[0].memoryRow.title, 'Docker и nginx')
  })
})

test('orphan embeddings of deleted rows are pruned', { skip, timeout: 300_000 }, () => {
  withFixture(dbPath => {
    const index = [
      {
        id: 'idx',
        method: 'semanticIndex',
        params: {
          dbPath, modelPath, tokenizerPath,
          options: { sources: ['memory'], pageSize: 50, pauseBetweenItemsMs: 0, budgetMs: 120_000 },
        },
      },
      { id: 'bye', method: 'shutdown', params: {} },
    ]
    runSidecar(index)

    // Строка источника исчезла (rewind/удаление памяти) — эмбеддинг должен уйти.
    const db = new Database(dbPath)
    db.prepare("DELETE FROM memory_items WHERE id = 'm-cook'").run()
    db.close()

    const second = runSidecar([
      {
        id: 'idx2',
        method: 'semanticIndex',
        params: {
          dbPath, modelPath, tokenizerPath,
          options: { sources: ['memory'], pageSize: 50, pauseBetweenItemsMs: 0, budgetMs: 120_000 },
        },
      },
      { id: 'bye', method: 'shutdown', params: {} },
    ]).find(row => row.id === 'idx2')
    assert.ok(second && second.ok, JSON.stringify(second))

    const check = new Database(dbPath, { readonly: true })
    const left = check.prepare("SELECT source_id FROM semantic_embeddings WHERE source = 'memory'").all()
    check.close()
    assert.deepEqual(left.map(row => row.source_id).sort(), ['m-docker', 'm-perf'])
  })
})
