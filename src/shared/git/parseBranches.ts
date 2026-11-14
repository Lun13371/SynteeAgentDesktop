/**
 * Парсер вывода `git branch --list --all --format=%(HEAD)%09%(refname)%09%(refname:short)`.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫМ МОДУЛЕМ: здесь был реальный баг. git выравнивает колонки
 * пробелами, поэтому TAB стоит не в начале строки, а после «*» или пробела-
 * заполнителя. Старый код делал line.trim() — у всех веток КРОМЕ текущей
 * ведущий пробел исчезал вместе с TAB, split('\t') давал 2 части вместо 3, и
 * ветки молча выпадали. В шапке чата (GitTools) был виден только текущий бранч,
 * хотя правая панель (GitPanel) читает другой режим и показывала всё.
 *
 * Формат строки (первая колонка — «*» или пробел, затем TAB):
 *   "*\trefs/heads/dev\tdev"
 *   " \trefs/heads/master\tmaster"
 * Режем по ПЕРВОМУ TAB, без trim: иначе заполнители съедаются.
 */

export interface BranchRef {
  /** Имя как в git (refname:short): dev, origin/dev. */
  name: string
  current: boolean
  remote: boolean
}

export interface ParsedBranches {
  branches: BranchRef[]
  current: string | null
}

export function parseBranchList(stdout: string): ParsedBranches {
  const branches: BranchRef[] = []
  let current: string | null = null

  for (const rawLine of String(stdout ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line.trim()) continue

    const firstTab = line.indexOf('\t')
    if (firstTab < 0) continue
    const head = line.slice(0, firstTab)
    const refs = line.slice(firstTab + 1).split('\t')
    // Без двух колонок (refname + refname:short) строка бесполезна.
    if (refs.length < 2) continue

    const full = (refs[0] ?? '').trim()
    const name = (refs[1] ?? '').trim()
    // refs/remotes/origin/HEAD — алиас на дефолтную ветку, в списке только мешает.
    if (!name || name.endsWith('/HEAD') || full.endsWith('/HEAD')) continue

    const isCurrent = head.includes('*')
    if (isCurrent) current = name

    branches.push({ name, current: isCurrent, remote: full.startsWith('refs/remotes/') })
  }

  return { branches, current }
}

/**
 * Только локальные ветки — то, между чем реально переключаются.
 * origin/* в списке не нужны: они помечены remote, а переключение по ним
 * уводит в detached HEAD. Фильтр здесь, чтобы UI не дублировал условие.
 */
export function localBranchesOnly<T extends { remote?: boolean }>(branches: T[]): T[] {
  return branches.filter(b => !b.remote)
}
