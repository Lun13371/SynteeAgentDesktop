/**
 * /compact [full|last] [фокус...] — разбор аргументов и проброс фокуса
 * в промпт суммаризации.
 *
 * Фокус — свободный текст (как /compact <instructions> в Claude Code):
 * «что обязательно сохранить в резюме». Режим распознаётся только как
 * отдельный первый токен full|last, иначе весь текст считается фокусом.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function loadModule(rel) {
  const source = fs.readFileSync(path.join(root, rel), 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(js, { module, exports: module.exports })
  return module.exports
}

const shared = loadModule('src/shared/slashCommands.ts')
// Объекты из vm-контекста живут в чужом realm — сравниваем через spread,
// иначе deepStrictEqual ругается на разные прототипы.
const parse = (args) => ({ ...shared.parseCompactArgs(args) })

test('без аргументов — режим full без фокуса', () => {
  assert.deepEqual(parse(undefined), { mode: 'full', focus: '' })
  assert.deepEqual(parse(''), { mode: 'full', focus: '' })
  assert.deepEqual(parse('   '), { mode: 'full', focus: '' })
})

test('режим распознаётся как отдельный первый токен', () => {
  assert.deepEqual(parse('last'), { mode: 'last', focus: '' })
  assert.deepEqual(parse('full'), { mode: 'full', focus: '' })
  assert.deepEqual(parse('LAST'), { mode: 'last', focus: '' })
  assert.deepEqual(parse('  last  '), { mode: 'last', focus: '' })
})

test('фокус идёт после режима', () => {
  assert.deepEqual(parse('last сохрани решения по схеме БД'), {
    mode: 'last',
    focus: 'сохрани решения по схеме БД',
  })
  assert.deepEqual(parse('full ошибки и как починили'), {
    mode: 'full',
    focus: 'ошибки и как починили',
  })
})

test('без режима весь текст — фокус (как /compact <instructions> в Claude Code)', () => {
  assert.deepEqual(parse('сохрани миграции и схему БД'), {
    mode: 'full',
    focus: 'сохрани миграции и схему БД',
  })
})

test('опечатка в режиме не переключает режим молча — уходит в фокус', () => {
  assert.deepEqual(parse('lst'), { mode: 'full', focus: 'lst' })
  assert.deepEqual(parse('lastly сохрани'), { mode: 'full', focus: 'lastly сохрани' })
})

test('фокус обрезается до лимита', () => {
  const parsed = parse(`last ${'x'.repeat(900)}`)
  assert.equal(parsed.mode, 'last')
  assert.equal(parsed.focus.length, shared.COMPACT_FOCUS_MAX_CHARS)
})

test('/compact объявляет free-text аргумент focus после пикера режима', () => {
  const cmd = shared.SLASH_COMMANDS.find(c => c.name === 'compact')
  assert.ok(cmd, '/compact not found')
  assert.deepEqual(Array.from(cmd.arguments, a => a.name), ['mode', 'focus'])
  assert.deepEqual(Array.from(cmd.arguments[0].choices), ['full', 'last'])
  assert.equal(cmd.arguments[1].choices, undefined, 'focus must be free text, not an enum')
  assert.match(cmd.argumentHint, /фокус/i)
})

test('фокус доходит до промпта суммаризации', () => {
  const cm = fs.readFileSync(path.join(root, 'src/core/context/contextManager.ts'), 'utf8')
  assert.match(cm, /buildSummaryPrompt\(middleMessages, prevSummary, focus\)/)
  assert.match(cm, /USER FOCUS FOR THIS COMPACTION/)
  const chat = fs.readFileSync(path.join(root, 'src/main/ipc/chat.ipc.ts'), 'utf8')
  assert.match(
    chat,
    /applyRollingWindowAsync\(rawHistory, rollingSettings, summaryFn, storedSummary \|\| undefined, true, compactMode, focus \|\| undefined\)/,
    'manual /compact must pass the parsed focus through',
  )
})
