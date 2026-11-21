import { runGit } from './runGit'
import {
  buildRemoteCheckoutArgs,
  explainCheckoutError,
  isValidBranchName,
  parseRemoteBranchName,
  planCheckout,
  type RemoteBranchParts,
} from '../../shared/git/checkoutPlan'

/**
 * Переключение ветки (в т.ч. на удалённую).
 *
 * ПОЧЕМУ НЕ `git checkout origin/feat`: git создаёт detached HEAD, и следующая
 * же сводка показывает «ветку» вида `(HEAD detached at 1a2b3c)`, а коммиты
 * уходят в никуда. Поэтому для удалённой ветки — `git checkout --track -b <x>
 * refs/remotes/origin/x`, то есть локальная ветка с upstream.
 *
 * ПОЧЕМУ НЕ `-B`/`-f`: локальная ветка с тем же именем могла уже существовать
 * со своими коммитами. Тогда просто переключаемся на неё (`git checkout x`) —
 * ничего не перезаписываем и не теряем.
 *
 * ПОЧЕМУ ПРОВЕРЯЕМ refs/heads ПЕРЕД checkout: `git checkout <name>` — это не
 * branch-only. Если локальную ветку удалили (а список в UI остался старым) и
 * имя теперь принадлежит ТЕГУ, git молча переключит на коммит тега, то есть в
 * detached HEAD — ровно тот баг, от которого уходим. Проверка refs/heads даёт
 * семантику `git switch --no-guess`: переключаемся только на существующую
 * ветку, иначе понятная ошибка и HEAD на месте.
 */

export interface CheckoutResult {
  success: boolean
  error?: string
  output?: string
  /** Ветка, на которой окажется HEAD (для remote — без префикса remote). */
  branch?: string
  /** true — локальная ветка создана из удалённой. */
  created?: boolean
}

async function refExists(workdir: string, ref: string): Promise<boolean> {
  try {
    await runGit(workdir, ['rev-parse', '--verify', '--quiet', ref])
    return true
  } catch {
    return false
  }
}

/** Настроенные remote'ы репозитория (origin, upstream, …). */
async function listRemotes(workdir: string): Promise<string[]> {
  try {
    const out = await runGit(workdir, ['remote'])
    return out.split('\n').map(line => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Разбор цели для удалённой ветки. UI и агент присылают имя в любом виде:
 *   refs/remotes/origin/feat/x, remotes/origin/feat/x, origin/feat/x — полное;
 *   feat/x, dev — ОБЫЧНОЕ имя ветки без префикса remote.
 * Полное имя разбирает shared parseRemoteBranchName, но для обычного имени он
 * принял бы первый сегмент за remote (`feat/x` → remote «feat») — поэтому
 * проверяем первый сегмент по реальным remote'ам, а иначе ищем
 * refs/remotes/<remote>/<name>.
 */
async function resolveRemoteTarget(workdir: string, input: string): Promise<RemoteBranchParts | null> {
  const remotes = await listRemotes(workdir)
  const parsed = parseRemoteBranchName(input)
  if (parsed && (remotes.length === 0 || remotes.includes(parsed.remote))) return parsed

  const branch = String(input ?? '')
    .trim()
    .replace(/^refs\/remotes\//, '')
    .replace(/^remotes\//, '')
    .replace(/\/+$/, '')
  if (!branch || !isValidBranchName(branch)) return null

  for (const remote of remotes) {
    const remoteRef = `refs/remotes/${remote}/${branch}`
    if (await refExists(workdir, `${remoteRef}^{commit}`)) return { remote, branch, remoteRef }
  }

  // Ни у одного remote такой ветки нет: отдаём правдоподобный ref, чтобы ниже
  // получилось честное «ветки не существует», а не «некорректное имя».
  const fallback = parsed?.remote ?? remotes[0]
  if (!fallback) return null
  return { remote: fallback, branch, remoteRef: `refs/remotes/${fallback}/${branch}` }
}

export async function checkoutBranch(
  workdir: string,
  params: { branch: string; remote?: boolean },
): Promise<CheckoutResult> {
  if (!workdir) return { success: false, error: 'workdir is required' }
  if (!params?.branch) return { success: false, error: 'branch is required' }

  try {
    if (params.remote) {
      const target = await resolveRemoteTarget(workdir, params.branch)
      if (!target) return { success: false, error: 'Некорректное имя удалённой ветки' }
      // Ветку могли удалить на сервере между fetch и кликом — говорим прямо.
      if (!(await refExists(workdir, `${target.remoteRef}^{commit}`))) {
        return { success: false, error: 'Удалённой ветки не существует — обновите список' }
      }
      if (await refExists(workdir, `refs/heads/${target.branch}`)) {
        const out = await runGit(workdir, ['switch', '--no-guess', '--', target.branch])
        return { success: true, output: out, branch: target.branch, created: false }
      }
      const out = await runGit(workdir, buildRemoteCheckoutArgs(target.remoteRef, target.branch))
      return { success: true, output: out, branch: target.branch, created: true }
    }

    const planned = planCheckout({ branch: params.branch })
    if (!planned.ok) return { success: false, error: planned.error }
    const { localBranch } = planned.plan
    // Branch-only: имени нет в refs/heads (удалено/переименовано, а список
    // устарел) — не даём git уйти в detached HEAD по тегу с тем же именем.
    if (!(await refExists(workdir, `refs/heads/${localBranch}`))) {
      return { success: false, error: 'Ветки не существует — обновите список' }
    }
    const out = await runGit(workdir, ['switch', '--no-guess', '--', localBranch])
    return { success: true, output: out, branch: localBranch }
  } catch (e) {
    return { success: false, error: explainCheckoutError(String((e as Error)?.message ?? e)) }
  }
}
