/**
 * useGitBranches — ОДИН общий стор списка веток git на всё renderer-приложение.
 *
 * ПОЧЕМУ ХУК, А НЕ ЛОКАЛЬНЫЙ useState В КАЖДОЙ ПАНЕЛИ: ветки читали минимум три
 * места (GitTools — чип «Обзор», GitPanel — dropdown переключения, GitGraph),
 * каждое своим `git:branchList` + своим таймером. Пока панели были открыты
 * одновременно, это давало N параллельных `git`-процессов на один workdir и
 * рассинхрон: после переключения в одной панели вторая показывала старую ветку
 * до собственного опроса. Здесь данные живут по ключу workdir, читаются один раз
 * на всех (dedupe in-flight), а мутация (checkout/create/delete) немедленно
 * обновляет ВСЕХ подписчиков.
 *
 * API (стабильный контракт, менять только вместе с панелями):
 *
 *   const {
 *     branches,      // GitBranchRef[] — { name, current, remote } из git:branchList(workdir, true)
 *     current,       // string | null — текущая локальная ветка (или null при detached HEAD)
 *     loading,       // boolean — идёт чтение списка
 *     error,         // string | null — ошибка ЧТЕНИЯ списка (данные при этом сохраняются)
 *     remoteError,   // string | null — ошибка refreshBranches (список НЕ чистится)
 *     lastLoadedAt,  // number | null — когда список успешно прочитан
 *     lastRemoteAt,  // number | null — когда успешно прошёл remote-fetch
 *     refresh,       // (opts?: { force?: boolean }) => Promise<void>
 *     refreshRemote, // (opts?: { force?: boolean }) => Promise<void> — `git fetch` (main троттлит)
 *     checkout,      // (input: { branch: string; remote?: boolean } | string) => Promise<void>
 *     createBranch,  // (name: string, opts?: { checkout?: boolean }) => Promise<void>
 *   } = useGitBranches(workdir, active)
 *
 * Поведение:
 *  - `active` — панель открыта. Пока active=true: опрос списка каждые 15 c и
 *    remote-fetch раз в 5 мин (плюс один fetch при открытии). Пока active=false
 *    таймеров нет вообще — фон не грузит git.
 *  - Чтение дедуплицируется: параллельные refresh() на один workdir дают один
 *    `git:branchList`. Ответ, пришедший после мутации или после более нового
 *    запроса, отбрасывается (guard по readSeq/mutationSeq) — «прыжков» списка нет.
 *  - Оффлайн-данные сохраняются: ошибка чтения/fetch только выставляет error/
 *    remoteError, ранее полученный список остаётся на экране.
 *  - Мутации возвращают Promise и БРОСАЮТ Error с текстом от git (см. ниже).
 *    После мутации (успешной И неуспешной — например branchCreate создал ветку,
 *    но checkout не прошёл) список перечитывается, подписчики обновляются сразу.
 *
 * Контракт мутаций (согласован с src/main/ipc/git.ipc.ts и src/main/git/*.ts,
 * панели НЕ правим):
 *  - checkout: `window.syntee.git.checkout({ workdir, branch, remote? })` →
 *    `{ success, error?, branch?, created? }`. Для локальной ветки main делает
 *    `git checkout <branch> --`, для удалённой (`remote: true`, имя вида
 *    `origin/feature/x` или `refs/remotes/origin/feature/x`) — `--track -b`,
 *    чтобы получить локальную ветку с upstream, а не detached HEAD
 *    (src/main/git/checkout.ts, src/shared/git/checkoutPlan.ts). Авто-stash нет;
 *    при конфликте правок приходит читаемая причина (explainCheckoutError) —
 *    хук пробрасывает её как Error.message. `branch` из ответа (имя локальной
 *    ветки) используется для оптимистичного `current`.
 *  - createBranch: `git.branchCreate({ workdir, branch, checkout })`; по умолчанию
 *    checkout=true (создать и переключиться) — как в GitTools/GitPanel.
 *
 * Зависимости от main/preload только через `window.syntee.git`; отсутствующий
 * метод — понятная ошибка, а не падение приложения. Удалённые ветки обновляет
 * ТОЛЬКО `git.refreshBranches` (main троттлит и дедуплицирует fetch): второго
 * пути через `git.fetch` нет, иначе обновление расходилось бы с троттлингом.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { parseRemoteBranchName } from '../../../shared/git/checkoutPlan'

/** Ветка в том же виде, что отдаёт `git:branchList(workdir, true)` (см. src/shared/git/parseBranches.ts). */
export interface GitBranchRef {
  /** Имя как в git (refname:short): `dev`, `origin/dev`. */
  name: string
  /** Это текущая ветка (detached HEAD → все false). */
  current: boolean
  /** refs/remotes/* — удалённая ветка, напрямую не переключаемся. */
  remote: boolean
}

/** Публичное состояние стора. Объект иммутабельный: любое изменение = новый объект. */
export interface GitBranchesState {
  branches: GitBranchRef[]
  current: string | null
  loading: boolean
  error: string | null
  remoteError: string | null
  lastLoadedAt: number | null
  lastRemoteAt: number | null
}

/** Ответ git-IPC (все handlers возвращают `{ success, error? }`, а не бросают). */
export interface GitBranchOpResult {
  success?: boolean
  error?: string
  output?: string
  /** checkout: итоговое локальное имя ветки (для remote — без префикса remote). */
  branch?: string
  /** checkout: true — локальная ветка создана из удалённой. */
  created?: boolean
  /** refreshBranches: true — fetch не запускался (rate limit / уже идёт). */
  skipped?: boolean
}

/**
 * Подмножество `window.syntee.git`, которое использует хук.
 * `refreshBranches` обязателен и типизирован: это ЕДИНСТВЕННЫЙ путь обновления
 * удалённых веток (main-side `fetch --all --prune` с дедупом и rate limit).
 * Остальные методы опциональны — их отсутствие даёт понятную ошибку.
 */
export interface GitBranchBridge {
  branchList?: (workdir: string, all?: boolean) => Promise<unknown>
  checkout?: (params: { workdir: string; branch: string; remote?: boolean }) => Promise<unknown>
  branchCreate?: (params: { workdir: string; branch: string; checkout?: boolean }) => Promise<unknown>
  /** main-side `fetch --all --prune` с дедупом по .git и rate limit. */
  refreshBranches: (workdir: string) => Promise<GitBranchOpResult>
}

/** Пока панель открыта — как часто перечитываем список локальных веток. */
export const LOCAL_POLL_MS = 15_000
/** Пока панель открыта — как часто просим remote-fetch (main всё равно троттлит). */
export const REMOTE_POLL_MS = 5 * 60_000
/** Не дёргаем remote чаще этого, даже если панель переоткрыли несколько раз. */
export const REMOTE_MIN_INTERVAL_MS = 20_000

const EMPTY_STATE: GitBranchesState = Object.freeze({
  branches: [] as GitBranchRef[],
  current: null,
  loading: false,
  error: null,
  remoteError: null,
  lastLoadedAt: null,
  lastRemoteAt: null,
})

interface Entry {
  workdir: string
  state: GitBranchesState
  listeners: Set<() => void>
  /** Сколько хуков считают этот workdir «открытым» (polling включается на 0→1). */
  activeHooks: number
  inflight: Promise<void> | null
  inflightRemote: Promise<void> | null
  /** Монотонный счётчик запросов чтения: ответ с устаревшим seq отбрасывается. */
  readSeq: number
  /** Счётчик мутаций: чтение, начатое ДО мутации, не имеет права перезаписать состояние. */
  mutationSeq: number
  localTimer: ReturnType<typeof setInterval> | null
  remoteTimer: ReturnType<typeof setInterval> | null
}

const entries = new Map<string, Entry>()

function errorText(e: unknown): string {
  if (e instanceof Error && e.message) return e.message
  const text = String((e as { message?: unknown })?.message ?? e ?? '')
  return text || 'Unknown git error'
}

function normalizeWorkdir(workdir: string | null | undefined): string {
  if (typeof workdir !== 'string') return ''
  const trimmed = workdir.trim()
  if (!trimmed) return ''
  // Один и тот же каталог не должен давать два разных стора.
  return trimmed.replace(/[\\/]+$/, '') || trimmed
}

function ensureEntry(key: string): Entry {
  let entry = entries.get(key)
  if (!entry) {
    entry = {
      workdir: key,
      state: EMPTY_STATE,
      listeners: new Set(),
      activeHooks: 0,
      inflight: null,
      inflightRemote: null,
      readSeq: 0,
      mutationSeq: 0,
      localTimer: null,
      remoteTimer: null,
    }
    entries.set(key, entry)
  }
  return entry
}

function patch(entry: Entry, partial: Partial<GitBranchesState>): void {
  const next: GitBranchesState = { ...entry.state, ...partial }
  entry.state = next
  for (const listener of entry.listeners) listener()
}

function getBridge(): GitBranchBridge {
  const scope = typeof window === 'undefined' ? undefined : (window as unknown as { syntee?: { git?: GitBranchBridge } })
  const git = scope?.syntee?.git
  if (!git) throw new Error('git bridge is unavailable (window.syntee.git)')
  return git
}

/**
 * `git:branchList` с all=true отдаёт объекты { name, current, remote }, но
 * старый main (и часть панелей) — строки. Принимаем оба вида и убираем дубли.
 */
export function normalizeBranches(raw: unknown, current: string | null): GitBranchRef[] {
  if (!Array.isArray(raw)) return []
  const out: GitBranchRef[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    let ref: GitBranchRef | null = null
    if (typeof item === 'string') {
      ref = { name: item, current: item === current, remote: false }
    } else if (item && typeof item === 'object') {
      const rec = item as { name?: unknown; current?: unknown; remote?: unknown }
      const name = typeof rec.name === 'string' ? rec.name : ''
      if (name) {
        const remote = rec.remote === true
        ref = { name, current: !remote && (rec.current === true || name === current), remote }
      }
    }
    if (!ref || !ref.name) continue
    const key = `${ref.remote ? 'remote' : 'local'}:${ref.name}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}

/**
 * Локальное имя для переключения на удалённую ветку: `origin/feature/x` →
 * `feature/x`. `git checkout feature/x` создаст локальную ветку с tracking,
 * а `git checkout origin/feature/x` увёл бы в detached HEAD — этого избегаем.
 */
export function localNameForRemote(branches: GitBranchRef[], branch: string): string {
  const name = String(branch ?? '').trim()
  if (!name) return name
  // Разбор имени удалённой ветки — в shared (та же функция, что у main для
  // `--track -b`): origin/feat/x, remotes/origin/feat/x, refs/remotes/... → feat/x.
  // Свой split('/') здесь терял совпадение с main на полных refs.
  // Срезаем префикс только у ЗАВЕДОМО удалённой ветки: иначе локальное имя со
  // слэшем (`feat/x`, которого нет в списке) превратилось бы в `x`.
  const isKnownRemote = branches.some(b => b.remote && b.name === name)
  const isRemoteRef = name.startsWith('refs/remotes/') || name.startsWith('remotes/')
  if (!isKnownRemote && !isRemoteRef) return name
  const parts = parseRemoteBranchName(name)
  return parts ? parts.branch : name
}

/**
 * Чтение списка веток. Дедуплицируется по workdir; force=true запускает новое
 * чтение, а ответ предыдущего отбрасывается (guard по readSeq/mutationSeq).
 */
function readBranches(entry: Entry, opts: { force?: boolean } = {}): Promise<void> {
  if (entry.inflight && !opts.force) return entry.inflight

  const seq = ++entry.readSeq
  const mutationAt = entry.mutationSeq
  if (!entry.state.loading) patch(entry, { loading: true, error: null })

  const run = async (): Promise<void> => {
    try {
      const bridge = getBridge()
      if (typeof bridge.branchList !== 'function') throw new Error('git.branchList is unavailable')
      const res = await bridge.branchList(entry.workdir, true)
      // Пока ждали — случилась мутация или более новый запрос: ответ устарел.
      if (entry.readSeq !== seq || entry.mutationSeq !== mutationAt) return
      const result = (res ?? {}) as { success?: boolean; branches?: unknown; current?: string | null; error?: string }
      if (result.success === false) {
        // Данные НЕ чистим: старый список полезнее пустого экрана.
        patch(entry, { loading: false, error: result.error ?? 'Failed to read branches' })
        return
      }
      const current = typeof result.current === 'string' ? result.current : null
      patch(entry, {
        branches: normalizeBranches(result.branches, current),
        current,
        loading: false,
        error: null,
        lastLoadedAt: Date.now(),
      })
    } catch (e) {
      if (entry.readSeq !== seq) return
      patch(entry, { loading: false, error: errorText(e) })
    }
  }

  const task = run()
  const tracked = task.finally(() => {
    if (entry.inflight === tracked) entry.inflight = null
  })
  entry.inflight = tracked
  return tracked
}

/**
 * Remote-fetch (обновляет refs/remotes/*) + перечитывание списка.
 * Только `refreshBranches` (main-side, с троттлингом и дедупом) — второго пути
 * через `git.fetch` нет, чтобы не было двух конкурирующих fetch.
 * Ошибка только выставляет remoteError.
 */
function refreshRemote(entry: Entry, opts: { force?: boolean } = {}): Promise<void> {
  if (!opts.force) {
    const last = entry.state.lastRemoteAt
    if (last && Date.now() - last < REMOTE_MIN_INTERVAL_MS) return Promise.resolve()
  }
  if (entry.inflightRemote) return entry.inflightRemote

  const run = async (): Promise<void> => {
    try {
      const bridge = getBridge()
      if (typeof bridge.refreshBranches !== 'function') {
        throw new Error('git.refreshBranches is unavailable in this build')
      }
      const result = (await bridge.refreshBranches(entry.workdir) ?? {}) as GitBranchOpResult
      if (result.success === false) {
        patch(entry, { remoteError: result.error ?? 'Failed to fetch remote branches' })
        return
      }
      // main пропустил fetch (rate limit / уже идёт): refs не менялись, читать
      // заново незачем — только запоминаем время, чтобы не дёргать его снова.
      patch(entry, { remoteError: null, lastRemoteAt: Date.now() })
      if (result.skipped === true) return
      // refs изменились — список (в т.ч. remote) нужно перечитать.
      await readBranches(entry, { force: true })
    } catch (e) {
      patch(entry, { remoteError: errorText(e) })
    }
  }

  const task = run()
  const tracked = task.finally(() => {
    if (entry.inflightRemote === tracked) entry.inflightRemote = null
  })
  entry.inflightRemote = tracked
  return tracked
}

function startPolling(entry: Entry): void {
  // Таймер уже идёт — второй подписчик НЕ перезапускает его: иначе каждое
  // открытие ещё одной панели сбрасывало бы расписание опроса.
  if (entry.localTimer !== null && entry.remoteTimer !== null) return
  stopPolling(entry)
  // Интервал — без force: если чтение ещё в полёте, оно дедуплицируется, а не
  // запускает параллельный git (раньше поллинг плодил лишние процессы).
  entry.localTimer = setInterval(() => { void readBranches(entry, { force: false }) }, LOCAL_POLL_MS)
  entry.remoteTimer = setInterval(() => { void refreshRemote(entry, { force: false }) }, REMOTE_POLL_MS)
}

function stopPolling(entry: Entry): void {
  if (entry.localTimer !== null) { clearInterval(entry.localTimer); entry.localTimer = null }
  if (entry.remoteTimer !== null) { clearInterval(entry.remoteTimer); entry.remoteTimer = null }
}

/**
 * Выполняет git-мутацию: инвалидирует текущее чтение, после завершения (успех
 * ИЛИ ошибка) перечитывает список, чтобы обновились все подписчики.
 * Ошибку пробрасывает вызывающему (UI показывает тост).
 */
async function runMutation(
  entry: Entry,
  label: string,
  fn: () => Promise<unknown>,
): Promise<GitBranchOpResult> {
  entry.mutationSeq += 1
  entry.readSeq += 1 // чтение, начатое до мутации, уже неактуально
  try {
    const res = await fn()
    const result = (res ?? {}) as GitBranchOpResult
    if (result.success === false) throw new Error(result.error ?? `${label} failed`)
    return result
  } finally {
    void readBranches(entry, { force: true })
  }
}

/**
 * Оптимистично помечаем ветку текущей — переключение видно сразу, до ответа git.
 * `current` — всегда ЛОКАЛЬНАЯ ветка: удалённую строку (например `origin/dev`
 * при совпадении короткого имени) текущей НЕ помечаем, иначе галка переезжала
 * на origin-строку, а `current` расходился с реальным HEAD.
 */
function applyOptimisticCurrent(entry: Entry, branch: string): void {
  const name = String(branch ?? '').trim()
  if (!name) return
  const list = entry.state.branches
  if (list.some(b => b.remote && b.name === name)) return // пришло имя удалённой — не наше дело
  if (list.length === 0) {
    patch(entry, { current: name })
    return
  }
  patch(entry, {
    branches: list.map(b => {
      const next = !b.remote && b.name === name
      return b.current === next ? b : { ...b, current: next }
    }),
    current: name,
  })
}

function subscribeEntry(key: string, listener: () => void): () => void {
  const entry = ensureEntry(key)
  entry.listeners.add(listener)
  return () => { entry.listeners.delete(listener) }
}

/** Императивное обновление стора извне React (например после внешней git-операции). */
export function refreshGitBranches(workdir: string | null | undefined, opts: { force?: boolean } = {}): Promise<void> {
  const key = normalizeWorkdir(workdir)
  if (!key) return Promise.resolve()
  return readBranches(ensureEntry(key), { force: opts.force !== false })
}

/** Текущее состояние стора без подписки (для тостов/отладки). */
export function getGitBranchesState(workdir: string | null | undefined): GitBranchesState {
  const key = normalizeWorkdir(workdir)
  return key ? ensureEntry(key).state : EMPTY_STATE
}

export interface UseGitBranchesResult {
  branches: GitBranchRef[]
  current: string | null
  loading: boolean
  error: string | null
  remoteError: string | null
  lastLoadedAt: number | null
  lastRemoteAt: number | null
  /** Перечитать список (force по умолчанию — ручной refresh не дедуплицируется). */
  refresh: (opts?: { force?: boolean }) => Promise<void>
  /** `git fetch` + перечитать список. */
  refreshRemote: (opts?: { force?: boolean }) => Promise<void>
  /** Переключить ветку; `remote: true` — на удалённую (локальное имя с tracking). */
  checkout: (input: { branch: string; remote?: boolean } | string) => Promise<void>
  /** Создать ветку (по умолчанию сразу переключиться). */
  createBranch: (name: string, opts?: { checkout?: boolean }) => Promise<void>
}

const getServerSnapshot = (): GitBranchesState => EMPTY_STATE

export function useGitBranches(
  workdir: string | null | undefined,
  active = false,
): UseGitBranchesResult {
  const key = normalizeWorkdir(workdir)

  const subscribe = useCallback(
    (listener: () => void) => (key ? subscribeEntry(key, listener) : () => {}),
    [key],
  )
  const getSnapshot = useCallback(
    () => (key ? ensureEntry(key).state : EMPTY_STATE),
    [key],
  )

  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  // Первое чтение на mount/смену workdir — даже если панель закрыта (чип «Обзор»
  // показывает ветку в свёрнутом виде). Дедуплицируется с активным опросом.
  useEffect(() => {
    if (!key) return
    void readBranches(ensureEntry(key), { force: false })
  }, [key])

  // Пока панель открыта: опрос + remote-fetch (при открытии и далее по таймеру).
  useEffect(() => {
    if (!key || !active) return
    const entry = ensureEntry(key)
    entry.activeHooks += 1
    void readBranches(entry, { force: false })
    void refreshRemote(entry, { force: false })
    startPolling(entry)
    return () => {
      entry.activeHooks = Math.max(0, entry.activeHooks - 1)
      if (entry.activeHooks === 0) stopPolling(entry)
    }
  }, [key, active])

  const refresh = useCallback(
    async (opts?: { force?: boolean }): Promise<void> => {
      if (!key) return
      await readBranches(ensureEntry(key), { force: opts?.force !== false })
    },
    [key],
  )

  const refreshRemoteBranches = useCallback(
    async (opts?: { force?: boolean }): Promise<void> => {
      if (!key) return
      await refreshRemote(ensureEntry(key), { force: opts?.force !== false })
    },
    [key],
  )

  const checkout = useCallback(
    async (input: { branch: string; remote?: boolean } | string): Promise<void> => {
      if (!key) throw new Error('workdir is required')
      const branch = (typeof input === 'string' ? input : input?.branch ?? '').trim()
      if (!branch) throw new Error('branch is required')
      const remote = typeof input === 'string' ? false : input?.remote === true
      const entry = ensureEntry(key)
      const bridge = getBridge()
      if (typeof bridge.checkout !== 'function') throw new Error('git.checkout is unavailable')
      // Имя отдаём как есть: main сам разбирает `origin/x` / `refs/remotes/...`
      // (planCheckout) и для remote делает `--track -b`, поэтому detached HEAD
      // не будет. В ответе приходит итоговое ЛОКАЛЬНОЕ имя ветки.
      const result = await runMutation(entry, 'checkout', () =>
        bridge.checkout!({ workdir: entry.workdir, branch, remote }),
      )
      // Ответ main — истина (итоговое локальное имя). Fallback считаем сами
      // ТОЛЬКО для удалённой ветки: для локальной имя уже локальное, и снимать
      // с него «префикс remote» было бы подменой (`feat/x` → `x`).
      const landed = typeof result.branch === 'string' && result.branch
        ? result.branch
        : remote ? localNameForRemote(entry.state.branches, branch) : branch
      applyOptimisticCurrent(entry, landed)
    },
    [key],
  )

  const createBranch = useCallback(
    async (name: string, opts?: { checkout?: boolean }): Promise<void> => {
      if (!key) throw new Error('workdir is required')
      const branch = String(name ?? '').trim()
      if (!branch) throw new Error('branch name is required')
      const entry = ensureEntry(key)
      const bridge = getBridge()
      if (typeof bridge.branchCreate !== 'function') throw new Error('git.branchCreate is unavailable')
      const withCheckout = opts?.checkout !== false
      await runMutation(entry, 'branchCreate', () => bridge.branchCreate!({ workdir: entry.workdir, branch, checkout: withCheckout }))
      if (withCheckout) applyOptimisticCurrent(entry, branch)
    },
    [key],
  )

  // Без ручного useMemo: React Compiler мемоизирует сам, а ручная зависимость
  // от `state` ломала его вывод (react-hooks/preserve-manual-memoization).
  return {
    branches: state.branches,
    current: state.current,
    loading: state.loading,
    error: state.error,
    remoteError: state.remoteError,
    lastLoadedAt: state.lastLoadedAt,
    lastRemoteAt: state.lastRemoteAt,
    refresh,
    refreshRemote: refreshRemoteBranches,
    checkout,
    createBranch,
  }
}
