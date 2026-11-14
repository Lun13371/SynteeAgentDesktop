/**
 * Граф коммитов для окна «Git Graph».
 *
 * Два источника:
 *  1. `git log --all --topo-order --parents` — коммиты и их родители;
 *  2. `git for-each-ref` — ветки/теги/удалённые ветки для чипов справа от описания.
 *
 * Раскладка дорожек (lanes) — как в gitk: массив дорожек, каждая хранит хеш
 * коммита, который на ней ожидается следующим. Коммит занимает дорожку, где его
 * ждали (или свободную/новую), первый родитель наследует его дорожку, остальные
 * родители (merge) занимают уже существующую дорожку с этим хешем либо
 * вставляют новую сразу справа.
 *
 * Рендерер алгоритмом не занимается: на каждую строку отдаём before/after
 * (занятость дорожек сверху и снизу) плюс mergeLanes/parentLanes для
 * горизонтальных соединителей. Поэтому вставка дорожки на merge-строке не
 * ломает вертикальные линии выше и ниже.
 */
import { runGit } from './runGit'
import type { GitGraphCommit, GitGraphRef, GitGraphRefKind, GitGraphResult } from '../../shared/types/gitGraph'

export type { GitGraphCommit, GitGraphRef, GitGraphRefKind, GitGraphResult }

const REF_PRIORITY: Record<GitGraphRefKind, number> = { head: 0, branch: 1, remote: 2, tag: 3 }

function classifyRef(full: string, isHead: boolean): GitGraphRefKind {
  if (isHead) return 'head'
  if (full.startsWith('refs/heads/')) return 'branch'
  if (full.startsWith('refs/remotes/')) return 'remote'
  return 'tag'
}

/**
 * Карта hash → чипы. HEAD-указатель ставим отдельным чипом на коммит, куда
 * смотрит HEAD (для detached — на сам хеш из `rev-parse HEAD`).
 */
async function readRefs(workdir: string): Promise<Map<string, GitGraphRef[]>> {
  const map = new Map<string, GitGraphRef[]>()
  const push = (hash: string, ref: GitGraphRef): void => {
    const list = map.get(hash)
    if (list) list.push(ref)
    else map.set(hash, [ref])
  }

  const [refsOut, headHash] = await Promise.all([
    runGit(workdir, ['for-each-ref', '--format=%(refname)%09%(refname:short)%09%(objectname)%09%(HEAD)']).catch(() => ''),
    runGit(workdir, ['rev-parse', 'HEAD']).then(s => s.trim()).catch(() => ''),
  ])

  for (const line of refsOut.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [full, short, hash, head] = trimmed.split('\t')
    if (!full || !hash) continue
    push(hash, { name: short || full, kind: classifyRef(full, head === '*') })
  }

  if (headHash) {
    const existing = map.get(headHash) ?? []
    // Текущая ветка уже помечена как head — второй чип HEAD не нужен,
    // но при detached HEAD его нет вовсе, поэтому добавляем явно.
    if (!existing.some(r => r.kind === 'head')) push(headHash, { name: 'HEAD', kind: 'head' })
    else existing.sort((a, b) => REF_PRIORITY[a.kind] - REF_PRIORITY[b.kind])
  }

  for (const list of map.values()) {
    list.sort((a, b) => REF_PRIORITY[a.kind] - REF_PRIORITY[b.kind] || a.name.localeCompare(b.name))
  }
  return map
}

interface RawCommit {
  hash: string
  parents: string[]
  author: string
  date: string
  subject: string
}

function parseLog(raw: string): RawCommit[] {
  const out: RawCommit[] = []
  for (const record of raw.split('\x1e')) {
    const line = record.trim()
    if (!line) continue
    const [hash, parents, author, date, ...subjectParts] = line.split('\x1f')
    if (!hash) continue
    out.push({
      hash,
      parents: (parents ?? '').split(' ').filter(Boolean),
      author: author ?? '',
      date: date ?? '',
      subject: subjectParts.join('\x1f'),
    })
  }
  return out
}

/**
 * Раскладка дорожек. Возвращает коммиты с координатами + максимальную ширину.
 */
export function layoutLanes(commits: RawCommit[], refs: Map<string, GitGraphRef[]>): GitGraphResult {
  /** lanes[i] — хеш, который на дорожке i ожидается следующим (null — свободна). */
  const lanes: Array<string | null> = []
  let maxLanes = 1
  const rows: GitGraphCommit[] = []

  for (const c of commits) {
    const beforeArr = lanes.slice()
    const incoming: number[] = []
    for (let i = 0; i < beforeArr.length; i++) if (beforeArr[i] === c.hash) incoming.push(i)

    let lane: number
    if (incoming.length > 0) {
      lane = incoming[0]
    } else {
      // Тип ветки, у которого нет потомков в отданном диапазоне лога:
      // занимаем свободную дорожку или добавляем новую.
      const free = beforeArr.indexOf(null)
      lane = free >= 0 ? free : beforeArr.length
    }

    const next = beforeArr.slice()
    if (lane >= next.length) next.length = lane + 1

    // Все дорожки, которые ждали этот коммит, освобождаем.
    for (const i of incoming) next[i] = null
    // Первый родитель продолжает дорожку коммита (или она закрывается).
    next[lane] = c.parents[0] ?? null

    const parentLanes: number[] = []
    if (c.parents[0]) parentLanes.push(lane)
    for (const p of c.parents.slice(1)) {
      const existing = next.findIndex((h, i) => h === p && i !== lane)
      if (existing >= 0) {
        parentLanes.push(existing)
      } else {
        next.splice(lane + 1, 0, p)
        parentLanes.push(lane + 1)
      }
    }

    // Хвостовые null не рисуем, но дорожки не удаляем — индексы должны совпадать.
    while (next.length > 0 && next[next.length - 1] === null && next.length > lane + 1) next.pop()

    const width = Math.max(beforeArr.length, next.length, lane + 1)
    maxLanes = Math.max(maxLanes, width)

    rows.push({
      hash: c.hash,
      shortHash: c.hash.slice(0, 7),
      parents: c.parents,
      author: c.author,
      date: c.date,
      subject: c.subject,
      refs: refs.get(c.hash) ?? [],
      lane,
      before: Array.from({ length: width }, (_, i) => beforeArr[i] != null),
      after: Array.from({ length: width }, (_, i) => next[i] != null),
      mergeLanes: incoming.filter(i => i !== lane),
      parentLanes: parentLanes.filter(i => i !== lane),
    })

    // Синхронизируем реальный массив дорожек с посчитанным состоянием.
    lanes.length = next.length
    for (let i = 0; i < next.length; i++) lanes[i] = next[i]
  }

  return { commits: rows, maxLanes }
}

export async function readGraph(workdir: string, limit = 200): Promise<GitGraphResult> {
  const max = Math.min(Math.max(limit || 200, 20), 500)
  const [logOut, refs] = await Promise.all([
    runGit(workdir, [
      'log', '--all', '--topo-order', '--date=short',
      `--max-count=${max}`,
      '--format=%x1e%H%x1f%P%x1f%an%x1f%ad%x1f%s',
    ]),
    readRefs(workdir),
  ])
  return layoutLanes(parseLog(logOut), refs)
}
