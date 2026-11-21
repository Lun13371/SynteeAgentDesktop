/**
 * mapSemantic — семантический слой карты проекта.
 *
 * Покрывается:
 *  - buildDocsForFile: документы выводятся из узлов (tier 1 — файлы + exported,
 *    tier 2 — приватные символы), текст детерминирован (hash стабильный);
 *  - splitIdentifier: camelCase/snake_case → слова для E5 и lexical-канала;
 *  - topKByCosine: честный cosine по НЕнормированным векторам;
 *  - rrfMerge: слияние каналов (semantic/lexical/both) и ранжирование;
 *  - searchSemantic: деградация без модели (lexical) и при падении sidecar;
 *  - hash-гейт в mapStore: upsertDocs сохраняет вектор неизменённого текста,
 *    saveDocEmbeddings не пишет вектор под устаревший text_hash, очередь
 *    listPendingDocs идёт по tier.
 *
 * mapSemantic и mapStore транспилируются на лету (паттерн compact-tail-segments);
 * для store-тестов — настоящий better-sqlite3 в памяти + миграция codeMap.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import ts from 'typescript'
import Database from 'better-sqlite3'
import { setTimeout as delay } from 'node:timers/promises'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nodeRequire = createRequire(import.meta.url)

function transpile(relPath, requireShim) {
  const source = fs.readFileSync(path.join(root, relPath), 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  const requireShimFn = (spec) => {
    if (requireShim[spec]) return requireShim[spec]
    return nodeRequire(spec)
  }
  new Function('exports', 'require', 'module', js)(module.exports, requireShimFn, module)
  return module.exports
}

// ─── Чистые функции (store/sidecar шимятся пустышками) ───────────────────────

function loadMapSemantic(shims = {}) {
  const noopStore = {
    countDocs: () => ({ total: 0, indexed: 0 }),
    listDocTexts: () => [],
    listDocVectors: () => [],
    findNodes: () => [],
    getNode: () => null,
    listDocHashesByFile: () => new Map(),
    listDocMetaByFile: () => new Map(),
    pruneOrphanDocs: () => 0,
    upsertDocs: () => {},
    deleteDocsByIds: () => {},
    deleteDocsByFile: () => {},
    clearDocs: () => {},
    listPendingDocs: () => [],
    listPendingDocProjectIds: () => [],
    saveDocEmbeddings: () => 0,
  }
  const store = { ...noopStore, ...shims.store }
  return transpile('src/core/projectMap/mapSemantic.ts', {
    './mapStore': store,
    '../sidecar/sidecarClient': {
      resolveSemanticModelPaths: () => null,
      sidecarSemanticEmbed: async () => null,
      ...shims.sidecar,
    },
    '../memory/semanticIndex': { ensureModelFiles: async () => false },
    '../context/embeddings': {
      embeddingToBuffer: (emb) => Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength),
    },
    '../logger': { log: () => {} },
  })
}

function node(id, name, kind, opts = {}) {
  return {
    id, projectId: 'p1', filePath: opts.filePath ?? 'src/a.ts',
    name, kind, parentName: opts.parentName ?? null,
    lineStart: opts.line ?? 1, lineEnd: opts.line ?? 10,
    signature: opts.signature ?? '', exported: opts.exported ?? false,
    doc: opts.doc ?? null,
  }
}

test('splitIdentifier — camelCase, snake_case, ABBR и короткие токены', () => {
  const api = loadMapSemantic()
  assert.deepEqual(api.splitIdentifier('compactHistory'), ['compact', 'history'])
  assert.deepEqual(api.splitIdentifier('parse_URL_data'), ['parse', 'url', 'data'])
  assert.deepEqual(api.splitIdentifier('XMLHttpRequest'), ['xml', 'http', 'request'])
  assert.deepEqual(api.splitIdentifier('render'), ['render'])
  assert.deepEqual(api.splitIdentifier('a_b'), [], 'однобуквенные токены отфильтрованы')
})

test('buildDocsForFile — tier 1: файл + exported; приватный без docstring → tier 0 (не эмбеддится), package исключён', () => {
  const api = loadMapSemantic()
  const fileNode = node('src/a.ts', 'a.ts', 'file', { filePath: 'src/a.ts' })
  const exported = node('src/a.ts#validateAccess', 'validateAccess', 'function', {
    signature: 'export function validateAccess(u: User)', exported: true,
  })
  const hidden = node('src/a.ts#helper', 'helper', 'function', {})
  const pkg = node('pkg:react', 'react', 'package')
  const docs = api.buildDocsForFile([fileNode, pkg, exported, hidden])

  const byId = new Map(docs.map(d => [d.nodeId, d]))
  assert.equal(byId.get('src/a.ts').tier, 1)
  assert.equal(byId.get('src/a.ts#validateAccess').tier, 1)
  // Внутренняя функция без docstring: текст = пересказ имени, E5 не даёт прироста
  // над lexical — вектор не считаем (tier 0), но документ остаётся для lexical.
  assert.equal(byId.get('src/a.ts#helper').tier, 0)
  assert.ok(byId.has('src/a.ts#helper'), 'tier 0 остаётся в lexical-индексе')
  assert.ok(!byId.has('pkg:react'), 'package-узел не даёт документа')
  assert.ok(byId.get('src/a.ts#validateAccess').text.includes('validateAccess'))
  assert.ok(byId.get('src/a.ts#validateAccess').text.includes('src/a.ts'), 'путь в тексте документа')
  assert.ok(byId.get('src/a.ts#validateAccess').text.includes('validate access'), 'имя разбито на слова для E5')
  // hash детерминирован: тот же узел → тот же textHash
  const again = api.buildDocsForFile([fileNode, pkg, exported, hidden])
  assert.equal(again.find(d => d.nodeId === 'src/a.ts#validateAccess').textHash,
    byId.get('src/a.ts#validateAccess').textHash)
})

test('buildDocsForFile — приватный символ с docstring → tier 2', () => {
  const api = loadMapSemantic()
  const fileNode = node('src/a.ts', 'a.ts', 'file', { filePath: 'src/a.ts' })
  const documented = node('src/a.ts#helper', 'helper', 'function', {
    doc: 'Нормализует телефон в E.164 и отбрасывает мусорные символы из ввода',
  })
  const docs = api.buildDocsForFile([fileNode, documented])
  const byId = new Map(docs.map(d => [d.nodeId, d]))
  assert.equal(byId.get('src/a.ts#helper').tier, 2, 'docstring делает внутренний символ осмысленным для E5')
})

test('buildDocsForFile — python top-level функции в tier 1 (нет export-ключевика)', () => {
  const api = loadMapSemantic()
  const fileNode = node('backend/app/api/user/auth.py', 'auth.py', 'file', { filePath: 'backend/app/api/user/auth.py' })
  const login = node('backend/app/api/user/auth.py#login', 'login', 'function', {
    filePath: 'backend/app/api/user/auth.py', signature: 'def login(db, payload)', line: 359,
  })
  const inner = node('backend/app/api/user/auth.py#login._helper', 'helper', 'function', {
    filePath: 'backend/app/api/user/auth.py', parentName: 'login', line: 370,
  })
  const docs = api.buildDocsForFile([fileNode, login, inner])
  const byId = new Map(docs.map(d => [d.nodeId, d]))
  assert.equal(byId.get('backend/app/api/user/auth.py#login').tier, 1, 'python top-level — публичный API')
  assert.equal(byId.get('backend/app/api/user/auth.py#login._helper').tier, 2, 'вложенный символ — tier 2')
})

test('topKByCosine — честный cosine по ненормированным векторам', () => {
  const api = loadMapSemantic()
  // dim=3; строки ненормированы (длина 3 и 5), norms заданы явно
  const m = {
    ids: ['a', 'b', 'c'],
    vectors: new Float32Array([3, 0, 0, 0, 5, 0, 0.1, 0.2, 0]),
    norms: new Float32Array([3, 5, Math.hypot(0.1, 0.2)]),
    dim: 3,
  }
  const q = Float32Array.from([1, 0, 0])
  const hits = api.topKByCosine(m, q, 3)
  assert.equal(hits[0], 'a', 'коллинеарный вектор — cosine 1.0 независимо от длины')
  assert.ok(hits.includes('b') || hits.includes('c'))
})

test('rrfMerge — «both» бьёт одиночный канал, метки каналов корректны', () => {
  const api = loadMapSemantic()
  const merged = api.rrfMerge(['vec1', 'vec2'], ['lex1', 'vec1'], ['name1'])
  const both = merged.get('vec1')
  const semOnly = merged.get('vec2')
  const lexOnly = merged.get('lex1')
  const nameOnly = merged.get('name1')
  assert.equal(both.matchedBy, 'both')
  assert.equal(semOnly.matchedBy, 'semantic')
  assert.equal(lexOnly.matchedBy, 'lexical')
  assert.equal(nameOnly.matchedBy, 'lexical')
  // vec1: rank0 в векторах + rank1 в словах; vec2: rank1 только в векторах.
  // 1/61 + 1/62 > 1/61 → vec1 выше.
  assert.ok(both.score > semOnly.score)
  // rank0 в любом канале (1/61) больше rank0… нет: name1 rank0 → 1/61 = lex1 rank0.
  assert.equal(nameOnly.score, lexOnly.score)
})

// ─── searchSemantic: деградация ──────────────────────────────────────────────

const SEM_DOCS = [
  { nodeId: 'src/auth.ts#validateAccess', filePath: 'src/auth.ts', kind: 'function', tier: 1, text: 'function validateAccess — validate access — checks user permissions', textHash: 'h1' },
  { nodeId: 'src/auth.ts', filePath: 'src/auth.ts', kind: 'file', tier: 1, text: 'File src/auth.ts — exports: validateAccess (function)', textHash: 'h2' },
  { nodeId: 'src/ui.tsx#renderChart', filePath: 'src/ui.tsx', kind: 'function', tier: 2, text: 'function renderChart — render chart — draws canvas diagram', textHash: 'h3' },
]
const SEM_NODES = new Map([
  ['src/auth.ts#validateAccess', node('src/auth.ts#validateAccess', 'validateAccess', 'function', { exported: true })],
  ['src/auth.ts', node('src/auth.ts', 'auth.ts', 'file', { filePath: 'src/auth.ts' })],
  ['src/ui.tsx#renderChart', node('src/ui.tsx#renderChart', 'renderChart', 'function')],
])

test('searchSemantic — без модели деградирует в lexical и находит по словам', async () => {
  const api = loadMapSemantic({
    store: {
      countDocs: () => ({ total: 3, indexed: 0 }),
      listDocTexts: () => SEM_DOCS,
      findNodes: () => [],
      getNode: (_pid, id) => SEM_NODES.get(id) ?? null,
    },
  })
  const res = await api.searchSemantic('p1', 'access permissions', 5)
  assert.equal(res.mode, 'lexical')
  assert.equal(res.totalDocs, 3)
  assert.ok(res.hits.length > 0)
  assert.equal(res.hits[0].node.id, 'src/auth.ts#validateAccess', 'документ со словами access+permissions — топ')
  assert.equal(res.hits[0].matchedBy, 'lexical')
})

test('searchSemantic — точное имя через findNodes поднимается даже без слов в документах', async () => {
  const api = loadMapSemantic({
    store: {
      countDocs: () => ({ total: 3, indexed: 0 }),
      listDocTexts: () => SEM_DOCS.filter(d => d.nodeId === 'src/ui.tsx#renderChart'),
      findNodes: (_pid, q) => q.toLowerCase() === 'renderchart' ? [SEM_NODES.get('src/ui.tsx#renderChart')] : [],
      getNode: (_pid, id) => SEM_NODES.get(id) ?? null,
    },
  })
  const res = await api.searchSemantic('p1', 'renderchart', 5)
  assert.equal(res.mode, 'lexical')
  assert.equal(res.hits[0]?.node.id, 'src/ui.tsx#renderChart')
})

test('searchSemantic — падение sidecar при запросе не роняет поиск (lexical)', async () => {
  const api = loadMapSemantic({
    store: {
      countDocs: () => ({ total: 3, indexed: 3 }),
      listDocTexts: () => SEM_DOCS,
      findNodes: () => [],
      getNode: (_pid, id) => SEM_NODES.get(id) ?? null,
      listDocVectors: () => [],
    },
    sidecar: {
      resolveSemanticModelPaths: () => ({ modelPath: 'm', tokenizerPath: 't' }),
      sidecarSemanticEmbed: async () => { throw new Error('sidecar busy') },
    },
  })
  const res = await api.searchSemantic('p1', 'access', 5)
  assert.equal(res.mode, 'lexical', 'ошибка embed → деградация, не исключение')
  assert.ok(res.hits.length > 0)
})

// ─── mapStore: hash-гейт и очередь (настоящная SQLite в памяти) ──────────────

function loadMapStore(db) {
  // Миграция — тоже транспилируется (type-only импорты стираются).
  const migration = transpile('src/core/db/migrations/codeMap.ts', {})
  migration.runCodeMapSchema(db)
  return transpile('src/core/projectMap/mapStore.ts', {
    '../db/handle': { getDB: () => db },
  })
}

const bufferOf = (arr) => Buffer.from(Float32Array.from(arr).buffer)

test('mapStore docs: hash-гейт сохраняет вектор неизменённого текста', () => {
  const db = new Database(':memory:')
  const store = loadMapStore(db)
  const doc = { nodeId: 'src/a.ts#f', filePath: 'src/a.ts', kind: 'function', tier: 1, text: 'function f', textHash: 'h1' }

  store.upsertDocs('p1', [doc])
  assert.equal(store.countDocs('p1').total, 1)
  assert.equal(store.countDocs('p1').indexed, 0, 'без вектора документ не «indexed»')

  // Пишем вектор под актуальный hash.
  const saved = store.saveDocEmbeddings('p1', [
    { nodeId: 'src/a.ts#f', textHash: 'h1', embedding: bufferOf([1, 2, 3]), model: 'e5', embeddedAt: 1 },
  ])
  assert.equal(saved, 1)
  assert.equal(store.countDocs('p1').indexed, 1)

  // Переразбор: текст не изменился → вектор выжил.
  store.upsertDocs('p1', [{ ...doc }])
  assert.equal(store.countDocs('p1').indexed, 1, 'hash-гейт: вектор не сброшен')

  // Текст изменился → вектор сброшен, документ снова pending.
  store.upsertDocs('p1', [{ ...doc, text: 'function f (x)', textHash: 'h2' }])
  assert.equal(store.countDocs('p1').indexed, 0)
  assert.equal(store.listPendingDocs('p1', 10).length, 1)
})

test('mapStore docs: saveDocEmbeddings не пишет вектор под устаревший hash', () => {
  const db = new Database(':memory:')
  const store = loadMapStore(db)
  store.upsertDocs('p1', [
    { nodeId: 'a', filePath: 'a.ts', kind: 'function', tier: 1, text: 'v1', textHash: 'h1' },
  ])
  // Sidecar считал пачку, но текст уже сменился (h2) — вектор не запишется.
  const saved = store.saveDocEmbeddings('p1', [
    { nodeId: 'a', textHash: 'h_stale', embedding: bufferOf([1]), model: 'e5', embeddedAt: 1 },
  ])
  assert.equal(saved, 0)
  assert.equal(store.countDocs('p1').indexed, 0)
})

test('mapStore docs: очередь listPendingDocs — tier 1 раньше tier 2, indexed не в очереди', () => {
  const db = new Database(':memory:')
  const store = loadMapStore(db)
  store.upsertDocs('p1', [
    { nodeId: 'priv', filePath: 'a.ts', kind: 'function', tier: 2, text: 'private fn', textHash: 'hp' },
    { nodeId: 'exp', filePath: 'b.ts', kind: 'function', tier: 1, text: 'exported fn', textHash: 'he' },
  ])
  store.saveDocEmbeddings('p1', [
    { nodeId: 'exp', textHash: 'he', embedding: bufferOf([1]), model: 'e5', embeddedAt: 1 },
  ])
  const pending = store.listPendingDocs('p1', 10)
  assert.deepEqual(pending.map(d => d.nodeId), ['priv'], 'indexed выпал из очереди, остался tier 2')

  // Очистка проекта — документы тоже.
  store.clearDocs('p1')
  assert.equal(store.countDocs('p1').total, 0)
})

// ─── Тул project_map action=semantic: сквозной прогон на настоящем store ─────

test('тул semantic end-to-end: real store, lexical-деградация, связи из графа', async () => {
  const db = new Database(':memory:')
  transpile('src/core/db/migrations/codeMap.ts', {}).runCodeMapSchema(db)
  const store = transpile('src/core/projectMap/mapStore.ts', { '../db/handle': { getDB: () => db } })
  const mapSemantic = transpile('src/core/projectMap/mapSemantic.ts', {
    './mapStore': store,
    '../sidecar/sidecarClient': { resolveSemanticModelPaths: () => null, sidecarSemanticEmbed: async () => null },
    '../memory/semanticIndex': { ensureModelFiles: async () => false },
    '../context/embeddings': {
      embeddingToBuffer: (emb) => Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength),
    },
    '../logger': { log: () => {} },
  })
  // Модель недоступна, worker не нужен — гасим сразу после sync (nudge отложен).
  mapSemantic.semanticWorker.stop()

  const meta = (p) => ({ projectId: 'p1', path: p, language: 'typescript', hash: 'x', mtime: 1, size: 10, parser: 'ts', truncated: false, indexedAt: 1 })
  const mkNode = (id, name, kind, opts = {}) => ({
    id, projectId: 'p1', filePath: opts.filePath ?? id.split('#')[0], name, kind,
    parentName: null, lineStart: opts.line ?? 1, lineEnd: opts.line ?? 10,
    signature: opts.signature ?? '', exported: opts.exported ?? false,
  })
  const fileNode = mkNode('src/auth.ts', 'auth.ts', 'file')
  const fn = mkNode('src/auth.ts#validateAccess', 'validateAccess', 'function', {
    signature: 'export function validateAccess(u: User)', exported: true, line: 10,
  })
  const caller = mkNode('src/main.ts#boot', 'boot', 'function', { filePath: 'src/main.ts' })
  const edge = {
    id: 'src/main.ts#boot|calls|src/auth.ts#validateAccess|12', projectId: 'p1',
    fromNode: 'src/main.ts#boot', toNode: 'src/auth.ts#validateAccess',
    type: 'calls', precision: 'resolved', filePath: 'src/main.ts', line: 12,
  }
  store.replaceFile('p1', meta('src/auth.ts'), [fileNode, fn], [])
  store.replaceFile('p1', meta('src/main.ts'), [caller], [edge])
  mapSemantic.syncFileDocs('p1', 'src/auth.ts', [fileNode, fn])
  mapSemantic.syncFileDocs('p1', 'src/main.ts', [caller])
  store.setStatus('p1', { state: 'ready' })
  store.refreshCounts('p1')

  const tool = transpile('src/core/tools/projectMap.ts', {
    '../projectMap/mapStore': store,
    '../projectMap/mapSemantic': mapSemantic,
    '../projectMap/mapAnalytics': {
      godNodes: () => [],
      computeCommunities: () => ({ communities: [], assignment: new Map() }),
      findPath: () => ({ found: false, hops: [], confidence: 0, weakest: null }),
      affectedNodes: () => ({ root: null, results: [], byFile: [] }),
      resolveAnalyticsNode: () => null,
    },
    '../logger': { log: () => {} },
  })
  const res = await tool.projectMapQuery({ action: 'semantic', query: 'validate access permissions' }, 'p1')

  assert.equal(res.success, true)
  assert.match(res.output, /mode: lexical/, 'без модели — честная пометка режима')
  assert.match(res.output, /validateAccess/, 'нужный символ найден по словам документа')
  assert.match(res.output, /called by/, 'связи из графа приклеены к хиту')

  const miss = await tool.projectMapQuery({ action: 'semantic', query: 'zzz_nothing_matches_this' }, 'p1')
  assert.equal(miss.success, true)
  assert.match(miss.output, /no matches/i)
})

// ─── Облегчение документов: variable/field без семантики ─────────────────────

test('buildDocsForFile — variable/field не получают документов (шум для E5, имя ищется findNodes)', () => {
  const api = loadMapSemantic()
  const nodes = [
    node('src/Entity.cs', 'Entity.cs', 'file', { filePath: 'src/Entity.cs' }),
    node('src/Entity.cs#Entity', 'Entity', 'class', { exported: true, signature: 'class Entity' }),
    node('src/Entity.cs#Entity.speed', 'speed', 'field', { parentName: 'Entity', signature: 'public float speed;' }),
    node('src/Entity.cs#Move', 'Move', 'function', { parentName: 'Entity', signature: 'void Move()' }),
  ]
  const docs = api.buildDocsForFile(nodes)
  const kinds = docs.map(d => d.kind).sort()
  assert.ok(!docs.some(d => d.kind === 'field'), 'field-документов быть не должно')
  assert.ok(docs.some(d => d.kind === 'class'), 'класс остаётся')
  assert.ok(docs.some(d => d.kind === 'function'), 'функция остаётся')
  assert.ok(docs.some(d => d.kind === 'file'), 'файл остаётся')
  void kinds
})

// ─── Демоция тестовых путей в ранжировании ───────────────────────────────────

test('isTestPath — tests/, *.test.ts, test_*.py, *_test.go — да; prod-пути — нет', () => {
  const api = loadMapSemantic()
  assert.equal(api.isTestPath('src/__tests__/auth.test.ts'), true)
  assert.equal(api.isTestPath('backend/tests/test_login.py'), true)
  assert.equal(api.isTestPath('routing/key_manager_test.go'), true)
  assert.equal(api.isTestPath('src/auth.spec.tsx'), true)
  assert.equal(api.isTestPath('backend/app/api/user/auth.py'), false)
  assert.equal(api.isTestPath('src/auth/service.ts'), false, 'подстрока test внутри имени — не тест')
})

test('searchSemantic — тестовый файл с совпадающими словами приглушается под prod-символ', async () => {
  const docs = [
    { nodeId: 'src/auth/verify_password.test.ts#t', filePath: 'src/auth/verify_password.test.ts', kind: 'function', tier: 2, text: 'function test verify password captcha check — test verify password captcha', textHash: 't1' },
    { nodeId: 'src/auth/service.ts#verify_password', filePath: 'src/auth/service.ts', kind: 'function', tier: 2, text: 'function verify_password — verify password — captcha check before login', textHash: 't2' },
  ]
  const nodes = new Map([
    ['src/auth/verify_password.test.ts#t', node('src/auth/verify_password.test.ts#t', 'test_verify_password', 'function', { filePath: 'src/auth/verify_password.test.ts' })],
    ['src/auth/service.ts#verify_password', node('src/auth/service.ts#verify_password', 'verify_password', 'function', { filePath: 'src/auth/service.ts' })],
  ])
  const api = loadMapSemantic({
    store: {
      countDocs: () => ({ total: 2, indexed: 0 }),
      listDocTexts: () => docs,
      findNodes: () => [],
      getNode: (_pid, id) => nodes.get(id) ?? null,
    },
  })
  const res = await api.searchSemantic('p1', 'verify password captcha', 5)
  assert.equal(res.mode, 'lexical')
  assert.equal(res.hits[0]?.node.id, 'src/auth/service.ts#verify_password',
    'прод-символ выше: тестовый путь получил демоцию ×0.3')
})

// ─── Слова-идентификаторы запроса → точный name-канал ────────────────────────

test('searchSemantic — «скидки get_user_input_price» находит символ по слову-идентификатору', async () => {
  const target = node('billing/pricing.py#get_user_input_price', 'get_user_input_price', 'function', { filePath: 'billing/pricing.py' })
  const noise = node('billing/billing.py#billing_doc', 'billing_doc', 'function', { filePath: 'billing/billing.py' })
  const api = loadMapSemantic({
    store: {
      countDocs: () => ({ total: 2, indexed: 0 }),
      listDocTexts: () => [
        { nodeId: 'billing/billing.py#billing_doc', filePath: 'billing/billing.py', kind: 'function', tier: 1, text: 'function billing_doc — billing charges money', textHash: 'b1' },
      ],
      findNodes: (_pid, q) => (q.toLowerCase() === 'get_user_input_price' ? [target] : q.includes('скидки') ? [noise] : []),
      getNode: (_pid, id) => (id === target.id ? target : null),
    },
  })
  const res = await api.searchSemantic('p1', 'скидки на модели get_user_input_price', 5)
  assert.equal(res.mode, 'lexical')
  assert.equal(res.hits[0]?.node.id, 'billing/pricing.py#get_user_input_price',
    'ASCII-слово запроса → точное совпадение имени → топ даже без векторов/слов документа')
})

// ─── fileIndexer: gitignore со скобками (Unity) и вложенные пути ─────────────

function loadFileIndexer() {
  return transpile('src/core/mentions/fileIndexer.ts', {
    '../../shared/mentions': {
      filterMentions: (items) => items,
      mimeFromExt: () => 'text/plain',
      mentionTypeFromFilename: () => 'file',
    },
  })
}

test('expandCharClasses — [Ll]ibrary разворачивается в оба варианта, битые классы остаются literal', () => {
  const api = loadFileIndexer()
  assert.deepEqual(api.expandCharClasses('[Ll]ibrary/'), ['Library/', 'library/'])
  const four = api.expandCharClasses('[Uu]ser[Ss]ettings')
  assert.equal(four.length, 4, 'два класса → 2×2 варианта')
  assert.ok(four.includes('UserSettings') && four.includes('usersettings'))
  assert.deepEqual(api.expandCharClasses('plain/path'), ['plain/path'])
  assert.deepEqual(api.expandCharClasses('weird[unclosed'), ['weird[unclosed'])
})

test('parseGitignore/isIgnored — Unity-проект: Library/Temp ушли, Assets и polyperfect-исключение работают', () => {
  const api = loadFileIndexer()
  const tmp = fs.mkdtempSync(path.join(nodeRequire('os').tmpdir(), 'syntee-gi-'))
  fs.writeFileSync(path.join(tmp, '.gitignore'), [
    '# === Unity ===',
    '[Ll]ibrary/',
    '[Tt]emp/',
    '[Oo]bj/',
    'Assets/polyperfect/',
    '*.pdb',
    'crash-report-*.json',
    'docs/generated.md',
    '',
  ].join('\n'))
  try {
    const gi = api.parseGitignore(tmp)
    assert.ok(gi.dirs.has('Library') && gi.dirs.has('library'), 'скобочный класс → оба варианта имени')
    assert.ok(gi.dirs.has('Temp'), 'Temp попал в dirs')
    assert.ok(gi.dirPaths.has('Assets/polyperfect'), 'вложенный путь директории — отдельно')
    assert.ok(gi.exts.has('.pdb'))
    assert.ok(gi.filePaths.has('docs/generated.md'), 'файловый паттерн с путём — отдельно')

    const ign = (rel, name) => api.isIgnored(rel, name, gi)
    assert.equal(ign('Library/PackageCache/com.unity.ugui/Runtime/TMP_Text.cs', 'TMP_Text.cs'), true, 'движковый кэш игнорится')
    assert.equal(ign('Temp/unity.lock', 'unity.lock'), true)
    assert.equal(ign('Assets/Scripts/Player/Shooter.cs', 'Shooter.cs'), false, 'код игры НЕ игнорится')
    assert.equal(ign('Assets/polyperfect/Pack/Model.cs', 'Model.cs'), true, 'исключение по вложенному пути работает')
    assert.equal(ign('Assets/Models/rock.pdb', 'rock.pdb'), true, 'ext-паттерн из gitignore')
    assert.equal(ign('Assets/Models/rock.cs', 'rock.cs'), false)
    assert.equal(ign('docs/generated.md', 'generated.md'), true, 'файловый паттерн по пути')
    assert.equal(ign('Temp', 'Temp'), true, 'root-папка сама матчится сегментом (в scanDir так же)')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// ─── Doc-контекст из sidecar в тексте документа ──────────────────────────────

test('buildSymbolDocText — docstring/декораторы попадают в документ и меняют hash', () => {
  const api = loadMapSemantic()
  const base = node('backend/app/api/user/auth.py#login', 'login', 'function', {
    filePath: 'backend/app/api/user/auth.py',
    signature: 'async def login(req: LoginRequest)',
  })
  const withDoc = { ...base, doc: '@router.post("/login") Логин по email и паролю, выдача токенов' }
  const plain = api.buildSymbolDocText(base)
  const rich = api.buildSymbolDocText(withDoc)
  assert.ok(rich.includes('@router.post("/login")'), 'декоратор в тексте документа')
  assert.ok(rich.includes('Логин по email и паролю'), 'docstring в тексте документа')
  assert.notEqual(plain, rich, 'текст (а значит и text_hash) изменился → переэмбед по hash-гейту')
  // Разрывы строк в doc-тексте схлопываются
  const multiline = api.buildSymbolDocText({ ...base, doc: 'первая строка\nвторая строка' })
  assert.ok(!/[\n\r]/.test(multiline), 'doc в одну строку')
})

// ─── Версия модели (тег в колонке model) и guard устаревших векторов ─────────

test('mapStore docs: вектор другой модели не считается indexed и попадает в очередь', () => {
  const db = new Database(':memory:')
  const store = loadMapStore(db)
  store.upsertDocs('p1', [
    { nodeId: 'a', filePath: 'a.ts', kind: 'function', tier: 1, text: 'fn a', textHash: 'h1' },
  ])
  // Вектор посчитан старой/другой моделью — в поиске он не годится.
  store.saveDocEmbeddings('p1', [
    { nodeId: 'a', textHash: 'h1', embedding: bufferOf([1, 0]), model: 'old-model', embeddedAt: 1 },
  ])
  assert.equal(store.countDocs('p1').indexed, 0, 'чужая модель не даёт indexed')
  assert.equal(store.listDocVectors('p1').length, 0, 'устаревший вектор не попадает в матрицу')
  assert.deepEqual(store.listPendingDocs('p1', 10).map(d => d.nodeId), ['a'], 'документ снова в очереди')

  // Текущая модель — indexed и матрица.
  store.saveDocEmbeddings('p1', [
    { nodeId: 'a', textHash: 'h1', embedding: bufferOf([1, 0]), model: 'e5', embeddedAt: 2 },
  ])
  assert.equal(store.countDocs('p1').indexed, 1)
  assert.deepEqual(store.listDocVectors('p1').map(v => v.nodeId), ['a'])
  assert.equal(store.listPendingDocs('p1', 10).length, 0, 'очередь пуста')
})

test('mapStore docs: listDocVectors отбрасывает вектор под устаревший text_hash', () => {
  const db = new Database(':memory:')
  const store = loadMapStore(db)
  const doc = { nodeId: 'a', filePath: 'a.ts', kind: 'function', tier: 1, text: 'v1', textHash: 'h1' }
  store.upsertDocs('p1', [doc])
  store.saveDocEmbeddings('p1', [
    { nodeId: 'a', textHash: 'h1', embedding: bufferOf([1, 0]), model: 'e5', embeddedAt: 1 },
  ])
  assert.equal(store.listDocVectors('p1').length, 1)
  // Текст сменился: embed_hash остался старым, но text_hash уже другой.
  store.upsertDocs('p1', [{ ...doc, text: 'v2', textHash: 'h2' }])
  assert.equal(store.listDocVectors('p1').length, 0, 'устаревший вектор не участвует в ранжировании')
})

test('mapStore docs: upsertDocs переносит вектор при равном тексте (в т.ч. tier 0→1)', () => {
  const db = new Database(':memory:')
  const store = loadMapStore(db)
  const doc = { nodeId: 'a', filePath: 'a.ts', kind: 'function', tier: 0, text: 'same text', textHash: 'hs' }
  store.upsertDocs('p1', [doc])
  store.saveDocEmbeddings('p1', [
    { nodeId: 'a', textHash: 'hs', embedding: bufferOf([1, 0]), model: 'e5', embeddedAt: 1 },
  ])
  // Текст тот же, tier вырос — вектор должен выжить (не переэмбеддится).
  store.upsertDocs('p1', [{ ...doc, tier: 1 }])
  assert.equal(store.countDocs('p1').indexed, 1, 'равный текст → вектор сохранён')
  assert.equal(store.listPendingDocs('p1', 10).length, 0)
})

test('mapStore docs: pruneOrphanDocs чистит только документы без узлов', () => {
  const db = new Database(':memory:')
  const store = loadMapStore(db)
  const meta = { projectId: 'p1', path: 'a.ts', language: 'typescript', hash: 'x', mtime: 1, size: 1, parser: 'ts', truncated: false, indexedAt: 1 }
  const alive = { id: 'a.ts#f', projectId: 'p1', filePath: 'a.ts', name: 'f', kind: 'function', parentName: null, lineStart: 1, lineEnd: 2, signature: '', exported: true, doc: null }
  store.replaceFile('p1', meta, [alive], [])
  store.upsertDocs('p1', [
    { nodeId: 'a.ts#f', filePath: 'a.ts', kind: 'function', tier: 1, text: 'fn f', textHash: 'h1' },
    { nodeId: 'a.ts#gone', filePath: 'a.ts', kind: 'function', tier: 1, text: 'fn gone', textHash: 'h2' },
  ])
  store.saveDocEmbeddings('p1', [
    { nodeId: 'a.ts#f', textHash: 'h1', embedding: bufferOf([1, 0]), model: 'e5', embeddedAt: 1 },
    { nodeId: 'a.ts#gone', textHash: 'h2', embedding: bufferOf([1, 0]), model: 'e5', embeddedAt: 1 },
  ])
  assert.equal(store.pruneOrphanDocs('p1'), 1, 'удалён только осиротевший документ')
  assert.equal(store.countDocs('p1').indexed, 1, 'вектор выжившего узла не потерян')
})

// ─── Поиск: гибрид, bounded fallback, deferred-статус ────────────────────────

test('searchSemantic — точное имя не ждёт sidecar (векторный канал пропускается)', async () => {
  const target = node('src/auth.ts#validateAccess', 'validateAccess', 'function', { exported: true })
  let embedCalls = 0
  const api = loadMapSemantic({
    store: {
      countDocs: () => ({ total: 1, indexed: 1 }),
      listDocTexts: () => [
        { nodeId: target.id, filePath: 'src/auth.ts', kind: 'function', tier: 1, text: 'function validateAccess', textHash: 'h1' },
      ],
      listDocVectors: () => [{ nodeId: target.id, embedding: bufferOf([1, 0]) }],
      findNodes: (_pid, q) => (q.toLowerCase() === 'validateaccess' ? [target] : []),
      getNode: (_pid, id) => (id === target.id ? target : null),
    },
    sidecar: {
      resolveSemanticModelPaths: () => ({ modelPath: 'm', tokenizerPath: 't' }),
      sidecarSemanticEmbed: async () => { embedCalls++; await delay(2000); return [[1, 0]] },
    },
  })
  const started = Date.now()
  const res = await api.searchSemantic('p1', 'validateAccess', 5)
  const elapsed = Date.now() - started
  assert.equal(res.hits[0]?.node.id, target.id)
  assert.equal(embedCalls, 0, 'при точном имени инференс не вызывается')
  assert.ok(elapsed < 500, `ответ мгновенный, а не 6с (${elapsed}ms)`)
})

test('searchSemantic — дескриптивный запрос сохраняет гибрид (e5 + lexical)', async () => {
  const a = node('src/chart.ts#drawChart', 'drawChart', 'function', { filePath: 'src/chart.ts' })
  const b = node('src/chart.ts#drawAxis', 'drawAxis', 'function', { filePath: 'src/chart.ts' })
  const api = loadMapSemantic({
    store: {
      countDocs: () => ({ total: 2, indexed: 2 }),
      listDocTexts: () => [
        { nodeId: a.id, filePath: 'src/chart.ts', kind: 'function', tier: 1, text: 'function drawChart — draws canvas diagram', textHash: 'h1' },
        { nodeId: b.id, filePath: 'src/chart.ts', kind: 'function', tier: 1, text: 'function drawAxis — axis ticks', textHash: 'h2' },
      ],
      listDocVectors: () => [
        { nodeId: a.id, embedding: bufferOf([1, 0]) },
        { nodeId: b.id, embedding: bufferOf([0, 1]) },
      ],
      findNodes: () => [],
      getNode: (_pid, id) => (id === a.id ? a : id === b.id ? b : null),
    },
    sidecar: {
      resolveSemanticModelPaths: () => ({ modelPath: 'm', tokenizerPath: 't' }),
      sidecarSemanticEmbed: async () => [[1, 0]],
    },
  })
  const res = await api.searchSemantic('p1', 'diagram of a canvas', 5)
  assert.equal(res.mode, 'e5', 'векторы готовы → e5-режим')
  assert.equal(res.hits[0]?.node.id, a.id)
  assert.equal(res.hits[0].matchedBy, 'both', 'вектор + слова документа: гибридное слияние')
})

test('searchSemantic — зависший sidecar: bounded fallback в lexical', async () => {
  const a = node('src/chart.ts#drawChart', 'drawChart', 'function', { filePath: 'src/chart.ts' })
  const api = loadMapSemantic({
    store: {
      countDocs: () => ({ total: 1, indexed: 1 }),
      listDocTexts: () => [
        { nodeId: a.id, filePath: 'src/chart.ts', kind: 'function', tier: 1, text: 'function drawChart — draws canvas diagram', textHash: 'h1' },
      ],
      listDocVectors: () => [{ nodeId: a.id, embedding: bufferOf([1, 0]) }],
      findNodes: () => [],
      getNode: (_pid, id) => (id === a.id ? a : null),
    },
    sidecar: {
      resolveSemanticModelPaths: () => ({ modelPath: 'm', tokenizerPath: 't' }),
      sidecarSemanticEmbed: () => new Promise(() => { /* навсегда занят */ }),
    },
  })
  const started = Date.now()
  const res = await api.searchSemantic('p1', 'diagram canvas', 5)
  const elapsed = Date.now() - started
  assert.equal(res.mode, 'lexical', 'не дождались вектора — честный lexical')
  assert.ok(res.hits.length > 0)
  assert.ok(elapsed < 3000, `дедлайн bounded (${elapsed}ms), а не 6с`)
})

test('searchSemantic — ноль E5-документов (только tier 0): lexical/имя всё равно работают', async () => {
  const a = node('src/chart.ts#drawChart', 'drawChart', 'function', { filePath: 'src/chart.ts' })
  let embedCalls = 0
  const api = loadMapSemantic({
    store: {
      // total/indexed — только по E5-eligible (tier>0); tier 0 живёт в lexical.
      countDocs: () => ({ total: 0, indexed: 0, lexicalOnly: 2 }),
      listDocTexts: () => [
        { nodeId: a.id, filePath: 'src/chart.ts', kind: 'function', tier: 0, text: 'function drawChart — draws canvas diagram', textHash: 'h1' },
      ],
      findNodes: (_pid, q) => (q.toLowerCase() === 'drawchart' ? [a] : []),
      getNode: (_pid, id) => (id === a.id ? a : null),
    },
    sidecar: {
      resolveSemanticModelPaths: () => ({ modelPath: 'm', tokenizerPath: 't' }),
      sidecarSemanticEmbed: async () => { embedCalls++; return [[1, 0]] },
    },
  })
  const byWords = await api.searchSemantic('p1', 'canvas diagram', 5)
  assert.equal(byWords.mode, 'lexical', 'не «none»: lexical-канал по tier 0 работает')
  assert.equal(byWords.hits[0]?.node.id, a.id)
  const byName = await api.searchSemantic('p1', 'drawChart', 5)
  assert.equal(byName.hits[0]?.node.id, a.id)
  assert.equal(embedCalls, 0, 'E5-eligible документов нет — инференс не вызывается')
})

test('getSemanticStatus — незапрошенный проект честно deferred, а не вечный warming', () => {
  const api = loadMapSemantic({
    store: { countDocs: () => ({ total: 5, indexed: 0 }) },
  })
  const st = api.getSemanticStatus('p1')
  assert.equal(st.state, 'deferred', 'векторов нет и прогрев не запрошен')
  assert.equal(st.mode, 'lexical', 'без модели — lexical-режим')
  assert.equal(st.indexedDocs, 0)

  const done = loadMapSemantic({ store: { countDocs: () => ({ total: 5, indexed: 5 }) } })
  assert.equal(done.getSemanticStatus('p1').state, 'ready')
  const empty = loadMapSemantic({ store: { countDocs: () => ({ total: 0, indexed: 0 }) } })
  assert.equal(empty.getSemanticStatus('p1').state, 'off')
})
