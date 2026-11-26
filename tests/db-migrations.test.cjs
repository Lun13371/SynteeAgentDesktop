const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const Database = require('better-sqlite3')

const previousLoader = Module._extensions['.ts']
Module._extensions['.ts'] = (module, filename) => {
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  })
  module._compile(result.outputText, filename)
}
const { runMigrations, runInitialSchema } = require('../src/core/db/migrations/index.ts')
if (previousLoader) Module._extensions['.ts'] = previousLoader
else delete Module._extensions['.ts']

test('fresh database migrates and reopens with attachment columns', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    runMigrations(db)
    const columns = db.prepare('PRAGMA table_info(messages)').all().map(column => column.name)
    for (const name of ['attachments', 'attachment_result', 'thinking_blocks', 'hidden_from_context', 'reply_to']) {
      assert.ok(columns.includes(name), name)
    }
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
  } finally {
    db.close()
  }
})

test('legacy attachment cleanup preserves the only copy and runs after schema changes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'syntee-migrations-'))
  const db = new Database(':memory:')
  try {
    const storedFile = path.join(directory, 'stored.png')
    const missingFile = path.join(directory, 'missing.png')
    fs.writeFileSync(storedFile, 'image fixture')
    runInitialSchema(db)
    db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT')
    db.prepare('INSERT INTO chats (id, created_at, updated_at) VALUES (?, ?, ?)').run('chat', 1, 1)
    const attachments = [
      { path: storedFile, dataUrl: 'data:image/png;base64,YQ==' },
      { path: missingFile, dataUrl: 'data:image/png;base64,Yg==' }
    ]
    db.prepare('INSERT INTO messages (id, chat_id, role, content, created_at, attachments) VALUES (?, ?, ?, ?, ?, ?)')
      .run('message', 'chat', 'user', 'retained message', 2, JSON.stringify(attachments))
    runMigrations(db)
    runMigrations(db)
    const row = db.prepare('SELECT content, attachments FROM messages WHERE id = ?').get('message')
    assert.equal(row.content, 'retained message')
    const saved = JSON.parse(row.attachments)
    assert.equal(saved[0].dataUrl, undefined)
    assert.equal(saved[1].dataUrl, attachments[1].dataUrl)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 1)
  } finally {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
