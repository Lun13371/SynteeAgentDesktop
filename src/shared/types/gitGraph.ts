/**
 * Типы графа коммитов. Живут в shared, потому что их отдают main (git/graph.ts)
 * и потребляет renderer (окно «Git Graph») — без дублирования структур.
 */
export type GitGraphRefKind = 'head' | 'branch' | 'remote' | 'tag'

export interface GitGraphRef {
  /** Короткое имя для чипа: `dev`, `origin/dev`, `v1.1.4`, `HEAD`. */
  name: string
  kind: GitGraphRefKind
}

export interface GitGraphCommit {
  hash: string
  shortHash: string
  parents: string[]
  author: string
  /** YYYY-MM-DD */
  date: string
  subject: string
  refs: GitGraphRef[]
  /** Дорожка, на которой стоит точка коммита. */
  lane: number
  /** Занятость дорожек в строке ВЫШЕ коммита. */
  before: boolean[]
  /** Занятость дорожек в строке НИЖЕ коммита. */
  after: boolean[]
  /** Дорожки, которые вливаются в этот коммит (горизонталь сверху в lane). */
  mergeLanes: number[]
  /** Дорожки, куда уходят родители (горизонталь из lane вниз). */
  parentLanes: number[]
}

export interface GitGraphResult {
  commits: GitGraphCommit[]
  /** Сколько дорожек нужно, чтобы посчитать ширину графа. */
  maxLanes: number
}
