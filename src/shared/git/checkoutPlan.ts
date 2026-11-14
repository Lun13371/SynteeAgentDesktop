/**
 * Переключение ветки с сохранением незакоммиченных правок.
 *
 * Проблема: `git checkout <branch>` падает с
 *   "Your local changes to the following files would be overwritten by checkout"
 * каждый раз, когда в рабочем дереве есть правки (а в этом приложении их почти
 * всегда есть — агент правит файлы). Для пользователя это выглядит как «панель
 * не переключает ветки», хотя git ведёт себя штатно.
 *
 * Решение: stash → checkout → (при ошибке) вернуть правки. Если для целевой
 * ветки нет локального трека, checkout делается с --track/созданием из remote,
 * чтобы не улетать в detached HEAD.
 *
 * Модуль намеренно чистый от electron: логика тестируется без IPC.
 */

export interface CheckoutStep {
  args: string[]
}

export interface CheckoutPlan {
  /** Команды по порядку; выполнять до первой ошибки. */
  steps: CheckoutStep[]
  /** Что делать, если шаг с этим индексом упал: true — попытаться вернуть правки. */
  restoreOnFailureAt: number[]
}

/**
 * Строит последовательность git-команд для переключения.
 *
 * @param branch целевая ветка (короткое имя: dev, feature/x)
 * @param ctx    сведения о репозитории
 */
export function buildCheckoutPlan(
  branch: string,
  ctx: { localBranches: string[]; remoteBranches: string[]; dirty: boolean },
): CheckoutPlan {
  const target = branch.trim()
  const local = new Set(ctx.localBranches)
  const remoteShort = new Set(ctx.remoteBranches.map(r => r.split('/').slice(1).join('/')))

  const steps: CheckoutStep[] = []

  // 1. Прячем правки, чтобы checkout не наткнулся на них.
  if (ctx.dirty) steps.push({ args: ['stash', 'push', '--include-untracked', '-m', 'syntee: авто-stash перед сменой ветки'] })

  // 2. Само переключение.
  if (local.has(target)) {
    steps.push({ args: ['checkout', target] })
  } else if (remoteShort.has(target)) {
    // Локальной нет, но есть remote-трек → создаём локальную с трекингом.
    steps.push({ args: ['checkout', '--track', `origin/${target}`] })
  } else {
    // Имени нет нигде — пусть git попробует сам (может быть тегом/хэшем).
    steps.push({ args: ['checkout', target] })
  }

  // 3. Возвращаем спрятанные правки. stash pop на другой ветке может конфликтовать —
  //    тогда правки остаются в stash (потерять их нельзя), а не смешиваются молча.
  if (ctx.dirty) steps.push({ args: ['stash', 'pop'] })

  return { steps, restoreOnFailureAt: ctx.dirty ? [1] : [] }
}

/**
 * Человеческая причина падения checkout: git сыплет многострочный список файлов,
 * в тосте это нечитаемо. Достаём суть.
 */
export function explainCheckoutError(raw: string): string {
  const text = String(raw ?? '')
  if (/would be overwritten by checkout/i.test(text)) {
    return 'Есть незакоммиченные правки конфликтующих файлов — закоммить или спрячь их, затем повтори'
  }
  if (/Your local changes to the following files would be overwritten/i.test(text)) {
    return 'Есть незакоммиченные правки конфликтующих файлов — закоммить или спрячь их, затем повтори'
  }
  if (/already checked out at/i.test(text)) {
    return 'Эта ветка уже используется в другом worktree'
  }
  if (/did not match any file\(s\) known to git|not a valid object name/i.test(text)) {
    return 'Ветки не существует'
  }
  if (/You have unstaged changes|Please commit your changes or stash them/i.test(text)) {
    return 'Есть незакоммиченные изменения — закоммить или спрячь их'
  }
  if (/CONFLICT|would be overwritten by merge/i.test(text)) {
    return 'Правки из stash конфликтуют с целевой веткой — они сохранены в stash, разбери вручную'
  }
  // Не распознали — отдаём первую осмысленную строку, без дампа git-вывода.
  const line = text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('error:'))
  return line || text.trim() || 'Не удалось переключить ветку'
}
