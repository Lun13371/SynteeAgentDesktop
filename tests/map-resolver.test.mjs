/**
 * mapResolver — lookup-ключи неразрешённых ссылок и их эмиссия при резолвинге.
 *
 * Покрывается:
 *  - importLookupKey: относительный/пакетный/индексный/пунктирный спецификатор,
 *    снятие расширения, устойчивость к мусору (пустая строка, кавычки, слэш);
 *  - fileLookupKeys: имя файла-цели (в т.ч. index/__init__ → имя каталога);
 *  - resolveFileImports: разрешённый импорт даёт ребро и НЕ даёт следа,
 *    неразрешённый — наоборот, дубли ключей в файле схлопываются;
 *  - resolveFileCalls: «голый» вызов без определения даёт след, вызов с
 *    receiver (чужой метод) — нет (иначе след раздувается без пользы).
 *
 * mapResolver транспилируется на лету (паттерн map-store.test.mjs);
 * `../db/handle` подменяется заглушкой — id-хелперы mapStore к БД не ходят.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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

const mapStoreShim = transpile('src/core/projectMap/mapStore.ts', {
  '../db/handle': { getDB: () => { throw new Error('mapResolver не должен ходить в БД') } },
})

const resolver = transpile('src/core/projectMap/mapResolver.ts', {
  '../db/handle': { getDB: () => { throw new Error('mapResolver не должен ходить в БД') } },
  './mapStore': mapStoreShim,
})

function makeIndex(projectId, files) {
  const index = new resolver.ProjectIndex(projectId, '/repo')
  for (const f of files) index.files.add(f)
  return index
}

// ─── Lookup-ключи ────────────────────────────────────────────────────────────

test('importLookupKey: последний сегмент без расширения, index → имя каталога', () => {
  const key = (s) => resolver.importLookupKey(s)
  assert.equal(key('./missing'), 'missing')
  assert.equal(key('../lib/queue.ts'), 'queue')
  assert.equal(key('src/core/store'), 'store')
  assert.equal(key('@/core/helper'), 'helper')
  assert.equal(key('react'), 'react')
  assert.equal(key('@scope/pkg/sub'), 'sub')
  // импорт «./lib» целится в lib/index.ts — ключом должен быть «lib»
  assert.equal(key('./lib/index.ts'), 'lib')
  assert.equal(key('./lib/'), 'lib')
  assert.equal(key('package:app/foo.dart'), 'foo')
  assert.equal(key('app.services.queue'), 'queue')
  assert.equal(key('  "./spaced.js"  '), 'spaced')
  assert.equal(key('   '), null)
})

test('fileLookupKeys: чем файл может закрыть чужой неразрешённый импорт', () => {
  assert.deepEqual(resolver.fileLookupKeys('src/core/queue.ts'), ['queue'])
  assert.deepEqual(resolver.fileLookupKeys('src/core/queue.d.ts'), ['queue'])
  assert.deepEqual(resolver.fileLookupKeys('src/core/queue/index.ts'), ['index', 'queue'])
  assert.deepEqual(resolver.fileLookupKeys('pkg/__init__.py'), ['__init__', 'pkg'])
  assert.deepEqual(resolver.fileLookupKeys(''), [])
})

// ─── Эмиссия неразрешённых импортов ─────────────────────────────────────────

test('resolveFileImports: разрешённый импорт — ребро, неразрешённый — след без ребра', () => {
  const index = makeIndex('p1', ['src/a.ts', 'src/present.ts'])
  const res = resolver.resolveFileImports(index, 'src/a.ts', [
    { source: './present', names: ['x'], line: 1 },
    { source: './missing', names: ['y'], line: 2 },
    { source: 'react', names: [], line: 3 },
  ], 'typescript')

  assert.equal(res.edges.length, 2, 'импорт на файл + внешний пакет')
  assert.deepEqual(res.packages, ['react'])
  assert.deepEqual(res.unresolved, [{ kind: 'import', key: 'missing', ref: './missing', line: 2 }])
})

test('resolveFileImports: дубли ключа схлопываются (след ограничен по размеру)', () => {
  const index = makeIndex('p1', ['src/a.ts'])
  const res = resolver.resolveFileImports(index, 'src/a.ts', [
    { source: './missing', names: [], line: 1 },
    { source: './missing.ts', names: [], line: 9 },
    { source: '../missing', names: [], line: 20 },
  ], 'typescript')

  assert.equal(res.unresolved.length, 1, 'три ссылки на одну цель — одна строка следа')
  assert.equal(res.unresolved[0].line, 1)
})

test('resolveFileImports: после появления цели след пуст — ребро разрешается', () => {
  const imports = [{ source: './missing', names: ['y'], line: 2 }]
  const before = resolver.resolveFileImports(makeIndex('p1', ['src/a.ts']), 'src/a.ts', imports, 'typescript')
  assert.equal(before.edges.length, 0)
  assert.equal(before.unresolved.length, 1)

  const after = resolver.resolveFileImports(makeIndex('p1', ['src/a.ts', 'src/missing.ts']), 'src/a.ts', imports, 'typescript')
  assert.equal(after.edges.length, 1)
  assert.equal(after.edges[0].toNode, 'src/missing.ts')
  assert.equal(after.unresolved.length, 0, 'цель найдена — восстанавливать нечего')
})

// ─── Эмиссия неразрешённых вызовов ──────────────────────────────────────────

test('resolveFileCalls: голый неразрешённый вызов — след; метод с receiver — нет', () => {
  const index = makeIndex('p1', ['src/a.ts'])
  index.addFileNodes('src/a.ts', [{
    id: 'src/a.ts#run', projectId: 'p1', filePath: 'src/a.ts', name: 'run', kind: 'function',
    parentName: null, lineStart: 1, lineEnd: 9, signature: '', exported: false, doc: null,
  }])

  const res = resolver.resolveFileCalls(index, 'src/a.ts', [
    { name: 'parseConfig', line: 3 },
    { name: 'parseConfig', line: 5 },
    { name: 'load', receiver: 'Store', line: 6 },
    { name: 'console', line: 7 },
    { name: 'run', line: 8 },
  ], [], 'typescript')

  assert.deepEqual(
    res.unresolved,
    [{ kind: 'call', key: 'parseconfig', ref: 'parseConfig', line: 3 }],
    'только голый вызов без определения, по одному ключу на файл',
  )
  // локальный вызов разрешён — ребро на определение
  assert.equal(res.edges.length, 1)
  assert.equal(res.edges[0].toNode, 'src/a.ts#run')
})
