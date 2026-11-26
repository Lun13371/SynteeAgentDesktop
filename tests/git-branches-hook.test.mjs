/**
 * Общий стор веток renderer'а (src/renderer/src/hooks/useGitBranches.ts).
 *
 * Проверяем то, что нельзя увидеть глазами в UI: дедуп параллельных чтений на
 * один workdir, отбрасывание устаревших ответов, сохранение ранее полученного
 * списка при ошибке (оффлайн), контракт мутаций (checkout с remote) и поведение
 * remote-refresh (`skipped`, единственный путь — refreshBranches, без git.fetch).
 *
 * React подменяется минимальным шимом: useCallback — тождество, useEffect —
 * no-op (таймеров в тестах не запускаем), useSyncExternalStore возвращает
 * текущий снапшот. Транспиляция на лету — как в tests/git-branch-refresh.test.mjs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
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

const reactStub = {
  useCallback: fn => fn,
  useMemo: fn => fn(),
  useEffect: () => {},
  useRef: value => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

// Хук берёт разбор имени удалённой ветки из shared — транспилируем и его
// (require .ts из node не умеет, поэтому подкладываем готовый модуль).
const checkoutPlan = transpile('src/shared/git/checkoutPlan.ts')
const hooks = transpile('src/renderer/src/hooks/useGitBranches.ts', {
  react: reactStub,
  '../../../shared/git/checkoutPlan': checkoutPlan,
})

function setBridge(git) {
  globalThis.window = { syntee: { git } }
}

test('normalizeBranches: объекты {name,current,remote}, строки и дубли', () => {
  const list = hooks.normalizeBranches(
    [
      { name: 'dev', current: true, remote: false },
      { name: 'origin/dev', current: false, remote: true },
      'legacy',
      { name: 'dev', current: true, remote: false },
      null,
      42,
      { name: '' },
    ],
    'dev',
  )
  assert.deepEqual(list, [
    { name: 'dev', current: true, remote: false },
    { name: 'origin/dev', current: false, remote: true },
    { name: 'legacy', current: false, remote: false },
  ])
})

test('normalizeBranches: мусор вместо списка — пустой массив', () => {
  assert.deepEqual(hooks.normalizeBranches(undefined, null), [])
  assert.deepEqual(hooks.normalizeBranches({ branches: [] }, null), [])
})

test('совпадающие по имени локальная и удалённая ветки остаются отдельными', () => {
  const local = { name: 'origin/dev', current: true, remote: false }
  const remote = { name: 'origin/dev', current: false, remote: true }
  assert.deepEqual(hooks.normalizeBranches([local, remote], local.name), [local, remote])
  assert.equal(hooks.localNameForRemote([local, remote], remote.name), 'dev')
})

test('localNameForRemote: снимает префикс только у удалённых веток', () => {
  const branches = [
    { name: 'dev', current: true, remote: false },
    { name: 'origin/feat/x', current: false, remote: true },
    { name: 'origin/dev', current: false, remote: true },
  ]
  assert.equal(hooks.localNameForRemote(branches, 'origin/feat/x'), 'feat/x')
  assert.equal(hooks.localNameForRemote(branches, 'origin/dev'), 'dev')
  assert.equal(hooks.localNameForRemote(branches, 'dev'), 'dev')
  assert.equal(hooks.localNameForRemote(branches, 'unknown'), 'unknown')
  // Полные refs разбирает shared parseRemoteBranchName — как в main для --track.
  assert.equal(hooks.localNameForRemote(branches, 'refs/remotes/origin/feat/x'), 'feat/x')
  assert.equal(hooks.localNameForRemote(branches, 'remotes/origin/dev/'), 'dev')
})

test('чтение дедуплицируется: параллельные refresh на один workdir = один branchList(all=true)', async () => {
  let calls = 0
  let release
  setBridge({
    branchList: async (workdir, all) => {
      calls++
      assert.equal(workdir, '/repo/dedupe')
      assert.equal(all, true)
      await new Promise(resolve => { release = resolve })
      return { success: true, branches: [{ name: 'dev', current: true, remote: false }], current: 'dev' }
    },
  })

  const first = hooks.refreshGitBranches('/repo/dedupe', { force: false })
  const second = hooks.refreshGitBranches('/repo/dedupe', { force: false })
  assert.equal(calls, 1)
  release()
  await Promise.all([first, second])

  const state = hooks.getGitBranchesState('/repo/dedupe')
  assert.equal(calls, 1)
  assert.equal(state.current, 'dev')
  assert.deepEqual(state.branches, [{ name: 'dev', current: true, remote: false }])
  assert.equal(state.loading, false)
  assert.equal(state.error, null)
  assert.ok(state.lastLoadedAt > 0)
})

test('устаревший ответ не перезаписывает более свежий', async () => {
  const pending = []
  setBridge({
    branchList: () => new Promise(resolve => { pending.push(resolve) }),
  })

  const stale = hooks.refreshGitBranches('/repo/stale', { force: true })
  const fresh = hooks.refreshGitBranches('/repo/stale', { force: true })
  assert.equal(pending.length, 2)

  pending[1]({ success: true, branches: [{ name: 'new', current: true, remote: false }], current: 'new' })
  await fresh
  pending[0]({ success: true, branches: [{ name: 'old', current: true, remote: false }], current: 'old' })
  await stale

  const state = hooks.getGitBranchesState('/repo/stale')
  assert.equal(state.current, 'new')
  assert.deepEqual(state.branches.map(b => b.name), ['new'])
})

test('ошибка чтения сохраняет ранее полученный список (оффлайн)', async () => {
  let mode = 'ok'
  setBridge({
    branchList: async () => {
      if (mode === 'ok') {
        return { success: true, branches: [{ name: 'dev', current: true, remote: false }], current: 'dev' }
      }
      if (mode === 'ipc-error') return { success: false, error: 'fatal: not a git repository', branches: [], current: null }
      throw new Error('git exploded')
    },
  })

  await hooks.refreshGitBranches('/repo/offline', { force: true })
  assert.equal(hooks.getGitBranchesState('/repo/offline').current, 'dev')

  mode = 'ipc-error'
  await hooks.refreshGitBranches('/repo/offline', { force: true })
  let state = hooks.getGitBranchesState('/repo/offline')
  assert.equal(state.error, 'fatal: not a git repository')
  assert.deepEqual(state.branches.map(b => b.name), ['dev'])
  assert.equal(state.current, 'dev')

  mode = 'throw'
  await hooks.refreshGitBranches('/repo/offline', { force: true })
  state = hooks.getGitBranchesState('/repo/offline')
  assert.equal(state.error, 'git exploded')
  assert.deepEqual(state.branches.map(b => b.name), ['dev'])
})

test('checkout: remote-ветка передаётся в main как есть, current = локальное имя из ответа', async () => {
  const calls = []
  setBridge({
    branchList: async () => ({
      success: true,
      branches: [
        { name: 'feat', current: true, remote: false },
        { name: 'origin/feat', current: false, remote: true },
      ],
      current: 'feat',
    }),
    checkout: async params => {
      calls.push(params)
      return { success: true, branch: 'feat', created: true }
    },
  })

  const api = hooks.useGitBranches('/repo/checkout', false)
  await api.checkout({ branch: 'origin/feat', remote: true })
  assert.deepEqual(calls, [{ workdir: '/repo/checkout', branch: 'origin/feat', remote: true }])
  assert.equal(hooks.getGitBranchesState('/repo/checkout').current, 'feat')

  await api.checkout('dev')
  assert.deepEqual(calls[1], { workdir: '/repo/checkout', branch: 'dev', remote: false })
})

test('checkout: ошибка main пробрасывается как Error с читаемой причиной', async () => {
  setBridge({
    branchList: async () => ({ success: true, branches: [{ name: 'dev', current: true, remote: false }], current: 'dev' }),
    checkout: async () => ({ success: false, error: 'Файл a.ts изменён локально и конфликтует с этой веткой' }),
  })

  const api = hooks.useGitBranches('/repo/checkout-err', false)
  await assert.rejects(
    () => api.checkout('feat'),
    /Файл a\.ts изменён локально и конфликтует/,
  )
})

test('createBranch: по умолчанию создаёт с переключением', async () => {
  const calls = []
  setBridge({
    branchList: async () => ({ success: true, branches: [{ name: 'new', current: true, remote: false }], current: 'new' }),
    branchCreate: async params => { calls.push(params); return { success: true, output: '' } },
  })

  const api = hooks.useGitBranches('/repo/create', false)
  await api.createBranch('  new  ')
  assert.deepEqual(calls, [{ workdir: '/repo/create', branch: 'new', checkout: true }])

  await api.createBranch('other', { checkout: false })
  assert.deepEqual(calls[1], { workdir: '/repo/create', branch: 'other', checkout: false })
})

test('refreshRemote: skipped от main не вызывает повторное чтение, ошибка только в remoteError', async () => {
  let listCalls = 0
  let refreshMode = 'skipped'
  setBridge({
    branchList: async () => {
      listCalls++
      return { success: true, branches: [{ name: 'dev', current: true, remote: false }], current: 'dev' }
    },
    refreshBranches: async workdir => {
      assert.equal(workdir, '/repo/remote')
      if (refreshMode === 'error') return { success: false, error: 'fetch failed' }
      return { success: true, skipped: true }
    },
  })

  const api = hooks.useGitBranches('/repo/remote', false)
  await api.refresh({ force: false })
  const afterRead = listCalls

  await api.refreshRemote({ force: true })
  let state = hooks.getGitBranchesState('/repo/remote')
  assert.equal(listCalls, afterRead, 'skipped fetch не должен перечитывать список')
  assert.equal(state.remoteError, null)
  assert.ok(state.lastRemoteAt > 0)

  refreshMode = 'error'
  await api.refreshRemote({ force: true })
  state = hooks.getGitBranchesState('/repo/remote')
  assert.equal(state.remoteError, 'fetch failed')
  assert.deepEqual(state.branches.map(b => b.name), ['dev'], 'список сохраняется при ошибке fetch')
})

test('optimistic current: совпадение с именем удалённой ветки не помечает её текущей', async () => {
  const list = [
    { name: 'dev', current: false, remote: false },
    { name: 'origin/dev', current: false, remote: true },
  ]
  let mode = 'seed'
  setBridge({
    branchList: async () => (mode === 'seed'
      ? { success: true, branches: list, current: null }
      // Перечитывание после мутации «зависает»: проверяем именно optimistic-шаг.
      : new Promise(() => {})),
    checkout: async () => ({ success: true }),
  })

  await hooks.refreshGitBranches('/repo/optimistic', { force: true })
  mode = 'hang'

  const api = hooks.useGitBranches('/repo/optimistic', false)
  await api.checkout({ branch: 'origin/dev', remote: true })

  const state = hooks.getGitBranchesState('/repo/optimistic')
  assert.equal(state.current, 'dev', 'fallback имени — только для удалённой ветки')
  assert.equal(state.branches.find(b => b.remote).current, false, 'origin-строка не становится текущей')
  assert.equal(state.branches.find(b => !b.remote).current, true)
})

test('refreshRemote: без refreshBranches — понятная ошибка, git.fetch не используется', async () => {
  let fetchCalls = 0
  setBridge({
    branchList: async () => ({ success: true, branches: [], current: null }),
    fetch: async () => { fetchCalls++; return { success: true } },
  })

  const api = hooks.useGitBranches('/repo/no-refresh', false)
  await api.refreshRemote({ force: true })

  assert.equal(fetchCalls, 0, 'legacy-путь через git.fetch удалён')
  assert.match(hooks.getGitBranchesState('/repo/no-refresh').remoteError, /refreshBranches is unavailable/)
})

test('разные workdir — разные сторы, подписки не пересекаются', async () => {
  setBridge({
    branchList: async workdir => ({
      success: true,
      branches: [{ name: workdir.endsWith('a') ? 'branch-a' : 'branch-b', current: true, remote: false }],
      current: workdir.endsWith('a') ? 'branch-a' : 'branch-b',
    }),
  })

  await Promise.all([
    hooks.refreshGitBranches('/repo/a', { force: true }),
    hooks.refreshGitBranches('/repo/b', { force: true }),
  ])
  assert.equal(hooks.getGitBranchesState('/repo/a').current, 'branch-a')
  assert.equal(hooks.getGitBranchesState('/repo/b').current, 'branch-b')
})
