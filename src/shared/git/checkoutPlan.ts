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

/**
 * Аргументы для `git checkout`. `--` отсекает двусмысленность: имя вида
 * `feature/x` никогда не будет принято за путь к файлу.
 */
export function buildCheckoutArgs(branch: string): string[] {
  return ['checkout', branch.trim(), '--']
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
