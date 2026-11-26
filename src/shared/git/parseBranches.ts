/**
 * Парсер вывода `git branch --list --all --format=…`.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫМ МОДУЛЕМ: здесь был реальный баг. git выравнивает колонки
 * пробелами, поэтому TAB стоит не в начале строки, а после «*» или пробела-
 * заполнителя. Старый код делал line.trim() — у всех веток КРОМЕ текущей
 * ведущий пробел исчезал вместе с TAB, split('\t') давал 2 части вместо 3, и
 * ветки молча выпадали. В шапке чата (GitTools) был виден только текущий бранч,
 * хотя правая панель (GitPanel) читает другой режим и показывала всё.
 *
 * Формат строки (первая колонка — «*» или пробел, затем TAB):
 *   "*\trefs/heads/dev\tdev\t"
 *   " \trefs/heads/master\tmaster\t"
 * Режем по ПЕРВОМУ TAB, без trim: иначе заполнители съедаются.
 *
 * ПОЧЕМУ `%(refname:lstrip=2)`, А НЕ `%(refname:short)`: short-имя
 * дизамбигуируется и перестаёт быть именем ветки. Если в репозитории есть
 * локальная ветка `origin/feat` и одноимённая удалённая, git печатает
 * `heads/origin/feat` и `remotes/origin/feat`, а алиас `refs/remotes/origin/HEAD`
 * превращается просто в `origin` — и в списке появлялась фантомная ветка
 * «origin». lstrip=2 всегда даёт ровно имя без префикса пространства имён
 * (heads/… или remotes/…), а алиасы/псевдо-ветки отсекаем ниже.
 *
 * ПОЧЕМУ ФИЛЬТР ПО refname: в detached HEAD `git branch --all` печатает
 * псевдо-запись `(HEAD detached at 1a2b3c)` с маркером `*`. Старый парсер
 * добавлял её в список как обычную ветку — и переключение на неё гарантированно
 * ломалось. Настоящие ветки всегда лежат в refs/heads/ или refs/remotes/.
 */

export interface BranchRef {
  /** Имя как в git без пространства имён: dev, origin/dev. */
  name: string
  current: boolean
  remote: boolean
}

export interface ParsedBranches {
  branches: BranchRef[]
  current: string | null
}

/** `--format` для всех веток: HEAD-маркер, полный ref, имя, symref-алиас. */
export const BRANCH_LIST_ALL_FORMAT = '%(HEAD)%09%(refname)%09%(refname:lstrip=2)%09%(symref)'
/** `--format` для локальных веток (те же колонки без symref). */
export const BRANCH_LIST_LOCAL_FORMAT = '%(HEAD)%09%(refname)%09%(refname:lstrip=2)'

export const BRANCH_LIST_ALL_ARGS = ['branch', '--list', '--all', `--format=${BRANCH_LIST_ALL_FORMAT}`]
export const BRANCH_LIST_LOCAL_ARGS = ['branch', '--list', `--format=${BRANCH_LIST_LOCAL_FORMAT}`]

const HEADS_PREFIX = 'refs/heads/'
const REMOTES_PREFIX = 'refs/remotes/'

interface RawBranchRow {
  head: boolean
  full: string
  name: string
  symref: string
}

/**
 * Одна строка вывода. Поддерживает и новый 4-колоночный формат, и старый
 * 3-колоночный (refname:short) — на случай уже закэшированных вызовов/старых git.
 */
function readRow(rawLine: string): RawBranchRow | null {
  const line = String(rawLine ?? '').replace(/\r$/, '')
  if (!line.trim()) return null

  const firstTab = line.indexOf('\t')
  if (firstTab < 0) return null
  const head = line.slice(0, firstTab).includes('*')
  const cols = line.slice(firstTab + 1).split('\t')
  // Без двух колонок (refname + имя) строка бесполезна.
  if (cols.length < 2) return null

  return {
    head,
    full: (cols[0] ?? '').trim(),
    name: (cols[1] ?? '').trim(),
    symref: (cols[2] ?? '').trim(),
  }
}

/** Настоящая ли это ветка: только heads/remotes, не symref-алиас и не псевдо-запись. */
function isRealBranch(row: RawBranchRow): boolean {
  if (!row.full || !row.name) return false
  if (row.symref) return false
  if (!row.full.startsWith(HEADS_PREFIX) && !row.full.startsWith(REMOTES_PREFIX)) return false
  // refs/remotes/origin/HEAD — алиас на дефолтную ветку, в списке только мешает.
  // Проверяем ПОЛНЫЙ ref: в коротком формате имя алиаса выглядит как «origin»,
  // и по имени его не отличить от настоящей ветки.
  if (row.full.startsWith(REMOTES_PREFIX) && row.full.endsWith('/HEAD')) return false
  return true
}

export function parseBranchList(stdout: string): ParsedBranches {
  const branches: BranchRef[] = []
  let current: string | null = null

  for (const rawLine of String(stdout ?? '').split('\n')) {
    const row = readRow(rawLine)
    if (!row || !isRealBranch(row)) continue

    if (row.head) current = row.name
    branches.push({ name: row.name, current: row.head, remote: row.full.startsWith(REMOTES_PREFIX) })
  }

  return { branches, current }
}

/**
 * Только локальные ветки (режим без `--all`): массив имён + текущая.
 * Псевдо-запись detached HEAD отфильтрована так же, как в parseBranchList.
 */
export function parseLocalBranchList(stdout: string): { branches: string[]; current: string | null } {
  const branches: string[] = []
  let current: string | null = null

  for (const rawLine of String(stdout ?? '').split('\n')) {
    const row = readRow(rawLine)
    if (!row || row.symref || !row.full.startsWith(HEADS_PREFIX) || !row.name) continue

    if (row.head) current = row.name
    branches.push(row.name)
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
