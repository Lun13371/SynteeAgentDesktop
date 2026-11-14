import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync as read } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)

function load(path) {
  const output = ts.transpileModule(read(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(require, module, module.exports)
  return module.exports
}

const { buildCheckoutPlan, explainCheckoutError } = load('src/shared/git/checkoutPlan.ts')

function git(cwd, args, opts = {}) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', ...opts })
}

/** Одноразовый репозиторий с двумя ветками и «грязным» рабочим деревом. */
function makeScratch() {
  const dir = mkdtempSync(join(tmpdir(), 'syntee-git-'))
  git(dir, ['init', '-q', '-b', 'dev'])
  git(dir, ['config', 'user.email', 'test@local'])
  git(dir, ['config', 'user.name', 'test'])
  writeFileSync(join(dir, 'shared.txt'), 'base\n')
  writeFileSync(join(dir, 'other.txt'), 'base\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-qm', 'init'])
  // master меняет shared.txt — это создаёт конфликт с незакоммиченной правкой ниже
  git(dir, ['checkout', '-q', '-b', 'master'])
  writeFileSync(join(dir, 'shared.txt'), 'master version\n')
  git(dir, ['commit', '-qam', 'master change'])
  git(dir, ['checkout', '-q', 'dev'])
  return dir
}

function runPlan(cwd, plan) {
  for (let i = 0; i < plan.steps.length; i++) {
    try {
      git(cwd, plan.steps[i].args)
    } catch (e) {
      return { ok: false, at: i, error: String(e.stderr || e.message) }
    }
  }
  return { ok: true }
}

test('интеграция: голая команда checkout падает на правках (причина бага)', () => {
  const dir = makeScratch()
  try {
    writeFileSync(join(dir, 'shared.txt'), 'моя незакоммиченная правка\n')
    let failed = false
    try {
      git(dir, ['checkout', 'master'])
    } catch (e) {
      failed = true
      const msg = explainCheckoutError(String(e.stderr || e.message))
      // Ровно то, что пользователь видел в тосте: сырой многострочный дамп git
      assert.match(msg, /незакоммиченные правки/iu)
      assert.equal(msg.includes('\n'), false)
    }
    assert.equal(failed, true, 'git должен отказать без stash — иначе баг не воспроизводится')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('интеграция: план stash→checkout→pop переключает ветку и сохраняет правки', () => {
  const dir = makeScratch()
  try {
    writeFileSync(join(dir, 'other.txt'), 'правка, не конфликтующая с master\n')
    writeFileSync(join(dir, 'new-file.txt'), 'новый файл\n')

    const plan = buildCheckoutPlan('master', { localBranches: ['dev', 'master'], remoteBranches: [], dirty: true })
    const res = runPlan(dir, plan)
    assert.deepEqual(res, { ok: true })

    assert.equal(git(dir, ['branch', '--show-current']).trim(), 'master')
    // Правки вернулись из stash: unstaged-изменение и untracked-файл на месте
    const status = git(dir, ['status', '--porcelain'])
    assert.match(status, /other\.txt/)
    assert.match(status, /new-file\.txt/)
    // git может применить core.autocrlf → сравниваем без CR
    assert.equal(
      readFileSync(join(dir, 'other.txt'), 'utf8').replace(/\r\n/g, '\n'),
      'правка, не конфликтующая с master\n',
    )
    // stash пуст — правки не осели в нём
    assert.equal(git(dir, ['stash', 'list']).trim(), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('интеграция: конфликт правок — правки не теряются, остаются в stash', () => {
  const dir = makeScratch()
  try {
    // shared.txt изменён и в master, и локально → stash pop конфликтует
    writeFileSync(join(dir, 'shared.txt'), 'моя правка\n')
    const plan = buildCheckoutPlan('master', { localBranches: ['dev', 'master'], remoteBranches: [], dirty: true })
    const res = runPlan(dir, plan)

    assert.equal(res.ok, false, 'pop должен конфликтовать')
    assert.equal(res.at, 2)
    // Главное: ветка переключена, а правки лежат в stash, а не пропали
    assert.equal(git(dir, ['branch', '--show-current']).trim(), 'master')
    assert.match(git(dir, ['stash', 'list']), /stash@\{0\}/)
    const recovered = git(dir, ['stash', 'show', '-p', 'stash@{0}'])
    assert.match(recovered, /моя правка/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('интеграция: чистое дерево переключается одной командой', () => {
  const dir = makeScratch()
  try {
    const plan = buildCheckoutPlan('master', { localBranches: ['dev', 'master'], remoteBranches: [], dirty: false })
    assert.deepEqual(plan.steps.map(s => s.args), [['checkout', 'master']])
    assert.deepEqual(runPlan(dir, plan), { ok: true })
    assert.equal(git(dir, ['branch', '--show-current']).trim(), 'master')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
