import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'

const require = createRequire(import.meta.url)

function load(path, source = readFileSync(path, 'utf8')) {
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(require, module, module.exports)
  return module.exports
}

const { parseBranchList, localBranchesOnly } = load('src/shared/git/parseBranches.ts')
const { buildCheckoutArgs, explainCheckoutError } = load('src/shared/git/checkoutPlan.ts')

// ── Регрессия №1: в шапке чата был виден только текущий бранч ───────────
// git выравнивает колонки пробелами, поэтому TAB стоит не в начале строки.
// Старый парсер вызывал line.trim() → у всех веток кроме текущей TAB съедался,
// split('\t') давал 2 части вместо 3, ветка молча пропускалась.

const REAL_OUTPUT = [
  '*\trefs/heads/dev\tdev',
  ' \trefs/heads/master\tmaster',
  ' \trefs/heads/prod\tprod',
  ' \trefs/heads/syntee-sub/agent-1792875053290-ru40g\tsyntee-sub/agent-1792875053290-ru40g',
  ' \trefs/remotes/origin/HEAD\torigin',
  ' \trefs/remotes/origin/dev\torigin/dev',
  ' \trefs/remotes/origin/master\torigin/master',
  ' \trefs/remotes/origin/prod\torigin/prod',
].join('\n')

test('парсер: все локальные ветки на месте, не только текущая', () => {
  const { branches, current } = parseBranchList(REAL_OUTPUT)
  const local = branches.filter(b => !b.remote).map(b => b.name)
  assert.deepEqual(local, ['dev', 'master', 'prod', 'syntee-sub/agent-1792875053290-ru40g'])
  assert.equal(current, 'dev')
  assert.equal(branches.find(b => b.name === 'dev')?.current, true)
  assert.equal(branches.find(b => b.name === 'master')?.current, false)
})

test('парсер: origin/HEAD отфильтрован, remote помечены', () => {
  const { branches } = parseBranchList(REAL_OUTPUT)
  assert.equal(branches.some(b => b.name.endsWith('/HEAD')), false)
  const remoteDev = branches.find(b => b.name === 'origin/dev')
  assert.ok(remoteDev)
  assert.equal(remoteDev.remote, true)
  assert.equal(remoteDev.current, false)
})

test('парсер: CRLF и пустые строки не ломают разбор', () => {
  const crlf = REAL_OUTPUT.split('\n').join('\r\n') + '\r\n\r\n'
  const { branches } = parseBranchList(crlf)
  assert.equal(branches.length, 7)
  assert.equal(branches.filter(b => !b.remote).length, 4)
})

test('парсер: мусорная строка без TAB пропускается, а не падает', () => {
  const { branches } = parseBranchList('*\trefs/heads/dev\tdev\nмусор без табов\n\n')
  assert.equal(branches.length, 1)
  assert.equal(branches[0].name, 'dev')
})

// ── Регрессия №2: в списке не должно быть удалённых веток ───────────────
// Пользователю нужно обычное переключение между своими ветками; origin/*
// не переключаются напрямую (detached HEAD) и дублируют локальные имена.
test('фильтр: остаются только локальные ветки', () => {
  const { branches } = parseBranchList(REAL_OUTPUT)
  const local = localBranchesOnly(branches)
  assert.deepEqual(local.map(b => b.name), [
    'dev',
    'master',
    'prod',
    'syntee-sub/agent-1792875053290-ru40g',
  ])
  assert.equal(local.every(b => !b.remote), true)
})

// ── Регрессия №3: авто-stash ломал переключение ────────────────────────
// «Command failed: git -C … stash push --include-untracked -m syntee: авто-stash…»
// в тосте, и ветка не переключалась. Теперь — один обычный checkout, как в VS Code.
test('checkout: одна команда, без stash-шагов', () => {
  assert.deepEqual(buildCheckoutArgs('master'), ['checkout', 'master', '--'])
})

test('checkout: имя тримится, двусмысленность с путём отсекается через --', () => {
  assert.deepEqual(buildCheckoutArgs('  feature/x  '), ['checkout', 'feature/x', '--'])
})

test('ошибка checkout: сырой git-вывод превращается в читаемую причину', () => {
  const raw = [
    'Command failed: git -C C:\\Projects\\X checkout master',
    'error: Your local changes to the following files would be overwritten by checkout:',
    '        src/main/ipc/git.ipc.ts',
    '        src/renderer/.../GitTools.tsx',
    'Please commit your changes or stash them before you switch branches.',
    'Aborting',
  ].join('\n')
  const msg = explainCheckoutError(raw)
  // Называем конкретный файл — по нему сразу понятно, что мешает
  assert.match(msg, /src\/main\/ipc\/git\.ipc\.ts/u)
  assert.equal(msg.includes('\n'), false, 'в тост не должен попадать многострочный дамп')
  assert.equal(/Command failed/u.test(msg), false, 'служебная обёртка exec не должна попадать в тост')
  assert.match(explainCheckoutError('error: pathspec "nope" did not match any file(s) known to git'), /не существует/iu)
  assert.match(explainCheckoutError('fatal: branch is already checked out at /other'), /worktree/i)
  assert.match(explainCheckoutError('fatal: Unable to create index.lock: File exists'), /повтори/iu)
})

test('ошибка checkout: совсем неизвестный вывод не остаётся пустым', () => {
  const msg = explainCheckoutError('')
  assert.equal(typeof msg, 'string')
  assert.ok(msg.length > 0)
})

// ── Контракт с реальным git: формат вывода не изменился ─────────────────
test('живой git: формат %(HEAD)%09%(refname)%09%(refname:short) парсится', () => {
  let stdout = ''
  try {
    stdout = execFileSync(
      'git',
      ['-C', process.cwd(), 'branch', '--list', '--all', '--format=%(HEAD)%09%(refname)%09%(refname:short)'],
      { encoding: 'utf8' },
    )
  } catch {
    return // git недоступен/не репозиторий — тест не применим
  }
  assert.ok(stdout.trim().length > 0, 'git вернул пустой список веток')
  const { branches, current } = parseBranchList(stdout)
  assert.ok(branches.length > 0, 'парсер потерял все ветки на живом выводе')
  assert.ok(branches.filter(b => b.current).length <= 1)
  if (branches.some(b => b.current)) assert.equal(current, branches.find(b => b.current).name)
  // Главный инвариант бага: разобрано столько же строк, сколько отдал git,
  // кроме алиаса refs/remotes/*/HEAD (его short-имя — «origin», без суффикса /HEAD).
  const expected = stdout
    .split('\n')
    .filter(l => l.trim())
    .filter(l => !(l.split('\t')[1] ?? '').trim().endsWith('/HEAD')).length
  assert.equal(branches.length, expected)
  assert.ok(localBranchesOnly(branches).every(b => !b.remote))
})

test('живой git: короткий режим branchList тоже не теряет не-текущие ветки', () => {
  let stdout = ''
  try {
    stdout = execFileSync(
      'git',
      ['-C', process.cwd(), 'branch', '--list', '--format=%(HEAD)%09%(refname:short)'],
      { encoding: 'utf8' },
    )
  } catch {
    return
  }
  const names = stdout
    .split('\n')
    .map(l => l.replace(/\r$/, ''))
    .filter(l => l.trim())
    .map(l => l.slice(l.indexOf('\t') + 1).trim())
    .filter(Boolean)
  assert.ok(names.length > 1, 'в репозитории ожидается больше одной локальной ветки')
  assert.equal(new Set(names).size, names.length, 'дубликаты в списке локальных веток')
})
