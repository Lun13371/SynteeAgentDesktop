/**
 * mapStore — новые выборки/записи для инкрементального mapBuilder на РЕАЛЬНОМ
 * SQLite (better-sqlite3 in-memory + настоящая схема code_map_*).
 *
 * Покрывается:
 *  - getDependentFilePaths: входящие imports/calls/references на файловый узел
 *    и на символы файла, distinct, без самого файла, без чужих типов рёбер;
 *  - replaceFileEdges: атомарная замена ТОЛЬКО рёбер файла (узлы и рёбра
 *    других файлов не трогаются), откат при ошибке вставки;
 *  - getFile: одна строка по PK (project_id, path), индекс в плане запроса;
 *  - план запроса getDependentFilePaths не содержит full scan'а по edges/nodes.
 *
 * mapStore и схема транспилируются на лету (паттерн map-builder.test.mjs),
 * зависимость `../db/handle` подменяется на in-memory БД.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nodeRequire = createRequire(import.meta.url)

function transpile(relPath, requireShim = {}) {
  const source = fs.readFileSync(path.join(root, relPath), 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  const requireShimFn = (spec) => (requireShim[spec] ? requireShim[spec] : nodeRequire(spec))
  new Function('exports', 'require', 'module', js)(module.exports, requireShimFn, module)
  return module.exports
}

const P = 'p1'

/** Свежая in-memory БД со схемой карты + загруженный mapStore поверх неё. */
function setup() {
  const Database = nodeRequire('better-sqlite3')
  const db = new Database(':memory:')
  transpile('src/core/db/migrations/codeMap.ts').runCodeMapSchema(db)
  const store = transpile('src/core/projectMap/mapStore.ts', { '../db/handle': { getDB: () => db } })
  return { db, store }
}

function insertNode(db, id, filePath, name, kind = 'function') {
  db.prepare(
    `INSERT OR REPLACE INTO code_map_nodes (id, project_id, file_path, name, kind, parent_name, line_start, line_end, signature, exported)
     VALUES (?, ?, ?, ?, ?, NULL, 1, 2, '', 0)`
  ).run(id, P, filePath, name, kind)
}

function insertEdge(db, { from, to, type = 'imports', filePath, line = 1, precision = 'resolved' }) {
  const id = `${from}|${type}|${to}|${line}`
  db.prepare(
    `INSERT OR REPLACE INTO code_map_edges (id, project_id, from_node, to_node, type, precision, file_path, line)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, P, from, to, type, precision, filePath, line)
  return id
}

function mkEdge({ from, to, type = 'calls', filePath, line = 1, precision = 'resolved' }) {
  return {
    id: `${from}|${type}|${to}|${line}`,
    projectId: P,
    fromNode: from,
    toNode: to,
    type,
    precision,
    filePath,
    line,
  }
}

const edgeRows = (db) => db.prepare(
  `SELECT id, from_node, to_node, type, file_path FROM code_map_edges WHERE project_id = ? ORDER BY id`
).all(P)

// ─── getDependentFilePaths ───────────────────────────────────────────────────

test('getDependentFilePaths: imports/calls/references на файл и его символы, distinct, без себя', () => {
  const { db, store } = setup()
  // файловые узлы + один символ b.ts
  for (const p of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']) insertNode(db, p, p, p, 'file')
  insertNode(db, 'b.ts#foo', 'b.ts', 'foo')

  insertEdge(db, { from: 'a.ts', to: 'b.ts', type: 'imports', filePath: 'a.ts' })
  insertEdge(db, { from: 'c.ts', to: 'b.ts#foo', type: 'calls', filePath: 'c.ts' })
  insertEdge(db, { from: 'd.ts', to: 'b.ts#foo', type: 'references', filePath: 'd.ts' })
  // второй источник на тот же файл — не должен задвоить a.ts
  insertEdge(db, { from: 'a.ts', to: 'b.ts#foo', type: 'calls', filePath: 'a.ts', line: 7 })
  // «contains» — не зависимость
  insertEdge(db, { from: 'e.ts', to: 'e.ts#bar', type: 'contains', filePath: 'e.ts' })
  // self-импорт исключается
  insertEdge(db, { from: 'b.ts', to: 'b.ts', type: 'imports', filePath: 'b.ts' })
  // внешний пакет — не файл
  insertEdge(db, { from: 'e.ts', to: 'pkg:react', type: 'imports', filePath: 'e.ts', precision: 'external' })

  assert.deepEqual(store.getDependentFilePaths(P, 'b.ts').sort(), ['a.ts', 'c.ts', 'd.ts'])
  assert.deepEqual(store.getDependentFilePaths(P, 'zzz.ts'), [])
})

test('getDependentFilePaths: файловый узел находится даже без строки в code_map_nodes', () => {
  const { db, store } = setup()
  insertNode(db, 'a.ts', 'a.ts', 'a.ts', 'file')
  insertEdge(db, { from: 'a.ts', to: 'ghost.ts', type: 'imports', filePath: 'a.ts' })
  assert.deepEqual(store.getDependentFilePaths(P, 'ghost.ts'), ['a.ts'])
})

test('getDependentFilePaths: изоляция проектов и пустых file_path', () => {
  const { db, store } = setup()
  insertNode(db, 'a.ts', 'a.ts', 'a.ts', 'file')
  insertNode(db, 'b.ts', 'b.ts', 'b.ts', 'file')
  insertEdge(db, { from: 'a.ts', to: 'b.ts', type: 'imports', filePath: 'a.ts' })
  db.prepare(
    `INSERT INTO code_map_edges (id, project_id, from_node, to_node, type, precision, file_path, line)
     VALUES ('x', 'other', 'z.ts', 'b.ts', 'imports', 'resolved', 'z.ts', 1)`
  ).run()
  // ребро без файла-источника (пакетные/служебные) не превращается в ''
  db.prepare(
    `INSERT INTO code_map_edges (id, project_id, from_node, to_node, type, precision, file_path, line)
     VALUES ('y', ?, 'pkg:react', 'b.ts', 'imports', 'external', '', 1)`
  ).run(P)

  assert.deepEqual(store.getDependentFilePaths(P, 'b.ts'), ['a.ts'])
})

// ─── replaceFileEdges ───────────────────────────────────────────────────────

test('replaceFileEdges: меняет только рёбра указанного файла, узлы не трогает', () => {
  const { db, store } = setup()
  insertNode(db, 'a.ts', 'a.ts', 'a.ts', 'file')
  insertNode(db, 'b.ts', 'b.ts', 'b.ts', 'file')
  insertEdge(db, { from: 'a.ts', to: 'b.ts', type: 'imports', filePath: 'a.ts' })
  insertEdge(db, { from: 'b.ts', to: 'a.ts', type: 'imports', filePath: 'b.ts' })
  const keptB = edgeRows(db).find(r => r.file_path === 'b.ts')

  store.replaceFileEdges(P, 'a.ts', [
    mkEdge({ from: 'a.ts', to: 'b.ts#bar', type: 'calls', filePath: 'a.ts', line: 5 }),
  ])

  const rows = edgeRows(db)
  assert.deepEqual(rows.map(r => r.file_path), ['a.ts', 'b.ts'])
  assert.equal(rows.filter(r => r.file_path === 'a.ts').length, 1)
  assert.equal(rows.find(r => r.file_path === 'a.ts').to_node, 'b.ts#bar')
  assert.deepEqual(rows.find(r => r.file_path === 'b.ts'), keptB)
  assert.equal(
    db.prepare(`SELECT COUNT(*) c FROM code_map_nodes WHERE project_id = ?`).get(P).c,
    2,
  )
})

test('replaceFileEdges: ошибка вставки откатывает замену целиком', () => {
  const { db, store } = setup()
  insertNode(db, 'a.ts', 'a.ts', 'a.ts', 'file')
  insertEdge(db, { from: 'a.ts', to: 'b.ts', type: 'imports', filePath: 'a.ts', line: 1 })
  const before = edgeRows(db)

  const bad = mkEdge({ from: 'a.ts', to: 'c.ts', type: 'calls', filePath: 'a.ts', line: 2 })
  bad.type = null // NOT NULL constraint → бросает внутри транзакции

  assert.throws(() => store.replaceFileEdges(P, 'a.ts', [
    mkEdge({ from: 'a.ts', to: 'd.ts', type: 'calls', filePath: 'a.ts', line: 3 }),
    bad,
  ]))
  assert.deepEqual(edgeRows(db), before, 'старые рёбра должны остаться после отката')
})

// ─── getFile ────────────────────────────────────────────────────────────────

test('getFile: одна строка по PK, отсутствующий файл — null', () => {
  const { store } = setup()
  const file = {
    projectId: P, path: 'src/a.ts', language: 'typescript', hash: 'h1',
    mtime: 111, size: 222, parser: 'treesitter', truncated: false, indexedAt: 333,
  }
  store.replaceFile(P, file, [], [])

  assert.deepEqual(store.getFile(P, 'src/a.ts'), file)
  assert.equal(store.getFile(P, 'src/none.ts'), null)
  assert.equal(store.getFile('other', 'src/a.ts'), null)
})

// ─── Тег модели / backfill ──────────────────────────────────────────────────

test('upsertDocs: вектор с NULL-тегом не переносится — строка возвращается в очередь', () => {
  const { db, store } = setup()
  const doc = { nodeId: 'src/a.ts#f', filePath: 'src/a.ts', kind: 'function', tier: 1, text: 'v1', textHash: 'h1' }
  store.upsertDocs(P, [doc])
  // Легаси-строка: вектор есть, тег модели не проставлен.
  db.prepare(
    `UPDATE code_map_docs SET embedding = ?, embed_hash = text_hash, model = NULL, embedded_at = 1
     WHERE project_id = ? AND node_id = ?`
  ).run(Buffer.from([1, 2, 3]), P, doc.nodeId)

  // Переразбор без изменения текста: вектор с чужим/пустым тегом не переносим.
  store.upsertDocs(P, [doc])
  const row = db.prepare(
    `SELECT embedding, embed_hash, model FROM code_map_docs WHERE project_id = ? AND node_id = ?`
  ).get(P, doc.nodeId)
  assert.equal(row.embedding, null)
  assert.equal(row.embed_hash, null)
  assert.equal(row.model, null)

  // И строка снова в очереди worker'а (иначе вектор был бы невидим навсегда).
  assert.deepEqual(store.listPendingDocs(P, 10).map(d => d.nodeId), [doc.nodeId])
  assert.equal(store.countDocs(P).indexed, 0)

  // С актуальным тегом вектор переносится как раньше.
  store.saveDocEmbeddings(P, [{ nodeId: doc.nodeId, textHash: 'h1', embedding: Buffer.from([9]), model: 'e5', embeddedAt: 2 }])
  store.upsertDocs(P, [doc])
  const kept = db.prepare(
    `SELECT embed_hash, model FROM code_map_docs WHERE project_id = ? AND node_id = ?`
  ).get(P, doc.nodeId)
  assert.equal(kept.embed_hash, 'h1')
  assert.equal(kept.model, 'e5')
  assert.equal(store.countDocs(P).indexed, 1)
})

// ─── Планы запросов (никаких full scan на горячем пути) ─────────────────────
test('query plans: getDependentFilePaths и getFile используют индексы', () => {
  const { db } = setup()
  const depPlan = db.prepare(
    `EXPLAIN QUERY PLAN
     SELECT DISTINCT e.file_path AS path
     FROM code_map_edges e
     WHERE e.project_id = ?
       AND e.type IN ('imports','calls','references')
       AND e.file_path != ?
       AND e.file_path != ''
       AND (e.to_node = ? OR e.to_node IN (
         SELECT n.id FROM code_map_nodes n WHERE n.project_id = ? AND n.file_path = ?
       ))`
  ).all(P, 'b.ts', 'b.ts', P, 'b.ts').map(r => r.detail).join(' | ')
  assert.match(depPlan, /USING (COVERING )?INDEX idx_cme_project_(to|from|type|file)/)
  assert.doesNotMatch(depPlan, /SCAN code_map_edges/)
  assert.doesNotMatch(depPlan, /SCAN code_map_nodes/)

  const filePlan = db.prepare(
    `EXPLAIN QUERY PLAN SELECT * FROM code_map_files WHERE project_id = ? AND path = ?`
  ).all(P, 'src/a.ts').map(r => r.detail).join(' | ')
  assert.match(filePlan, /USING (COVERING )?INDEX/)
  assert.doesNotMatch(filePlan, /SCAN code_map_files/)
})
