import { join } from 'path'
import { runGit } from './runGit'

/**
 * Фоновое обновление удалённых веток: `git fetch --all --prune`.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ: fetch дёргают несколько мест (панель Git, граф
 * коммитов, чип «Обзор»), и без дедупликации одно открытие панели давало
 * 2–3 параллельных fetch в один и тот же репозиторий. На медленной сети они
 * ещё и складывались по таймауту, а UI всё это время показывал старые ветки.
 *
 * Правила:
 *  - ключ дедупликации — ОБЩИЙ git-каталог (`--git-common-dir`), а не workdir:
 *    worktree'ы суб-агентов делят objects/refs с основным деревом, и fetch из
 *    каждого worktree — это тот же самый fetch;
 *  - пока fetch в полёте, повторные вызовы получают тот же промис;
 *  - после успешного/неуспешного fetch интервал minIntervalMs: чаще нет смысла
 *    (git сам не ходит на сервер чаще, а UI опрашивает сводку каждые 12 с);
 *  - никогда не бросает: фоновая операция не должна ронять IPC-хендлер.
 */

export interface BranchRefreshResult {
  success: boolean
  error?: string
  /** true — fetch не запускался (rate limit или уже идёт): данные прежние. */
  skipped?: boolean
}

export interface BranchRefresherDeps {
  run: (
    workdir: string,
    args: string[],
    options?: { timeoutMs?: number; env?: Record<string, string> },
  ) => Promise<string>
  now?: () => number
  minIntervalMs?: number
  fetchTimeoutMs?: number
}

export interface BranchRefresher {
  refresh: (workdir: string) => Promise<BranchRefreshResult>
  /** Сбросить состояние (тесты/смена настроек). */
  reset: () => void
}

const DEFAULT_MIN_INTERVAL_MS = 15_000
const DEFAULT_FETCH_TIMEOUT_MS = 30_000
const RESOLVE_TIMEOUT_MS = 5_000

/**
 * Никакой интерактивности: иначе git в фоне ждёт логин/пароль или подтверждение
 * host key в невидимом терминале, пока IPC-вызов не упадёт по таймауту.
 * GIT_TERMINAL_PROMPT=0 уже стоит в runGit, здесь — остальные «спрашиватели».
 */
const NONINTERACTIVE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  SSH_ASKPASS_REQUIRE: 'never',
}

interface RepoRefreshState {
  inflight: Promise<BranchRefreshResult> | null
  lastStartedAt: number
  lastResult: BranchRefreshResult
}

/** Пути git приходят в разном виде (C:\x vs C:/x) — сводим к одному ключу. */
function normalizeRepoKey(value: string): string {
  const normalized = String(value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function createBranchRefresher(deps: BranchRefresherDeps): BranchRefresher {
  const now = deps.now ?? (() => Date.now())
  const minIntervalMs = deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  const fetchTimeoutMs = deps.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  const repos = new Map<string, RepoRefreshState>()

  async function resolveRepoKey(workdir: string): Promise<string> {
    // --path-format=absolute есть с git 2.31; на старом git падает — тогда
    // склеиваем относительный путь сами (он всегда относительно workdir).
    try {
      const out = await deps.run(workdir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { timeoutMs: RESOLVE_TIMEOUT_MS })
      const value = out.trim()
      if (value) return normalizeRepoKey(value)
    } catch { /* старый git или не репозиторий */ }
    try {
      const out = await deps.run(workdir, ['rev-parse', '--git-common-dir'], { timeoutMs: RESOLVE_TIMEOUT_MS })
      const value = out.trim()
      if (value) return normalizeRepoKey(value.startsWith('.') ? join(workdir, value) : value)
    } catch { /* не репозиторий — ключ по workdir */ }
    return normalizeRepoKey(workdir)
  }

  async function refresh(workdir: string): Promise<BranchRefreshResult> {
    if (!workdir) return { success: false, error: 'workdir is required' }

    const key = await resolveRepoKey(workdir)
    const state = repos.get(key) ?? { inflight: null, lastStartedAt: 0, lastResult: { success: true, skipped: true } }
    repos.set(key, state)

    // Уже идёт — отдаём тот же промис: один fetch на репозиторий.
    if (state.inflight) return state.inflight

    const startedAt = now()
    if (state.lastStartedAt > 0 && startedAt - state.lastStartedAt < minIntervalMs) {
      return { ...state.lastResult, skipped: true }
    }
    state.lastStartedAt = startedAt

    const task = (async (): Promise<BranchRefreshResult> => {
      try {
        await deps.run(workdir, ['fetch', '--all', '--prune'], {
          timeoutMs: fetchTimeoutMs,
          env: NONINTERACTIVE_ENV,
        })
        return { success: true }
      } catch (e) {
        return { success: false, error: String((e as Error)?.message ?? e) }
      }
    })()

    state.inflight = task
    try {
      const result = await task
      state.lastResult = result
      return result
    } finally {
      state.inflight = null
    }
  }

  return { refresh, reset: () => repos.clear() }
}

let defaultRefresher: BranchRefresher | null = null

/** Общий экземпляр для IPC: дедупликация/rate limit на весь main-процесс. */
export function getBranchRefresher(): BranchRefresher {
  if (!defaultRefresher) {
    defaultRefresher = createBranchRefresher({
      run: (workdir, args, options) => runGit(workdir, args, options),
    })
  }
  return defaultRefresher
}

export function refreshBranches(workdir: string): Promise<BranchRefreshResult> {
  return getBranchRefresher().refresh(workdir)
}
