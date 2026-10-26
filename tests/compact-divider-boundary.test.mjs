/**
 * Ручной /compact: divider обязан стоять на границе middle|tail.
 *
 * getMessagesAfterLatestCompact возвращает сообщения с created_at >
 * divider.created_at. Если divider поставить на Date.now() (как было до фикса),
 * из live-контекста выпадает tail, который applyRollingWindowAsync сохранил
 * (/compact last → 1 сообщение, /compact full → rollingKeepLast), причём в
 * summary он тоже не попадает — middle его исключает. Сообщения исчезают из
 * контекста модели молча.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const chatSource = fs.readFileSync(path.join(root, 'src/main/ipc/chat.ipc.ts'), 'utf8')

function loadCompactDividerCreatedAt() {
  const start = chatSource.indexOf('export function compactDividerCreatedAt(')
  assert.ok(start >= 0, 'compactDividerCreatedAt not found in chat.ipc.ts')
  const end = chatSource.indexOf('\n}', start) + 2
  assert.ok(end > start, 'unterminated compactDividerCreatedAt')
  const js = ts.transpileModule(chatSource.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(js, { module, exports: module.exports })
  return module.exports.compactDividerCreatedAt
}

/** Тот же отбор, что в getMessagesAfterLatestCompact (src/core/db/messages.ts). */
function liveAfterDivider(rows, dividerAt) {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE messages (id TEXT, created_at INTEGER)')
  const insert = db.prepare('INSERT INTO messages (id, created_at) VALUES (?, ?)')
  for (const r of rows) insert.run(r.id, r.createdAt)
  const live = db.prepare('SELECT id FROM messages WHERE created_at > ? ORDER BY created_at, id').all(dividerAt)
  db.close()
  return live.map(r => r.id)
}

const history = [
  { id: 'old-1', createdAt: 1000 },
  { id: 'old-2', createdAt: 2000 },
  { id: 'old-3', createdAt: 3000 },
  { id: 'tail-1', createdAt: 4000 },
  { id: 'tail-2', createdAt: 5000 },
]
const toChatMessages = (...ids) => ids.map(id => ({ role: 'assistant', content: id, messageId: id }))

test('/compact last keeps the single tail message in the live context', () => {
  const compute = loadCompactDividerCreatedAt()
  const dividerAt = compute(toChatMessages('tail-2'), history)
  assert.equal(dividerAt, 4999, 'divider must sit right before the first tail message')
  assert.deepEqual(liveAfterDivider(history, dividerAt), ['tail-2'])
})

test('/compact (full) keeps the whole rolling tail, not just the last message', () => {
  const compute = loadCompactDividerCreatedAt()
  const dividerAt = compute(toChatMessages('tail-1', 'tail-2'), history)
  assert.equal(dividerAt, 3999)
  assert.deepEqual(liveAfterDivider(history, dividerAt), ['tail-1', 'tail-2'])
})

test('empty tail summarizes everything — divider lands at the end of the feed', () => {
  const compute = loadCompactDividerCreatedAt()
  const dividerAt = compute([], history)
  assert.ok(dividerAt >= 5000, 'divider must not preserve anything when tail is empty')
  assert.deepEqual(liveAfterDivider(history, dividerAt), [])
})

test('regression: Date.now() divider silently drops the preserved tail', () => {
  // Старое поведение — divider в конце ленты. Именно из-за него терялись
  // последние сообщения: tail посчитан и отдан, но в контекст не попадал.
  assert.deepEqual(liveAfterDivider(history, Date.now()), [])
})

test('manual chat:compact handler places the divider through the boundary helper', () => {
  const start = chatSource.indexOf("ipcMain.handle('chat:compact'")
  assert.ok(start >= 0, 'chat:compact handler not found')
  const handler = chatSource.slice(start, chatSource.indexOf('ipcMain.handle(', start + 10))
  assert.match(handler, /createdAt: compactDividerCreatedAt\(result\.messages, liveMessages\)/)
  assert.doesNotMatch(handler, /createdAt: Date\.now\(\)/)
})
