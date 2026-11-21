/**
 * Файловый инвентарь для карты проекта (fileIndexer): безопасный первичный
 * скан, отсутствие потери watcher-событий во время скана, честный статус
 * полноты (truncated/complete/authoritative) и завершение по событию, а не
 * polling.
 *
 * Транспиляция на лету — тот же паттерн, что в map-analytics.test.mjs.
 * Каталоги — реальные (os.tmpdir), но вне git-репозитория, поэтому работает
 * эвристический путь (.gitignore + IGNORED_DIRS), а не `git ls-files`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
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

const mentions = transpile('src/shared/mentions.ts')
const indexer = transpile('src/core/mentions/fileIndexer.ts', { '../../shared/mentions': mentions })

const delay = (ms) => new Promise(r => globalThis.setTimeout(r, ms))

function makeWorkdir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-inventory-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return dir
}

function relPaths(dir) {
  return indexer.getAllFiles(dir).map(f => f.relPath).sort()
}

async function waitFor(check, timeoutMs = 3000, message = 'условие не наступило') {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (check()) return true
    await delay(25)
  }
  throw new assert.AssertionError({ message })
}

const realFs = nodeRequire('fs')
const realFsp = nodeRequire('fs/promises')

/**
 * Второй экземпляр индексатора с управляемым ФС-слоем: watcher-события можно
 * не форвардить (слепой watcher) и ронять stat конкретного файла (EPERM/EBUSY).
 * Нужен, чтобы воспроизводить потерю событий, которую на реальном fs.watch
 * не вызвать.
 */
function makeControlledIndexer() {
  const controls = { forward: true, failStat: new Map(), handlers: [] }
  const fsShim = {
    ...realFs,
    watch: (dir, opts, cb) => {
      controls.handlers.push(cb)
      return realFs.watch(dir, opts, (event, filename) => {
        if (!controls.forward) return
        cb(event, filename)
      })
    },
  }
  const fspShim = {
    ...realFsp,
    stat: async (p, ...rest) => {
      const code = controls.failStat.get(String(p))
      if (code) throw Object.assign(new Error(`${code}: simulated failure`), { code })
      return realFsp.stat(p, ...rest)
    },
  }
  const idx = transpile('src/core/mentions/fileIndexer.ts', {
    '../../shared/mentions': mentions,
    fs: fsShim,
    'fs/promises': fspShim,
  })
  return { idx, controls }
}

// ─── Полный инвентарь ────────────────────────────────────────────────────────

test('scan: полный инвентарь помечен complete + authoritative, игнор соблюдается', async () => {
  const dir = makeWorkdir({
    'a.ts': 'export const a = 1\n',
    'src/b.ts': 'export const b = 2\n',
    'docs/readme.md': '# hi\n',
    'node_modules/junk/index.js': 'x\n',
    '.hidden/secret.ts': 'x\n',
  })
  try {
    const status = await (async () => {
      const p = indexer.startIndexing(dir)
      const w = indexer.whenInventoryReady(dir, 10_000)
      await p
      return w
    })()

    assert.ok(status, 'whenInventoryReady должен вернуть статус, а не null')
    assert.equal(status.ready, true)
    assert.equal(status.complete, true, 'скан без усечения → complete')
    assert.equal(status.truncated, false)
    assert.equal(status.scanErrors, 0)
    assert.equal(status.watcherActive, true, 'watcher ставится до скана и должен быть жив')
    assert.equal(status.authoritative, true)
    assert.equal(status.stale, false)
    assert.equal(indexer.isInventoryAuthoritative(dir), true)
    assert.deepEqual(relPaths(dir), ['a.ts', 'docs/readme.md', 'src/b.ts'])
  } finally {
    await indexer.stopIndexing(dir)
  }
})

// ─── Усечение лимитами не выдаётся за полный инвентарь ───────────────────────

test('scan: срабатывание maxFiles → truncated, complete=false, authoritative=false', async () => {
  const dir = makeWorkdir({
    'a.ts': 'a\n', 'b.ts': 'b\n', 'c.ts': 'c\n',
  })
  try {
    await indexer.startIndexing(dir, { maxFiles: 2 })
    const status = indexer.getInventoryStatus(dir)
    assert.ok(status)
    assert.equal(status.ready, true)
    assert.equal(status.truncated, true, 'усечение лимитом обязано быть видимым')
    assert.equal(status.complete, false)
    assert.equal(status.authoritative, false, 'неполный инвентарь не авторитетен')
    assert.equal(status.files, 2)
    assert.equal(indexer.getAllFiles(dir).length, 2)
  } finally {
    await indexer.stopIndexing(dir)
  }
})

// ─── Изменения во время скана не теряются ────────────────────────────────────

test('scan: файл, созданный во время скана, попадает в инвентарь', async () => {
  const dir = makeWorkdir({ 'a.ts': 'a\n' })
  try {
    const started = indexer.startIndexing(dir)
    // Синхронно, пока скан в полёте: старый код ставил watcher ПОСЛЕ скана,
    // поэтому такой файл не попадал ни в скан, ни в события — терялся навсегда.
    fs.writeFileSync(path.join(dir, 'late.ts'), 'late\n')
    await started
    await delay(400) // на случай, если событие пришло уже после flush
    assert.ok(relPaths(dir).includes('late.ts'), 'файл, созданный во время скана, потерян')
  } finally {
    await indexer.stopIndexing(dir)
  }
})

// ─── Конкурентный старт: один скан, а не два ─────────────────────────────────

test('startIndexing: конкурентные вызовы делят один скан и один watcher', async () => {
  const dir = makeWorkdir({ 'a.ts': 'a\n', 'b.ts': 'b\n' })
  try {
    const first = indexer.startIndexing(dir)
    const second = indexer.startIndexing(dir)
    // Второй вызов не должен отдавать управление до конца скана.
    await second
    assert.equal(indexer.isIndexReady(dir), true, 'второй startIndexing вернулся до готовности')
    await first
    assert.deepEqual(relPaths(dir), ['a.ts', 'b.ts'])
    assert.equal(indexer.getInventoryStatus(dir).files, 2)
  } finally {
    await indexer.stopIndexing(dir)
  }
})

// ─── Завершение по событию, без polling ──────────────────────────────────────

test('whenInventoryReady/onInventoryComplete: событие, таймаут и обратная совместимость', async () => {
  const dir = makeWorkdir({ 'a.ts': 'a\n' })
  const idle = path.join(os.tmpdir(), 'file-inventory-never-started-' + globalThis.process.pid)
  try {
    // Индексация не запускалась — ждём ограниченно и получаем null.
    const none = await indexer.whenInventoryReady(idle, 120)
    assert.equal(none, null)
    // Старый API сохраняет семантику boolean.
    assert.equal(await indexer.waitForIndexReady(idle, 120), false)

    let calls = 0
    let seen = null
    const unsub = indexer.onInventoryComplete(dir, (status) => { calls++; seen = status })
    const p = indexer.startIndexing(dir)
    await p
    const status = await indexer.whenInventoryReady(dir, 10_000)
    assert.equal(status.ready, true)
    assert.equal(await indexer.waitForIndexReady(dir, 10_000), true)
    await delay(20)
    assert.equal(calls, 1, 'колбэк завершения должен сработать ровно один раз')
    assert.equal(seen.ready, true)
    unsub()

    // Остановка во время скана: ждущие получают null, а не висят до таймаута.
    const other = makeWorkdir({ 'x.ts': 'x\n' })
    const waiting = indexer.whenInventoryReady(other, 10_000)
    const running = indexer.startIndexing(other)
    await indexer.stopIndexing(other)
    assert.equal(await waiting, null)
    await running
    assert.equal(indexer.isIndexReady(other), false)
    fs.rmSync(other, { recursive: true, force: true })
  } finally {
    await indexer.stopIndexing(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ─── Мутация: неудавшийся stat не удаляет индексированный файл ───────────────

test('mutation: stat EPERM не удаляет запись и не выдаёт снимок за авторитетный', async () => {
  const dir = makeWorkdir({ 'a.ts': 'a\n', 'b.ts': 'b\n' })
  const fullA = dir + path.sep + 'a.ts'
  const { idx, controls } = makeControlledIndexer()
  const files = () => idx.getAllFiles(dir).map(f => f.relPath).sort()
  try {
    await idx.startIndexing(dir)
    assert.equal(idx.isInventoryAuthoritative(dir), true)

    // Файл занят другим процессом (Windows: антивирус/индексатор) — stat падает.
    controls.failStat.set(fullA, 'EPERM')
    fs.writeFileSync(fullA, 'a changed\n')
    await waitFor(() => idx.getInventoryStatus(dir).stale === true, 3000, 'изменение не дошло до индексатора')
    assert.ok(files().includes('a.ts'), 'запись удалена по неудавшемуся stat — файл потерян навсегда')
    assert.equal(idx.isInventoryAuthoritative(dir), false, 'непроверенный снимок не должен быть авторитетным')
    // Сырые поля статуса fail-closed: карта проекта выводит авторитетность
    // из ready/complete/watcherActive, поэтому stale обязан гасить complete.
    assert.equal(idx.getInventoryStatus(dir).complete, false, 'stale-снимок выдан за полный')

    // Сверка тоже не смогла прочитать файл — запись обязана сохраниться,
    // а неполный обход — не выдаваться за полный.
    await waitFor(() => idx.getInventoryStatus(dir).stale === false, 4000, 'сверка не запустилась')
    assert.ok(files().includes('a.ts'), 'сверка выкинула файл из-за неудавшегося stat')
    assert.equal(idx.getInventoryStatus(dir).complete, false, 'неполный обход выдан за полный')

    // Файл снова читается: сверка возвращает авторитетность.
    controls.failStat.delete(fullA)
    idx.requestInventoryRescan(dir)
    await waitFor(() => idx.isInventoryAuthoritative(dir) === true, 4000, 'сверка не восстановила авторитетный снимок')
    assert.deepEqual(files(), ['a.ts', 'b.ts'])
  } finally {
    await idx.stopIndexing(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ─── Мутация: потерянное событие (filename=null) закрывается сверкой ─────────

test('mutation: событие без пути (filename=null) не игнорируется, а вызывает сверку', async () => {
  const dir = makeWorkdir({ 'a.ts': 'a\n', 'keep.ts': 'k\n' })
  const { idx, controls } = makeControlledIndexer()
  const files = () => idx.getAllFiles(dir).map(f => f.relPath).sort()
  try {
    controls.forward = false // watcher «слепой»: события до индексатора не доходят
    await idx.startIndexing(dir)
    assert.equal(idx.isInventoryAuthoritative(dir), true)
    assert.equal(controls.handlers.length, 1)

    fs.rmSync(dir + path.sep + 'a.ts')
    assert.ok(files().includes('a.ts'))

    // ReadDirectoryChangesW отдал событие без пути. Раньше такое молча
    // пропускалось, и удаление навсегда оставалось в «авторитетном» снимке.
    controls.handlers[0]('change', null)
    assert.equal(idx.getInventoryStatus(dir).stale, true, 'потеря события не помечена')
    assert.equal(idx.isInventoryAuthoritative(dir), false)

    await waitFor(() => idx.isInventoryAuthoritative(dir) === true, 4000, 'сверка после потерянного события не прошла')
    assert.deepEqual(files(), ['keep.ts'], 'удалённый файл остался в авторитетном снимке')
  } finally {
    await idx.stopIndexing(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ─── Мутация: событие по каталогу убирает запись и уведомляет потребителя ────

test('mutation: событие по каталогу убирает файл из инвентаря и эмитит изменение', async () => {
  const dir = makeWorkdir({ 'x.ts': 'x\n', 'y.ts': 'y\n' })
  const { idx, controls } = makeControlledIndexer()
  const files = () => idx.getAllFiles(dir).map(f => f.relPath).sort()
  const seen = []
  let unsub = () => {}
  try {
    controls.forward = false
    await idx.startIndexing(dir)
    unsub = idx.subscribeFileChanges(dir, (rel) => seen.push(...rel))

    // Файл заменён каталогом с тем же именем.
    fs.rmSync(dir + path.sep + 'x.ts')
    fs.mkdirSync(dir + path.sep + 'x.ts')
    controls.handlers[0]('change', 'x.ts')

    await waitFor(() => !files().includes('x.ts'), 3000, 'каталог остался в инвентаре файлов')
    assert.ok(seen.includes('x.ts'), 'потребитель не уведомлён — узел файла остался бы в графе')
    assert.deepEqual(files(), ['y.ts'])
  } finally {
    unsub()
    await idx.stopIndexing(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
