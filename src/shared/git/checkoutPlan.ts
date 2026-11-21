/**
 * Переключение ветки — обычное, как в VS Code: один `git checkout <branch>`.
 *
 * РАНЬШЕ здесь был авто-stash (stash push → checkout → stash pop). Идея была
 * «спасти правки», но на практике это ломалось: `stash push --include-untracked`
 * падал на большом дереве (таймаут 8 с) или на служебных untracked-каталогах,
 * а пользователь получал сырое «Command failed: git … stash push -m » и ветка
 * не переключалась. Ровно то, чего не должно быть: переключение веток обязано
 * работать всегда и мгновенно.
 *
 * Теперь — как в VS Code / git из консоли: git сам сохраняет НЕконфликтующие
 * правки при checkout и отказывает только если конкретные файлы конфликтуют с
 * целевой веткой. В этом случае показываем понятную причину (см.
 * explainCheckoutError), а правки остаются нетронутыми в рабочем дереве.
 */

const HEADS_PREFIX = 'refs/heads/'
const REMOTES_PREFIX = 'refs/remotes/'
// Символы, запрещённые git в именах веток (см. git-check-ref-format).
// Контрольные проверяем кодами, а не regexp-классом: \x00-\x1f в литерале
// regexp ловит линтер (no-control-regex), а смысл тот же.
const FORBIDDEN_IN_REF = /[\s~^:?*[\\]/

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/**
 * Аргументы для `git checkout`. `--` отсекает двусмысленность: имя вида
 * `feature/x` никогда не будет принято за путь к файлу.
 *
 * Полные refs (`refs/heads/dev`) принимаем, но переключаемся по короткому имени:
 * `git checkout refs/heads/dev` уводит в detached HEAD, а это ровно тот баг,
 * из-за которого в списке не было локальных веток после переключения.
 */
export function buildCheckoutArgs(branch: string): string[] {
  return ['checkout', normalizeLocalBranchName(branch), '--']
}

/** `refs/heads/dev` → `dev`; остальное без изменений. */
export function normalizeLocalBranchName(input: string): string {
  const value = String(input ?? '').trim()
  return value.startsWith(HEADS_PREFIX) ? value.slice(HEADS_PREFIX.length) : value
}

/**
 * Проверка имени ветки. Нужна не для красоты: имя уходит в argv git, поэтому
 * `-D` или `--orphan` без проверки стали бы опцией, а не веткой.
 */
export function isValidBranchName(input: string): boolean {
  const value = String(input ?? '').trim()
  if (!value || value === '@') return false
  if (value.startsWith('-')) return false
  if (value.includes('..') || value.includes('@{')) return false
  if (value.startsWith('/') || value.endsWith('/') || value.includes('//')) return false
  if (value.endsWith('.') || value.endsWith('.lock')) return false
  if (FORBIDDEN_IN_REF.test(value) || hasControlChar(value)) return false
  return value.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'))
}

export interface RemoteBranchParts {
  /** Имя remote: origin. */
  remote: string
  /** Имя ветки на remote без префикса remote: feat/x. */
  branch: string
  /** Полный ref для git: refs/remotes/origin/feat/x. */
  remoteRef: string
}

/**
 * Разбор имени удалённой ветки. Принимаем все три формы, которые может
 * прислать UI/агент, и всегда возвращаем полный ref + чистое имя ветки:
 *   refs/remotes/origin/feat/x → { origin, feat/x, refs/remotes/origin/feat/x }
 *   remotes/origin/feat/x      → то же
 *   origin/feat/x              → то же
 * Без этой нормализации `git checkout origin/feat/x` даёт detached HEAD,
 * а `git checkout -b x origin/feat/x` с полным refs/remotes/… уже работает.
 */
export function parseRemoteBranchName(input: string): RemoteBranchParts | null {
  let value = String(input ?? '').trim()
  if (value.startsWith(REMOTES_PREFIX)) value = value.slice(REMOTES_PREFIX.length)
  else if (value.startsWith('remotes/')) value = value.slice('remotes/'.length)
  value = value.replace(/\/+$/, '')
  if (!value) return null

  const slash = value.indexOf('/')
  if (slash <= 0) return null
  const remote = value.slice(0, slash)
  const branch = value.slice(slash + 1)
  if (!branch || branch === 'HEAD') return null
  if (!isValidBranchName(remote) || !isValidBranchName(branch)) return null
  return { remote, branch, remoteRef: `${REMOTES_PREFIX}${remote}/${branch}` }
}

/** Аргументы переключения на удалённую ветку с созданием локальной tracking-ветки. */
export function buildRemoteCheckoutArgs(remoteRef: string, localBranch: string): string[] {
  return ['checkout', '--track', '-b', normalizeLocalBranchName(localBranch), String(remoteRef ?? '').trim(), '--']
}

export interface CheckoutPlan {
  /** Готовые аргументы `git checkout`. */
  args: string[]
  /** Локальное имя ветки, на которой окажется HEAD после переключения. */
  localBranch: string
  /** Полный ref удалённой ветки, если переключаемся по удалённой. */
  remoteRef?: string
}

export type CheckoutPlanResult = { ok: true; plan: CheckoutPlan } | { ok: false; error: string }

/**
 * План переключения. Для удалённой ветки ВСЕГДА создаём локальную
 * (`--track -b`), а не `git checkout origin/x` — иначе detached HEAD.
 * Существование локальной ветки проверяет вызывающий (main), чтобы вместо
 * пересоздания просто переключиться на неё и не потерять её коммиты.
 */
export function planCheckout(params: { branch: string; remote?: boolean }): CheckoutPlanResult {
  const raw = String(params?.branch ?? '')
  if (params?.remote) {
    const parts = parseRemoteBranchName(raw)
    if (!parts) return { ok: false, error: 'Некорректное имя удалённой ветки' }
    return {
      ok: true,
      plan: {
        args: buildRemoteCheckoutArgs(parts.remoteRef, parts.branch),
        localBranch: parts.branch,
        remoteRef: parts.remoteRef,
      },
    }
  }

  const local = normalizeLocalBranchName(raw)
  if (!isValidBranchName(local)) return { ok: false, error: 'Некорректное имя ветки' }
  return { ok: true, plan: { args: buildCheckoutArgs(local), localBranch: local } }
}

/**
 * Человеческая причина отказа: git сыплет многострочный список файлов, в тосте
 * это нечитаемо. Достаём суть, сохраняя имя первого конфликтующего файла —
 * по нему понятно, о чём речь.
 */
export function explainCheckoutError(raw: string): string {
  const text = String(raw ?? '')

  const overwrite = text.match(
    /local changes to the following files would be overwritten by checkout:\s*\n\s*([^\n]+)/i,
  )
  if (overwrite) {
    const file = overwrite[1].trim()
    return `Файл ${file} изменён локально и конфликтует с этой веткой — закоммить или спрячь правки, затем повтори`
  }
  if (/would be overwritten by checkout/i.test(text)) {
    return 'Есть незакоммиченные правки конфликтующих файлов — закоммить или спрячь их, затем повтори'
  }
  if (/already checked out at/i.test(text)) {
    return 'Эта ветка уже используется в другом worktree'
  }
  if (/invalid reference|did not match any file\(s\) known to git|not a valid object name/i.test(text)) {
    return 'Ветки не существует'
  }
  if (/You have unstaged changes|Please commit your changes or stash them/i.test(text)) {
    return 'Есть незакоммиченные изменения — закоммить или спрячь их'
  }
  if (/CONFLICT|would be overwritten by merge/i.test(text)) {
    return 'Конфликт правок с целевой веткой — разбери вручную'
  }
  if (/Unable to create|index\.lock/i.test(text)) {
    return 'Git занят другим процессом — повтори через пару секунд'
  }
  // Не распознали — первая осмысленная строка без дампа многострочного вывода.
  const line = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('Command failed') && !l.startsWith('error:') && !l.startsWith('fatal:'))
    .find(Boolean)
  return line || 'Не удалось переключить ветку'
}
