// §rollback — тесты отката правок AI.
//
// Что фиксируем (каждый пункт — реальный баг, из-за которого «откат не работал»):
//  1. Файл, правленный НЕСКОЛЬКО раз за turn, восстанавливается в состояние ДО
//     первой правки, а не в случайное промежуточное (раньше порядок задавался
//     ORDER BY id DESC, где id = uuid v4).
//  2. Файл, созданный за turn (contentBefore = null), при откате удаляется.
//  3. Относительный и абсолютный путь одного файла — одна запись (не дважды).
//  4. Снапшоты, накопленные стримом (Stop/краш воркера), используются, если
//     финальный undoStack не пришёл.
//  5. Резолв пути снапшота против workdir чата (а не process.cwd()).
//  6. Проводка: Agent → worker → main → БД (source-инварианты, как в
//     tests/fastcontext-rust-only.test.cjs).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)

function load(path, mocks = {}, source = readFileSync(path, 'utf8')) {
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(
    id => (Object.hasOwn(mocks, id) ? mocks[id] : require(id)),
    module,
    module.exports,
  )
  return module.exports
}

const { firstSnapshotPerPath, pickSnapshots, snapshotPathKey } = load('src/core/db/snapshotMerge.ts')
const { resolveSnapshotPath } = load('src/core/db/snapshotPaths.ts')

const WORKDIR = process.platform === 'win32' ? 'C:\\Projects\\Demo' : '/projects/demo'
const FILE = process.platform === 'win32' ? 'C:\\Projects\\Demo\\src\\a.ts' : '/projects/demo/src/a.ts'
const REL = 'src/a.ts'

// ── 1. Несколько правок одного файла за turn ───────────────────────────────
// undoStack агента пишет запись на КАЖДУЮ правку. Строки приходят в порядке
// rowid ASC (порядок INSERT). Откат обязан взять ПЕРВУЮ — состояние до turn'а.
test('multi-edit: восстанавливается состояние ДО первой правки файла', () => {
  const rows = [
    { path: FILE, contentBefore: 'ORIGINAL' },
    { path: FILE, contentBefore: 'AFTER_EDIT_1' },
    { path: FILE, contentBefore: 'AFTER_EDIT_2' },
  ]
  const picked = firstSnapshotPerPath(rows, WORKDIR)
  assert.equal(picked.length, 1)
  assert.equal(picked[0].contentBefore, 'ORIGINAL')
})

test('multi-edit: порядок первого появления файлов сохраняется', () => {
  const b = process.platform === 'win32' ? 'C:\\Projects\\Demo\\src\\b.ts' : '/projects/demo/src/b.ts'
  const rows = [
    { path: FILE, contentBefore: 'a0' },
    { path: b, contentBefore: 'b0' },
    { path: FILE, contentBefore: 'a1' },
  ]
  assert.deepEqual(firstSnapshotPerPath(rows, WORKDIR).map(r => r.contentBefore), ['a0', 'b0'])
})

// ── 2. Файл создан за turn ─────────────────────────────────────────────────
test('created file: contentBefore=null остаётся null (откат удалит файл)', () => {
  const rows = [
    { path: FILE, contentBefore: null },
    { path: FILE, contentBefore: 'NEW CONTENT' },
  ]
  const picked = firstSnapshotPerPath(rows, WORKDIR)
  assert.equal(picked.length, 1)
  assert.equal(picked[0].contentBefore, null)
})

// ── 3. Относительный + абсолютный путь одного файла ────────────────────────
test('relative и absolute путь одного файла склеиваются в одну запись', () => {
  const rows = [
    { path: REL, contentBefore: 'ORIGINAL' },
    { path: FILE, contentBefore: 'AFTER' },
  ]
  const picked = firstSnapshotPerPath(rows, WORKDIR)
  assert.equal(picked.length, 1)
  assert.equal(picked[0].contentBefore, 'ORIGINAL')
  // В БД/лог отдаём ОРИГИНАЛЬНЫЙ путь первой строки.
  assert.equal(picked[0].path, REL)
})

test('Windows: пути сравниваются регистронезависимо', { skip: process.platform !== 'win32' }, () => {
  const rows = [
    { path: 'C:\\Projects\\Demo\\src\\A.ts', contentBefore: 'ORIGINAL' },
    { path: 'C:\\Projects\\Demo\\src\\a.ts', contentBefore: 'AFTER' },
  ]
  assert.equal(firstSnapshotPerPath(rows, WORKDIR).length, 1)
  assert.equal(snapshotPathKey('C:\\X\\A.TS', WORKDIR), snapshotPathKey('c:\\x\\a.ts', WORKDIR))
})

test('разные файлы не склеиваются', () => {
  const rows = [
    { path: REL, contentBefore: 'a' },
    { path: 'src/b.ts', contentBefore: 'b' },
  ]
  assert.equal(firstSnapshotPerPath(rows, WORKDIR).length, 2)
})

// ── 4. Стрим снапшотов (Stop / краш воркера) ───────────────────────────────
test('pickSnapshots: live-буфер авторитетнее локального undoStack (включая саб-агентов)', () => {
  const live = [{ path: FILE, contentBefore: 'ORIGINAL' }]
  const finalList = [
    { path: FILE, contentBefore: 'ORIGINAL' },
    { path: FILE, contentBefore: 'AFTER' },
  ]
  assert.equal(pickSnapshots(live, finalList), live)
})

test('pickSnapshots: при Stop/краше (finalList undefined) берётся стрим', () => {
  const live = [
    { path: FILE, contentBefore: 'ORIGINAL' },
    { path: 'src/b.ts', contentBefore: null },
  ]
  assert.deepEqual(pickSnapshots(live, undefined), live)
})

test('pickSnapshots: пустой финальный список не затирает стрим', () => {
  const live = [{ path: FILE, contentBefore: 'ORIGINAL' }]
  assert.deepEqual(pickSnapshots(live, []), live)
})

test('pickSnapshots: нет ни стрима, ни финала — пустой массив', () => {
  assert.deepEqual(pickSnapshots(undefined, undefined), [])
})

// ── 5. Резолв пути снапшота ────────────────────────────────────────────────
test('resolveSnapshotPath: относительный путь резолвится против workdir чата', () => {
  assert.equal(resolveSnapshotPath(REL, WORKDIR), FILE)
})

test('resolveSnapshotPath: абсолютный путь не меняется', () => {
  assert.equal(resolveSnapshotPath(FILE, WORKDIR), FILE)
})

test('resolveSnapshotPath: без workdir fallback на cwd, но не падает', () => {
  assert.equal(typeof resolveSnapshotPath(REL), 'string')
  assert.equal(resolveSnapshotPath(REL, undefined).endsWith('a.ts'), true)
})

// ── 6. Source-инварианты проводки ──────────────────────────────────────────
const src = {
  checkpoints: readFileSync('src/core/db/checkpoints.ts', 'utf8'),
  ipc: readFileSync('src/main/ipc/chatCheckpoint.ipc.ts', 'utf8'),
  chatIpc: readFileSync('src/main/ipc/chat.ipc.ts', 'utf8'),
  sessionPanel: readFileSync('src/renderer/src/components/ui/SessionChangesPanel/SessionChangesPanel.tsx', 'utf8'),
  agent: readFileSync('src/core/agent/Agent.ts', 'utf8'),
  agentTypes: readFileSync('src/core/agent/types.ts', 'utf8'),
  worker: readFileSync('src/main/workers/ai-worker.ts', 'utf8'),
  messages: readFileSync('src/core/db/messages.ts', 'utf8'),
  chatShared: readFileSync('src/main/ipc/chatShared.ts', 'utf8'),
  worktree: readFileSync('src/main/managers/WorktreeIsolation.ts', 'utf8'),
  agentManager: readFileSync('src/main/managers/AgentManager.ts', 'utf8'),
}

// Комментарии (// и /** */) упоминают старые баги («раньше был ORDER BY id
// DESC») — SQL проверяем по коду без комментариев.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const code = {
  checkpoints: stripComments(src.checkpoints),
  ipc: stripComments(src.ipc),
  messages: stripComments(src.messages),
}

test('SQL: снапшоты turn\'а читаются в порядке правок (rowid ASC), не по uuid', () => {
  assert.match(code.checkpoints, /WHERE chat_id = \? AND user_message_id = \?\s*\n\s*ORDER BY rowid ASC/)
  assert.doesNotMatch(code.checkpoints, /ORDER BY id DESC/)
})

test('SQL: ретрай turn\'а не оставляет снапшоты прошлого прогона', () => {
  assert.match(code.checkpoints, /DELETE FROM file_snapshots WHERE chat_id = \? AND user_message_id = \?/)
})

test('SQL: getSnapshotsAfter строится на getLaterTurnSnapshots (ASC + rowid)', () => {
  const fn = code.checkpoints.slice(code.checkpoints.indexOf('export function getSnapshotsAfter'))
  assert.match(fn.slice(0, 1200), /getLaterTurnSnapshots/)
  assert.match(code.checkpoints, /ORDER BY created_at ASC, rowid ASC/)
})

test('IPC: все undo-обработчики используют дедуп по пути и резолв workdir', () => {
  // Ни один обработчик не пишет по сырому snap.path — только через резолв.
  assert.doesNotMatch(code.ipc, /writeFileSync\(snap\.path/)
  assert.doesNotMatch(code.ipc, /unlinkSync\(snap\.path\)/)
  assert.doesNotMatch(code.ipc, /existsSync\(snap\.path\)/)
  // Все четыре обработчика (undoLastTurnFiles/undoFile/undoCheckpointFiles/
  // undoCheckpointFile) получают снапшоты через turnSnapshotsForUndo
  // (пятое вхождение — объявление самого хелпера).
  assert.equal((code.ipc.match(/= turnSnapshotsForUndo\(/g) ?? []).length, 4)
  assert.match(code.ipc, /firstSnapshotPerPath\(getSnapshotsForCheckpoint/)
})

test('IPC: rewind восстанавливает состояние на конец turn\'а (последующие turn\'ы)', () => {
  assert.match(code.ipc, /laterTurnSnapshotsForRewind\(chatId, userMessageId\)/)
  assert.match(code.ipc, /firstSnapshotPerPath\(getLaterTurnSnapshots/)
  assert.doesNotMatch(code.ipc, /getSnapshotsAfter\(/)
})

test('Agent: каждая правка файла отдаёт снапшот сразу (не только в onDone)', () => {
  assert.match(src.agentTypes, /onFileSnapshot\?: \(snapshot: \{ path: string; contentBefore: string \| null \}\) => void/)
  assert.match(src.agent, /this\.undoStack\.push\(\{ path: snapPath, originalContent: origContent \?\? null \}\)/)
  const idxPush = src.agent.indexOf('this.undoStack.push({ path: snapPath')
  const idxCall = src.agent.indexOf('callbacks.onFileSnapshot?.(snap)')
  assert.ok(idxCall > idxPush, 'onFileSnapshot должен вызываться после записи в undoStack')
})

test('worker: снапшоты стримятся в main отдельным сообщением', () => {
  assert.match(src.worker, /agent\.onFileSnapshot = \(snapshot\) => \{/)
  assert.match(src.worker, /type: 'file_snapshot', chatId, msgId, snapshot/)
})

test('main: file_snapshot копится в ActiveRun.liveSnapshots и попадает в sendDone', () => {
  assert.match(src.chatShared, /liveSnapshots: Array<\{ path: string; contentBefore: string \| null \}>/)
  assert.match(src.chatIpc, /case 'file_snapshot'/)
  assert.match(src.chatIpc, /run\.liveSnapshots\.push\(/)
  assert.match(src.chatIpc, /pickSnapshots\(run\.liveSnapshots, fileSnapshots\)/)
})

test('main: filesChanged считает файлы, а не правки (дедуп по пути)', () => {
  assert.match(src.chatIpc, /const filePaths = firstSnapshotPerPath\(snaps, chatWorkdir\)\.map\(s => s\.path\)/)
})

test('subagent: worktree merge возвращает состояния файлов до git apply', () => {
  assert.match(src.worktree, /fileSnapshots: MergeFileSnapshot\[\]/)
  assert.match(src.worktree, /readFileSync\(absolutePath, 'utf-8'\)/)
  assert.match(src.worktree, /return \{ ok: true, conflict: false, worktreeKept: false, fileSnapshots \}/)
  assert.match(src.agentManager, /onFileSnapshot\?\.\(mergeResult\.fileSnapshots\)/)
})

test('subagent: shared/worktree snapshots стримятся в родительский ActiveRun без tool history', () => {
  assert.match(src.agentManager, /case 'file_snapshot'/)
  assert.match(src.agentManager, /onFileSnapshot\?\.\(\[normalized\]\)/)
  assert.match(src.chatIpc, /onFileSnapshot: \(snapshots\) =>/)
  assert.match(src.chatIpc, /parentRun\.liveSnapshots\.push\(\.\.\.snapshots\)/)
  assert.doesNotMatch(src.agent, /delegatedSnapshots/)
  assert.doesNotMatch(src.worker, /spawnSnapshots/)
})

test('per-file undo: consumed ledger persists without modifying snapshots or checkpoint metadata', () => {
  assert.match(src.ipc, /INSERT OR IGNORE INTO per_file_undo_consumed/)
  assert.match(src.ipc, /consumePerFileUndo\(chatId, userMessageId, snap\.path\)/)
  assert.match(src.ipc, /for \(const path of restored\) consumePerFileUndo\(chatId, cp\.userMessageId, path\)/)
  assert.match(src.ipc, /SELECT path_key as pathKey FROM per_file_undo_consumed/)
  assert.doesNotMatch(src.ipc, /UPDATE chat_checkpoints SET files_changed/)
  assert.match(src.sessionPanel, /getConsumedPerFileUndoPaths/)
})

test('БД: удаление сообщения не оставляет осиротевшие снапшоты', () => {
  const fn = code.messages.slice(code.messages.indexOf('export function deleteMessageById'))
  assert.match(fn.slice(0, 2000), /DELETE FROM file_snapshots WHERE user_message_id = \?/)
  assert.match(fn.slice(0, 2000), /DELETE FROM context_snapshots WHERE user_message_id = \?/)
})
