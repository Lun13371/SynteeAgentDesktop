/**
 * resolveSlashContext + getCommandArguments — контекст ввода slash-команды
 * для подсказок аргументов (пикер enum / free-text карточка).
 *
 * Ключевые контракты:
 *   - контекст выводится ИЗ ТЕКСТА: ручной набор `/compact last ` даёт те же
 *     подсказки, что выбор команды из меню (раньше пикер открывался только
 *     через selectCommand);
 *   - `/cmd` без пробела → hasArgsRegion=false: подсказки аргументов не
 *     показываем (там ещё видно слеш-меню, два меню на одном якоре конфликтуют);
 *   - команды без структурированных arguments, но с placeholder/argumentHint
 *     получают ОДИН синтезированный свободный аргумент — подсказки работают
 *     для всех команд;
 *   - endsWithSpace → prefix='' (текущий аргумент не начат), иначе prefix =
 *     последний токен; level = индекс вводимого аргумента.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function loadSlashCommands() {
  const source = fs.readFileSync(path.join(root, 'src/shared/slashCommands.ts'), 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(js, { module, exports: module.exports, require: () => ({}) })
  return module.exports
}

const {
  resolveSlashContext,
  getCommandArguments,
  filterCommands,
  parseSlashCommandWithCustom,
} = loadSlashCommands()

// ── resolveSlashContext: базовая детекция ───────────────────────────────────

test('не-команда и пустой ввод → null', () => {
  assert.equal(resolveSlashContext(''), null)
  assert.equal(resolveSlashContext('привет'), null)
  assert.equal(resolveSlashContext('обычный текст /goal внутри'), null)
})

test('несуществующая команда → null', () => {
  assert.equal(resolveSlashContext('/nope '), null)
  assert.equal(resolveSlashContext('/nope args'), null)
})

test('частичное имя (меню ещё открыто) → null', () => {
  // resolveSlashContext работает по ТОЧНОМУ имени — префиксы дают слеш-меню
  // (filterCommands), а не подсказки аргументов.
  assert.equal(resolveSlashContext('/comp'), null)
})

test('многострочный ввод → null (аргументы только в первой строке)', () => {
  assert.equal(resolveSlashContext('/goal a\nb'), null)
})

test('/goal без пробела → контекст есть, но без области аргументов', () => {
  const ctx = resolveSlashContext('/goal')
  assert.ok(ctx)
  assert.equal(ctx.command.name, 'goal')
  assert.equal(ctx.hasArgsRegion, false)
  assert.equal(ctx.tokens.length, 0)
})

test('/goal условие → аргумент начат: prefix = последний токен', () => {
  const ctx = resolveSlashContext('/goal условие npm test')
  assert.ok(ctx)
  assert.equal(ctx.hasArgsRegion, true)
  assert.equal(ctx.endsWithSpace, false)
  assert.deepEqual([...ctx.tokens], ['условие', 'npm', 'test'])
  // level НЕ клампится в shared (клампит ChatInput по длине effective args):
  // для одного синтезированного аргумента останется level 0 после clamp.
  assert.equal(ctx.level, 2)
  assert.equal(ctx.prefix, 'test')
})

test('/goal → аргумент не начат: level 0, prefix пуст', () => {
  const ctx = resolveSlashContext('/goal ')
  assert.ok(ctx)
  assert.equal(ctx.endsWithSpace, true)
  assert.equal(ctx.tokens.length, 0)
  assert.equal(ctx.level, 0)
  assert.equal(ctx.prefix, '')
})

// ── resolveSlashContext: enum-аргументы /compact ────────────────────────────

test('/compact last → mode завершён, пикер на focus (level 1)', () => {
  const ctx = resolveSlashContext('/compact last ')
  assert.ok(ctx)
  assert.equal(ctx.command.name, 'compact')
  assert.deepEqual([...ctx.tokens], ['last'])
  assert.equal(ctx.level, 1)
  assert.equal(ctx.prefix, '')
})

test('/compact full фокус → вводится второй аргумент, prefix = фокус', () => {
  const ctx = resolveSlashContext('/compact full фокус')
  assert.ok(ctx)
  assert.equal(ctx.level, 1)
  assert.equal(ctx.prefix, 'фокус')
})

test('/compact lst → опечатка не переключает режим: level 1 (токен = фокус)', () => {
  // Контракт из parseCompactArgs: не-full/last — это фокус. Для подсказок
  // значит, что юзер вводит СВОБОДНЫЙ текст второго аргумента.
  const ctx = resolveSlashContext('/compact lst ')
  assert.ok(ctx)
  assert.equal(ctx.level, 1)
})

test('builtin приоритет над custom с тем же именем', () => {
  const ctx = resolveSlashContext('/clear ', [{ name: 'clear', label: '/clear', description: 'custom', icon: 'x', systemPrompt: () => '' }])
  assert.ok(ctx)
  assert.equal(ctx.command.custom, undefined)
})

test('custom-команда резолвится, если нет builtin', () => {
  const ctx = resolveSlashContext('/mycmd раз два', [{ name: 'mycmd', label: '/mycmd', description: '', icon: 'x', systemPrompt: () => '' }])
  assert.ok(ctx)
  assert.equal(ctx.command.name, 'mycmd')
  assert.equal(ctx.level, 1)
  assert.equal(ctx.prefix, 'два')
})

// ── getCommandArguments: синтез для команд без arguments ────────────────────

test('структурированные arguments возвращаются как есть', () => {
  const { SLASH_COMMANDS } = loadSlashCommands()
  const compact = SLASH_COMMANDS.find(c => c.name === 'compact')
  const args = getCommandArguments(compact)
  assert.equal(args.length, 2)
  assert.equal(args[0].name, 'mode')
  assert.equal(args[1].name, 'focus')
})

test('argumentHint → синтезированный свободный аргумент', () => {
  const args = getCommandArguments({ name: 'fork', label: '/fork', description: '', icon: 'x', argumentHint: 'имя нового чата (опционально)', systemPrompt: () => '' })
  assert.equal(args.length, 1)
  assert.equal(args[0].name, 'имя нового чата (опционально)')
  assert.equal(args[0].choices, undefined)
})

test('placeholder без argumentHint → короткое имя из первой фразы', () => {
  const args = getCommandArguments({ name: 'goal', label: '/goal', description: '', icon: 'x', placeholder: 'условие завершения, например: npm test выходит с кодом 0', systemPrompt: () => '' })
  assert.equal(args.length, 1)
  assert.equal(args[0].name, 'условие завершения')
  assert.equal(args[0].description, 'условие завершения, например: npm test выходит с кодом 0')
})

test('команда без подсказок → нет аргументов', () => {
  const args = getCommandArguments({ name: 'clear', label: '/clear', description: '', icon: 'x', systemPrompt: () => '' })
  assert.equal(args.length, 0)
})

// ── Согласованность с существующими парсерами ───────────────────────────────

test('resolveSlashContext согласован с parseSlashCommandWithCustom', () => {
  for (const text of ['/goal условие', '/compact full фокус', '/image cat']) {
    const parsed = parseSlashCommandWithCustom(text, [])
    const ctx = resolveSlashContext(text, [])
    assert.ok(parsed, text)
    assert.ok(ctx, text)
    assert.equal(ctx.command.name, parsed.command.name)
    // args у парсера = after.trim() у контекста
    assert.equal(ctx.after.trim(), parsed.args)
  }
})

test('filterCommands по-прежнему закрывается на пробел (меню имён)', () => {
  assert.equal(filterCommands('/compact la').length, 0)
  assert.equal(filterCommands('/compact la ').length, 0)
  assert.equal(filterCommands('/compact').length, 1)
})
