/**
 * Ветки: парсинг `git branch --all` (алиасы/псевдо-ветки/точные имена),
 * безопасное переключение на удалённую ветку (без detached HEAD и без
 * перезаписи существующей локальной) и фоновый `fetch --all --prune`
 * с дедупом по общему .git и rate limit.
 *
 * Транспиляция на лету — тот же паттерн, что в file-inventory.test.mjs.
 * Интеграционные кейсы работают на реальном git во временном каталоге.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
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
  const requireShimFn = spec => (requireShim[spec] ? requireShim[spec] : nodeRequire(spec))
  new Function('exports', 'require', 'module', js)(module.exports, requireShimFn, module)
  return module.exports
}

const runGitModule = transpile('src/main/git/runGit.ts')
const parseBranches = transpile('src/shared/git/parseBranches.ts')
const checkoutPlan = transpile('src/shared/git/checkoutPlan.ts')
const refreshModule = transpile('src/main/git/refresh.ts', { './runGit': runGitModule })
const checkoutModule = transpile('src/main/git/checkout.ts', {
  './runGit': runGitModule,
  '../../shared/git/checkoutPlan': checkoutPlan,
})

const { parseBranchList, parseLocalBranchList, BRANCH_LIST_ALL_ARGS, BRANCH_LIST_LOCAL_ARGS } = parseBranches
const { planCheckout, parseRemoteBranchName, isValidBranchName, buildCheckoutArgs } = checkoutPlan
const { createBranchRefresher } = refreshModule
const { checkoutBranch } = checkoutModule

// ── helpers ────────────────────────────────────────────────────────────

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function tryGit(cwd, args) {
  try {
    return { ok: true, out: git(cwd, args) }
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message) }
  }
}

function makeScratch(prefix = 'syntee-git-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function initRepo(dir, branch = 'main') {
  git(dir, ['init', '-q', '-b', branch])
  git(dir, ['config', 'user.email', 'test@local'])
  git(dir, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-qm', 'init'])
}

/** origin (не bare) + клон: так удалённые ветки реально существуют в refs/remotes. */
function makeOriginAndClone() {
  const base = makeScratch()
  const origin = path.join(base, 'origin')
  const clone = path.join(base, 'clone')
  fs.mkdirSync(origin)
  initRepo(origin)
  fs.writeFileSync(path.join(origin, 'b.txt'), 'b\n')
  git(origin, ['add', '.'])
  git(origin, ['commit', '-qm', 'second'])
  git(origin, ['branch', 'feat/remote-only'])
  execFileSync('git', ['clone', '-q', origin, clone], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git(clone, ['config', 'user.email', 'test@local'])
  git(clone, ['config', 'user.name', 'test'])
  return { base, origin, clone, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) }
}

function headBranch(dir) {
  const res = tryGit(dir, ['symbolic-ref', '--short', 'HEAD'])
  return res.ok ? res.out.trim() : null
}

// ── парсинг веток ──────────────────────────────────────────────────────

test('parseBranchList: алиас origin/HEAD не попадает в список', () => {
  const out = [
    '*\trefs/heads/main\tmain\t',
    ' \trefs/remotes/origin/HEAD\torigin/HEAD\trefs/remotes/origin/main',
    ' \trefs/remotes/origin/main\torigin/main\t',
    ' \trefs/remotes/origin/feat/x\torigin/feat/x\t',
    '',
  ].join('\n')
  const { branches, current } = parseBranchList(out)
  assert.equal(current, 'main')
  assert.deepEqual(branches.map(b => b.name), ['main', 'origin/main', 'origin/feat/x'])
  assert.deepEqual(branches.map(b => b.remote), [false, true, true])
  assert.deepEqual(branches.map(b => b.current), [true, false, false])
})

test('parseBranchList: detached HEAD не превращается в фантомную ветку', () => {
  const out = [
    '*\t(HEAD detached at refs/heads/main)\t(HEAD detached at refs/heads/main)\t',
    ' \trefs/heads/main\tmain\t',
    ' \trefs/heads/dev\tdev\t',
  ].join('\n')
  const { branches, current } = parseBranchList(out)
  assert.equal(current, null)
  assert.deepEqual(branches.map(b => b.name), ['main', 'dev'])
})

test('parseBranchList: точные имена без «heads/»/«remotes/» даже при совпадении имён', () => {
  // Локальная ветка origin/feat/x и одноимённая удалённая: refname:short
  // печатал heads/origin/feat/x и remotes/origin/feat/x, lstrip=2 — чистое имя.
  const out = [
    '*\trefs/heads/main\tmain\t',
    ' \trefs/heads/origin/feat/x\torigin/feat/x\t',
    ' \trefs/remotes/origin/feat/x\torigin/feat/x\t',
  ].join('\r\n')
  const { branches } = parseBranchList(out)
  assert.deepEqual(branches.map(b => `${b.remote ? 'r' : 'l'}:${b.name}`), ['l:main', 'l:origin/feat/x', 'r:origin/feat/x'])
})

test('parseBranchList: старый 3-колоночный формат и алиас без symref-колонки', () => {
  const out = [
    '*\trefs/heads/dev\tdev',
    ' \trefs/remotes/origin/HEAD\torigin',
    ' \trefs/remotes/origin/dev\torigin/dev',
  ].join('\n')
  const { branches, current } = parseBranchList(out)
  assert.equal(current, 'dev')
  assert.deepEqual(branches.map(b => b.name), ['dev', 'origin/dev'])
})

test('parseBranchList: пустой вывод и мусор не падают', () => {
  assert.deepEqual(parseBranchList(''), { branches: [], current: null })
  assert.deepEqual(parseBranchList('\n\n   \n'), { branches: [], current: null })
  assert.deepEqual(parseBranchList('no-tabs-here'), { branches: [], current: null })
})

test('parseLocalBranchList: имена и текущая ветка, detached отфильтрован', () => {
  const out = ['*\trefs/heads/dev\tdev', ' \trefs/heads/feat/x\tfeat/x'].join('\n')
  assert.deepEqual(parseLocalBranchList(out), { branches: ['dev', 'feat/x'], current: 'dev' })

  const detached = ['*\t(HEAD detached at 1a2b3c)\t(HEAD detached at 1a2b3c)', ' \trefs/heads/dev\tdev'].join('\n')
  assert.deepEqual(parseLocalBranchList(detached), { branches: ['dev'], current: null })
})

test('формат branchList содержит lstrip=2 и symref (без refname:short)', () => {
  const all = BRANCH_LIST_ALL_ARGS.join(' ')
  assert.match(all, /--all/)
  assert.match(all, /refname:lstrip=2/)
  assert.match(all, /%\(symref\)/)
  assert.doesNotMatch(all, /refname:short/)
  assert.doesNotMatch(BRANCH_LIST_LOCAL_ARGS.join(' '), /refname:short/)
})

// ── план переключения ──────────────────────────────────────────────────

test('planCheckout: локальная ветка и полный refs/heads/', () => {
  assert.deepEqual(planCheckout({ branch: 'dev' }), {
    ok: true,
    plan: { args: ['checkout', 'dev', '--'], localBranch: 'dev' },
  })
  const fromFullRef = planCheckout({ branch: 'refs/heads/feat/x' })
  assert.equal(fromFullRef.ok, true)
  // refs/heads/… в checkout = detached HEAD, поэтому имя нормализуется.
  assert.deepEqual(fromFullRef.plan.args, ['checkout', 'feat/x', '--'])
})

test('planCheckout: удалённая ветка создаёт локальную tracking-ветку', () => {
  for (const input of ['origin/feat/x', 'refs/remotes/origin/feat/x', 'remotes/origin/feat/x']) {
    const planned = planCheckout({ branch: input, remote: true })
    assert.equal(planned.ok, true, input)
    assert.equal(planned.plan.localBranch, 'feat/x')
    assert.equal(planned.plan.remoteRef, 'refs/remotes/origin/feat/x')
    assert.deepEqual(planned.plan.args, ['checkout', '--track', '-b', 'feat/x', 'refs/remotes/origin/feat/x', '--'])
    // Никакого «checkout origin/feat/x» — это detached HEAD.
    assert.notEqual(planned.plan.args[1], input)
  }
})

test('planCheckout: некорректные имена отклоняются (в т.ч. инъекция опций)', () => {
  for (const bad of ['', '   ', '-D', '--orphan', 'a b', 'x..y', 'x@{1}', 'x~1', 'x:y', '/abs', 'a//b', 'a/', 'a.lock', '@']) {
    const res = planCheckout({ branch: bad })
    assert.equal(res.ok, false, `local: ${JSON.stringify(bad)}`)
  }
  for (const bad of ['', 'origin', 'origin/HEAD', 'refs/remotes/origin/HEAD', '-x/y', 'origin/-y', 'origin/x..y']) {
    const res = planCheckout({ branch: bad, remote: true })
    assert.equal(res.ok, false, `remote: ${JSON.stringify(bad)}`)
  }
})

test('parseRemoteBranchName: remote и имя ветки разделяются по первому слэшу', () => {
  assert.deepEqual(parseRemoteBranchName('origin/feat/x'), {
    remote: 'origin',
    branch: 'feat/x',
    remoteRef: 'refs/remotes/origin/feat/x',
  })
  assert.equal(parseRemoteBranchName('origin/feat/x/').remoteRef, 'refs/remotes/origin/feat/x')
  assert.equal(parseRemoteBranchName('origin'), null)
  assert.equal(parseRemoteBranchName('refs/remotes/origin/HEAD'), null)
})

test('isValidBranchName: обычные имена валидны', () => {
  for (const ok of ['dev', 'feat/x', 'release/2024.1', 'user/name/fix']) assert.equal(isValidBranchName(ok), true, ok)
  assert.deepEqual(buildCheckoutArgs(' dev '), ['checkout', 'dev', '--'])
})

// ── фоновый fetch: дедуп и rate limit ──────────────────────────────────

function fakeRunner(handler) {
  const calls = []
  const run = async (workdir, args, options) => {
    calls.push({ workdir, args, options })
    return handler(workdir, args, options)
  }
  return { run, calls, fetches: () => calls.filter(c => c.args[0] === 'fetch') }
}

const commonDirReply = commonDir => (workdir, args) => {
  if (args[0] === 'rev-parse' && args.includes('--path-format=absolute')) return `${commonDir}\n`
  return ''
}

test('refresh: параллельные вызовы дают один fetch на репозиторий', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const runner = fakeRunner(async (workdir, args) => {
    if (args[0] === 'rev-parse') return commonDirReply('C:/repo/.git')(workdir, args)
    await gate
    return ''
  })
  const refresher = createBranchRefresher({ run: runner.run, minIntervalMs: 0 })

  // Не await'им сразу: первый вызов держится на gate, второй должен получить
  // тот же промис. Порядок «запустить → отпустить → дождаться» важен.
  const a = refresher.refresh('C:/repo')
  const b = refresher.refresh('C:/repo/worktree')
  await delay(10)
  release()
  const [a2, b2] = await Promise.all([a, b])

  assert.equal(a2.success, true)
  assert.equal(b2.success, true)
  assert.equal(runner.fetches().length, 1)
  assert.deepEqual(runner.fetches()[0].args, ['fetch', '--all', '--prune'])
})

test('refresh: worktree и основное дерево делят общий .git (один fetch)', async () => {
  let clock = 1_000
  const runner = fakeRunner((workdir, args) => (args[0] === 'rev-parse' ? 'C:\\repo\\.git\n' : ''))
  const refresher = createBranchRefresher({ run: runner.run, now: () => clock, minIntervalMs: 10_000 })

  assert.equal((await refresher.refresh('C:/repo')).success, true)
  // Другой worktree того же репозитория: общий .git → второй fetch не нужен.
  const sameRepo = await refresher.refresh('C:/repo/.worktrees/agent-1')
  assert.equal(sameRepo.skipped, true)
  assert.equal(runner.fetches().length, 1)

  // Другой репозиторий — свой ключ, свой fetch.
  clock += 20_000
  await refresher.refresh('C:/other')
  assert.equal(runner.fetches().length, 2)
})

test('refresh: rate limit не даёт дёргать fetch чаще интервала', async () => {
  let clock = 1_000
  const runner = fakeRunner((workdir, args) => (args[0] === 'rev-parse' ? 'C:/repo/.git\n' : ''))
  const refresher = createBranchRefresher({ run: runner.run, now: () => clock, minIntervalMs: 10_000 })

  assert.deepEqual(await refresher.refresh('C:/repo'), { success: true })
  assert.equal(runner.fetches().length, 1)

  clock += 3_000
  const throttled = await refresher.refresh('C:/repo')
  assert.equal(throttled.skipped, true)
  assert.equal(runner.fetches().length, 1)

  clock += 10_000
  await refresher.refresh('C:/repo')
  assert.equal(runner.fetches().length, 2)
})

test('refresh: ошибка fetch не бросает и кэшируется как результат', async () => {
  const runner = fakeRunner((workdir, args) => {
    if (args[0] === 'rev-parse') return 'C:/repo/.git\n'
    throw new Error('could not resolve host')
  })
  let clock = 1_000
  const refresher = createBranchRefresher({ run: runner.run, now: () => clock, minIntervalMs: 60_000 })

  const res = await refresher.refresh('C:/repo')
  assert.equal(res.success, false)
  assert.match(res.error, /could not resolve host/)

  const second = await refresher.refresh('C:/repo')
  assert.equal(second.skipped, true)
  assert.equal(second.success, false)
  assert.equal(runner.fetches().length, 1)
})

test('refresh: пустой workdir и не-репозиторий обрабатываются без исключений', async () => {
  const runner = fakeRunner(() => { throw new Error('not a git repository') })
  const refresher = createBranchRefresher({ run: runner.run, minIntervalMs: 0 })

  assert.equal((await refresher.refresh('')).success, false)
  const res = await refresher.refresh('C:/not-a-repo')
  assert.equal(res.success, false)
  assert.match(res.error, /not a git repository/)
})

test('refresh: fetch запускается неинтерактивно (env для фона)', async () => {
  const runner = fakeRunner((workdir, args) => (args[0] === 'rev-parse' ? 'C:/repo/.git\n' : ''))
  const refresher = createBranchRefresher({ run: runner.run, minIntervalMs: 0 })
  await refresher.refresh('C:/repo')

  const fetchCall = runner.fetches()[0]
  assert.equal(fetchCall.options.env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(fetchCall.options.env.GCM_INTERACTIVE, 'never')
  assert.equal(fetchCall.options.env.SSH_ASKPASS_REQUIRE, 'never')
  assert.ok(fetchCall.options.timeoutMs >= 10_000)
})

// ── интеграция: реальный git ───────────────────────────────────────────

test('интеграция: после refresh удалённая ветка видна в branchList(all)', async () => {
  const repo = makeOriginAndClone()
  try {
    // В origin ветка feat/remote-only появилась ДО клона, поэтому в клоне она
    // уже есть; создаём ещё одну уже после клона — её подтянет только fetch.
    git(repo.origin, ['branch', 'feat/after-clone'])

    const refresher = createBranchRefresher({ run: runGitModule.runGit, minIntervalMs: 0 })
    const res = await refresher.refresh(repo.clone)
    assert.equal(res.success, true)

    const parsed = parseBranchList(git(repo.clone, BRANCH_LIST_ALL_ARGS))
    const names = parsed.branches.map(b => b.name)
    assert.ok(names.includes('origin/feat/after-clone'), names.join(','))
    assert.ok(names.includes('origin/feat/remote-only'), names.join(','))
    assert.ok(!names.some(n => n === 'origin' || n.endsWith('/HEAD')), names.join(','))
    assert.equal(parsed.current, 'main')
    assert.deepEqual(parseLocalBranchList(git(repo.clone, BRANCH_LIST_LOCAL_ARGS)).branches, ['main'])
  } finally {
    repo.cleanup()
  }
})

test('интеграция: checkout удалённой ветки создаёт локальную, а не detached HEAD', async () => {
  const repo = makeOriginAndClone()
  try {
    const res = await checkoutBranch(repo.clone, { branch: 'origin/feat/remote-only', remote: true })
    assert.equal(res.success, true, res.error)
    assert.equal(res.branch, 'feat/remote-only')
    assert.equal(res.created, true)
    assert.equal(headBranch(repo.clone), 'feat/remote-only')
    // upstream настроен на удалённую ветку
    assert.equal(git(repo.clone, ['rev-parse', '--abbrev-ref', 'feat/remote-only@{upstream}']).trim(), 'origin/feat/remote-only')
  } finally {
    repo.cleanup()
  }
})

test('интеграция: существующая локальная ветка не перезаписывается', async () => {
  const repo = makeOriginAndClone()
  try {
    // Локальная feat/remote-only со своим коммитом — переключение на удалённую
    // с тем же именем не должно её пересоздать (-B/-f) и потерять коммит.
    git(repo.clone, ['checkout', '-q', '-b', 'feat/remote-only'])
    fs.writeFileSync(path.join(repo.clone, 'local.txt'), 'local\n')
    git(repo.clone, ['add', '.'])
    git(repo.clone, ['commit', '-qm', 'local work'])
    git(repo.clone, ['checkout', '-q', 'main'])

    const res = await checkoutBranch(repo.clone, { branch: 'refs/remotes/origin/feat/remote-only', remote: true })
    assert.equal(res.success, true, res.error)
    assert.equal(res.created, false)
    assert.equal(headBranch(repo.clone), 'feat/remote-only')
    assert.equal(git(repo.clone, ['log', '-1', '--format=%s']).trim(), 'local work')
  } finally {
    repo.cleanup()
  }
})

test('интеграция: несуществующая удалённая ветка — понятная ошибка, HEAD на месте', async () => {
  const repo = makeOriginAndClone()
  try {
    const res = await checkoutBranch(repo.clone, { branch: 'origin/nope/absent', remote: true })
    assert.equal(res.success, false)
    assert.match(res.error, /Удалённой ветки не существует/)
    assert.equal(headBranch(repo.clone), 'main')
  } finally {
    repo.cleanup()
  }
})

test('интеграция: локальная ветка по полному refs/heads/ не даёт detached HEAD', async () => {
  const repo = makeOriginAndClone()
  try {
    git(repo.clone, ['branch', 'dev'])
    const res = await checkoutBranch(repo.clone, { branch: 'refs/heads/dev' })
    assert.equal(res.success, true, res.error)
    assert.equal(headBranch(repo.clone), 'dev')
  } finally {
    repo.cleanup()
  }
})

// Регрессия: ветку удалили (список в UI устарел), а её имя теперь принадлежит
// ТЕГУ. `git checkout <name>` в этом случае молча уходит в detached HEAD —
// семантика должна быть branch-only (`git switch --no-guess`).
test('интеграция: удалённая ветка, чьё имя стало тегом, не уводит в detached HEAD', async () => {
  const repo = makeOriginAndClone()
  try {
    // Тег с именем бывшей ветки; локальной ветки dev нет.
    git(repo.clone, ['tag', 'dev', 'HEAD'])
    const res = await checkoutBranch(repo.clone, { branch: 'dev' })
    assert.equal(res.success, false)
    assert.match(res.error, /Ветки не существует/)
    // HEAD не сдвинулся и остался на ветке, а не «(HEAD detached at …)».
    assert.equal(headBranch(repo.clone), 'main')
    assert.equal(git(repo.clone, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main')
  } finally {
    repo.cleanup()
  }
})

test('интеграция: обычное имя без префикса remote принимается для удалённой ветки', async () => {
  const repo = makeOriginAndClone()
  try {
    // UI может прислать «feat/remote-only» вместо «origin/feat/remote-only» —
    // первый сегмент нельзя принимать за имя remote.
    const res = await checkoutBranch(repo.clone, { branch: 'feat/remote-only', remote: true })
    assert.equal(res.success, true, res.error)
    assert.equal(res.branch, 'feat/remote-only')
    assert.equal(headBranch(repo.clone), 'feat/remote-only')
  } finally {
    repo.cleanup()
  }
})

test('GitSyncManager: авто-fetch идёт через общий refreshBranches, а не своим git fetch', () => {
  // Один fetch на репозиторий: фоновый синк не должен конкурировать с панелью
  // и чипом «Обзор», у которых дедуп/rate limit живёт в src/main/git/refresh.ts.
  const source = fs.readFileSync(path.join(root, 'src/main/managers/GitSyncManager.ts'), 'utf8')
  assert.match(source, /import \{ refreshBranches \} from '\.\.\/git\/refresh'/)
  assert.match(source, /await refreshBranches\(/)
  assert.doesNotMatch(source, /\['fetch'/)
})
