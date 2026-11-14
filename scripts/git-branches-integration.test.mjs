import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
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

const { buildCheckoutArgs, explainCheckoutError } = load('src/shared/git/checkoutPlan.ts')

function git(cwd, args, opts = {}) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', ...opts })
}

function tryGit(cwd, args) {
  try {
    return { ok: true, out: git(cwd, args) }
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message) }
  }
}

/** Текущее значение как в приложении: один обычный `git checkout`. */
function checkout(cwd, branch) {
  const res = tryGit(cwd, buildCheckoutArgs(branch))
  return res.ok ? { success: true } : { success: false, error: explainCheckoutError(res.error) }
}

/** Одноразовый репозиторий с двумя ветками. */
function makeScratch() {
  const dir = mkdtempSync(join(tmpdir(), 'syntee-git-'))
  git(dir, ['init', '-q', '-b', 'dev'])
  git(dir, ['config', 'user.email', 'test@local'])
  git(dir, ['config', 'user.name', 'test'])
  writeFileSync(join(dir, 'shared.txt'), 'base\n')
  writeFileSync(join(dir, 'other.txt'), 'base\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-qm', 'init'])
  // master меняет shared.txt — это создаёт конфликт с локальной правкой ниже
  git(dir, ['checkout', '-q', '-b', 'master'])
  writeFileSync(join(dir, 'shared.txt'), 'master version\n')
  git(dir, ['commit', '-qam', 'master change'])
  git(dir, ['checkout', '-q', 'dev'])
  return dir
}

const norm = (s) => s.replace(/\r\n/g, '\n')

// ── Как в VS Code: переключение работает всегда, если файлы не конфликтуют ──
test('интеграция: грязное дерево без конфликтов — переключается с первого раза', () => {
  const dir = makeScratch()
  try {
    writeFileSync(join(dir, 'other.txt'), 'правка, не конфликтующая с master\n')
    writeFileSync(join(dir, 'new-file.txt'), 'новый untracked файл\n')

    const res = checkout(dir, 'master')
    assert.deepEqual(res, { success: true })
    assert.equal(git(dir, ['branch', '--show-current']).trim(), 'master')
    // Правки на месте: git переносит их сам, никакого stash не понадобилось
    assert.equal(norm(readFileSync(join(dir, 'other.txt'), 'utf8')), 'правка, не конфликтующая с master\n')
    assert.equal(existsSync(join(dir, 'new-file.txt')), true)
    assert.equal(git(dir, ['stash', 'list']).trim(), '', 'stash не должен создаваться')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('интеграция: туда-обратно несколько раз — каждый раз успешно', () => {
  const dir = makeScratch()
  try {
    writeFileSync(join(dir, 'other.txt'), 'локальная правка\n')
    for (const branch of ['master', 'dev', 'master', 'dev']) {
      const res = checkout(dir, branch)
      assert.deepEqual(res, { success: true }, `переключение на ${branch} упало: ${res.error}`)
      assert.equal(git(dir, ['branch', '--show-current']).trim(), branch)
    }
    assert.equal(git(dir, ['stash', 'list']).trim(), '')
    assert.equal(norm(readFileSync(join(dir, 'other.txt'), 'utf8')), 'локальная правка\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── Конфликт: git отказывает, правки целы, причина читаемая ────────────────
test('интеграция: конфликт правок — понятная причина, дерево не тронуто', () => {
  const dir = makeScratch()
  try {
    writeFileSync(join(dir, 'shared.txt'), 'моя правка\n')

    const res = checkout(dir, 'master')
    assert.equal(res.success, false)
    assert.match(res.error, /shared\.txt/u, 'в тексте должен быть назван конфликтующий файл')
    assert.equal(res.error.includes('\n'), false, 'тост должен быть однострочным')

    // Остались на dev, правка цела, stash не создан
    assert.equal(git(dir, ['branch', '--show-current']).trim(), 'dev')
    assert.equal(norm(readFileSync(join(dir, 'shared.txt'), 'utf8')), 'моя правка\n')
    assert.equal(git(dir, ['stash', 'list']).trim(), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('интеграция: чистое дерево переключается одной командой', () => {
  const dir = makeScratch()
  try {
    assert.deepEqual(checkout(dir, 'master'), { success: true })
    assert.equal(git(dir, ['branch', '--show-current']).trim(), 'master')
    assert.equal(git(dir, ['stash', 'list']).trim(), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('интеграция: несуществующая ветка — «Ветки не существует»', () => {
  const dir = makeScratch()
  try {
    const res = checkout(dir, 'no-such-branch')
    assert.equal(res.success, false)
    assert.match(res.error, /не существует/u)
    assert.equal(git(dir, ['branch', '--show-current']).trim(), 'dev')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
