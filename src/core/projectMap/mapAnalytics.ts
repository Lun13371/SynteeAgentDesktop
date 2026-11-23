/**
 * mapAnalytics — аналитика поверх готового графа кода.
 *
 * Всё считается из code_map_* в памяти: рёбра уже резолвнуты парсером, поэтому
 * здесь только обход графа, без чтения файлов.
 *
 *  - godNodes      — degree centrality (ядро архитектуры, «куда смотреть первым»);
 *  - communities   — Louvain (local moving) по calls/imports/references → подсистемы;
 *  - findPath      — кратчайший путь A→B с уверенностью по слабейшему ребру;
 *  - affected      — обратная достижимость: что заденет правка узла/файла.
 *
 * Уверенность рёбер: resolved = 1, heuristic = 0.6, ambiguous = 0.25.
 * external (внешние пакеты) в аналитику не входит — это не код проекта.
 */
import * as store from './mapStore'
import type { CodeMapNode, CodeMapEdge, CodeEdgeType, CodeEdgePrecision } from '../../shared/projectMap'

const GRAPH_EDGE_LIMIT = 120_000
/** getGraph в store ограничивает выборку 20k узлов — держим тот же потолок. */
const MAX_NODES = 20_000

export interface GraphSnapshot {
  nodes: Map<string, CodeMapNode>
  /** Смежность в обе стороны (для path/communities). */
  undirected: Map<string, Array<{ id: string; type: CodeEdgeType; precision: CodeEdgePrecision; w: number }>>
  /** Только входящие calls/references/imports (для affected/god). */
  incoming: Map<string, Array<{ id: string; type: CodeEdgeType; precision: CodeEdgePrecision }>>
  /** Только исходящие calls/references/imports (для god fan-out). */
  outgoing: Map<string, Array<{ id: string; type: CodeEdgeType; precision: CodeEdgePrecision }>>
  /**
   * `contains` (файл → символы). В path/god НЕ участвует (иначе путь «через
   * файл» связывал бы любые два символа одного файла), но нужен сообществам:
   * без него 4058 символов без calls/imports висели одиночками.
   */
  contains: Map<string, string[]>
  edges: number
  coverage: { nodesTruncated: boolean; edgesTruncated: boolean }
  builtAt: number
}

export interface GodNode {
  node: CodeMapNode
  /** Входящие calls/references/imports. */
  fanIn: number
  /** Исходящие calls/references/imports. */
  fanOut: number
  degree: number
}

export interface Community {
  id: number
  size: number
  /** Детерминированная метка: топ-3 символа по fan-in внутри сообщества. */
  label: string
  /** Доминирующий каталог (по числу файлов). */
  topDir: string
  topNodes: Array<{ name: string; filePath: string; fanIn: number }>
}

export interface PathHop {
  node: CodeMapNode | null
  edge: CodeMapEdge | null
  type: CodeEdgeType | null
  precision: CodeEdgePrecision | null
}

const PRECISION_WEIGHT: Record<CodeEdgePrecision, number> = {
  resolved: 1,
  heuristic: 0.6,
  ambiguous: 0.25,
  external: 0.1,
}

const ANALYTICS_TYPES: CodeEdgeType[] = ['calls', 'references', 'imports']

// ─── Кэш снапшота графа ──────────────────────────────────────────────────────

const snapshotCache = new Map<string, GraphSnapshot>()

/** Инвалидировать кэш (после пересборки/инкремента). */
export function invalidateAnalytics(projectId: string): void {
  snapshotCache.delete(projectId)
}

export function getSnapshot(projectId: string): GraphSnapshot {
  const cached = snapshotCache.get(projectId)
  if (cached) return cached

  // Один дополнительный ряд отличает усечённую выборку от ровно заполненной.
  // Читаем отдельно: getGraph также загрузил бы ненужный второй набор рёбер.
  const nodeRows = store.listNodes(projectId, MAX_NODES + 1)
  const nodesTruncated = nodeRows.length > MAX_NODES
  if (nodesTruncated) nodeRows.pop()
  const nodes = new Map<string, CodeMapNode>()
  for (const n of nodeRows) nodes.set(n.id, n)

  const edges = store.listAnalysisEdges(projectId, GRAPH_EDGE_LIMIT + 1, [...ANALYTICS_TYPES, 'contains'])
  const edgesTruncated = edges.length > GRAPH_EDGE_LIMIT
  if (edgesTruncated) edges.pop()

  const undirected = new Map<string, Array<{ id: string; type: CodeEdgeType; precision: CodeEdgePrecision; w: number }>>()
  const incoming = new Map<string, Array<{ id: string; type: CodeEdgeType; precision: CodeEdgePrecision }>>()
  const outgoing = new Map<string, Array<{ id: string; type: CodeEdgeType; precision: CodeEdgePrecision }>>()
  const push = <T>(map: Map<string, T[]>, key: string, value: T): void => {
    const list = map.get(key)
    if (list) list.push(value)
    else map.set(key, [value])
  }
  const contains = new Map<string, string[]>()
  for (const e of edges) {
    if (!nodes.has(e.fromNode) || !nodes.has(e.toNode)) continue
    if (e.type === 'contains') {
      // Файл → его символы: участвует ТОЛЬКО в сообществах (с малым весом).
      push(contains, e.fromNode, e.toNode)
      continue
    }
    if (e.precision === 'external') continue
    const w = PRECISION_WEIGHT[e.precision] ?? 0.5
    push(undirected, e.fromNode, { id: e.toNode, type: e.type, precision: e.precision, w })
    push(undirected, e.toNode, { id: e.fromNode, type: e.type, precision: e.precision, w })
    push(incoming, e.toNode, { id: e.fromNode, type: e.type, precision: e.precision })
    push(outgoing, e.fromNode, { id: e.toNode, type: e.type, precision: e.precision })
  }

  const snapshot: GraphSnapshot = {
    nodes, undirected, incoming, outgoing, contains, edges: edges.length,
    coverage: { nodesTruncated, edgesTruncated }, builtAt: Date.now(),
  }
  snapshotCache.set(projectId, snapshot)
  return snapshot
}

/** Только сниппет-адъяцентность для быстрых проверок «есть ли вообще связи». */
export function isProjectCodeNode(node: CodeMapNode): boolean {
  return node.kind !== 'package'
}

// ─── God nodes ───────────────────────────────────────────────────────────────

/**
 * Мусорные имена: JS/TS builtins, JSON-ключи и общие слова, вокруг которых
 * копятся heuristic-рёбра («все push проекта → мок в тесте»). Без фильтра
 * top-degree заполняется `push`/`map`/`set`/`get` — идея фильтра взята из
 * graphify (`_BUILTIN_NOISE_LABELS` / `_JSON_NOISE_LABELS`), список адаптирован
 * под JS/TS.
 */
const NOISE_NAMES = new Set([
  'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'map', 'filter', 'reduce',
  'forEach', 'some', 'every', 'find', 'findIndex', 'sort', 'reverse', 'concat', 'join', 'split',
  'trim', 'replace', 'includes', 'indexOf', 'keys', 'values', 'entries', 'length',
  'toString', 'valueOf', 'then', 'catch', 'finally', 'apply', 'call', 'bind',
  'next', 'done', 'ok', 'error', 'result', 'data', 'item', 'items', 'list', 'tool',
  'name', 'id', 'type', 'value', 'key', 'text', 'title', 'description', 'version',
  'start', 'end', 'properties', 'dependencies', 'devdependencies', 'props', 'state',
  'log', 'warn', 'emit', 'on', 'off', 'once', 'all', 'any', 'self', 'this',
  // идиомы worker/IPC и тестовых заглушек — в метках подсистем бесполезны
  'postmessage', 'send', 'current', 'live', 'miss', 'tools', 'fetch', 'json',
])

/** Специфичное ли имя: не builtin, не JSON-ключ, не однобуквенное. */
function isMeaningfulName(name: string): boolean {
  if (!name || name.length < 4) return false
  return !NOISE_NAMES.has(name.toLowerCase())
}

/**
 * Годится ли узел в «лицо» подсистемы: осмысленное имя, не приватное поле
 * (`_cache`, `_buffer`) и не тестовый мок. Без этого метки выглядели как
 * «postMessage · send · current» или «_buffer · _buildingProjects · _cache».
 */
function isLabelCandidate(node: CodeMapNode): boolean {
  if (node.kind === 'file' || node.kind === 'package') return false
  if (node.name.startsWith('_')) return false
  if (!isMeaningfulName(node.name)) return false
  return !isTestPath(node.filePath)
}

/**
 * Тестовый/скриптовый файл: в них моки (`push`, `resolve`, `test`) набирают
 * сотни heuristic-рёбер и вытесняют реальные хабы из god-рейтинга.
 * Не исключаем совсем (иногда проект — это тесты), а понижаем вес в 2.5 раза:
 * хаб из прод-кода всегда выше мока с сопоставимой связностью.
 */
function isTestPath(filePath: string): boolean {
  return /(^|\/)(tests?|scripts|__tests__|__mocks__|fixtures)\//.test(filePath) ||
    /\.(test|spec)\.[a-z]+$/i.test(filePath)
}

/**
 * God nodes — узлы с максимальным ВЗВЕШЕННЫМ degree по calls/references/imports.
 * Вес ребра = точность резолвинга: resolved 1, heuristic 0.6, ambiguous 0.25.
 * Это важнее количества: 500 heuristic-рёбер не делают узел ядром архитектуры.
 * Файлы, внешние пакеты и generic-имена исключены.
 */
export function godNodes(projectId: string, limit = 12): GodNode[] {
  const snap = getSnapshot(projectId)
  const w = (p: CodeEdgePrecision): number => PRECISION_WEIGHT[p] ?? 0.5
  const out: GodNode[] = []
  for (const [id, node] of snap.nodes) {
    if (node.kind === 'package' || node.kind === 'file') continue
    if (!isMeaningfulName(node.name)) continue
    const ins = snap.incoming.get(id) ?? []
    const outs = snap.outgoing.get(id) ?? []
    const fanIn = ins.length
    const fanOut = outs.length
    if (fanIn < 2 && fanOut < 2) continue
    let score = 0
    for (const e of ins) score += w(e.precision)
    for (const e of outs) score += w(e.precision)
    if (isTestPath(node.filePath)) score *= 0.4
    out.push({ node, fanIn, fanOut, degree: Math.round(score * 10) / 10 })
  }
  out.sort((a, b) => b.degree - a.degree || b.fanIn - a.fanIn || a.node.name.localeCompare(b.node.name))
  return out.slice(0, limit)
}

// ─── Communities (Louvain, local moving) ─────────────────────────────────────

interface CommunityCache { key: string; communities: Community[]; assignment: Map<string, number> }
const communityCache = new Map<string, CommunityCache>()

/**
 * Louvain, фаза local moving: каждый узел переезжает в сообщество соседа,
 * пока растёт модульность. Детерминированно (порядок по id), без внешних
 * зависимостей. Для подсистем этого достаточно — дальше только метки.
 */
export function computeCommunities(projectId: string): { communities: Community[]; assignment: Map<string, number> } {
  const snap = getSnapshot(projectId)
  const key = `${snap.nodes.size}:${snap.edges}:${Math.floor(snap.builtAt / 60_000)}`
  const cached = communityCache.get(projectId)
  if (cached && cached.key === key) return { communities: cached.communities, assignment: cached.assignment }

  const ids = [...snap.nodes.keys()].sort()
  const index = new Map<string, number>()
  ids.forEach((id, i) => index.set(id, i))
  const n = ids.length
  const communities = new Int32Array(n)
  for (let i = 0; i < n; i++) communities[i] = i

  // Взвешенная смежность в индексах + степени k_i и полный вес графа (2m).
  const adj: Array<Array<{ j: number; w: number }>> = Array.from({ length: n }, () => [])
  const k = new Float64Array(n)
  let totalW = 0
  for (const [id, list] of snap.undirected) {
    const i = index.get(id)
    if (i == null) continue
    for (const e of list) {
      const j = index.get(e.id)
      if (j == null || i === j) continue
      adj[i].push({ j, w: e.w })
      k[i] += e.w
      totalW += e.w
    }
  }
  // `contains` (файл → символы) с малым весом: символы без calls/imports
  // прилипают к своему файлу, а не висят одиночками (их было 4058 из 9490).
  // Вес мал, чтобы реальные вызовы по-прежнему определяли границы подсистемы.
  const CONTAINS_W = 0.15
  for (const [fileId, members] of snap.contains) {
    const fi = index.get(fileId)
    if (fi == null) continue
    for (const memberId of members) {
      const mi = index.get(memberId)
      if (mi == null || mi === fi) continue
      adj[fi].push({ j: mi, w: CONTAINS_W })
      adj[mi].push({ j: fi, w: CONTAINS_W })
      k[fi] += CONTAINS_W
      k[mi] += CONTAINS_W
      totalW += CONTAINS_W * 2
    }
  }
  const nodeCommunity = new Int32Array(n)
  nodeCommunity.set(communities)
  // Σtot(C) — сумма степеней узлов сообщества. Классическая ΔQ-формула
  // (Blondel et al.): gain(i→C) = w_i→C − k_i · Σtot(C) / 2m.
  // Без члена Σtot большие сообщества не притягивают узлы, и граф рассыпается
  // на тысячи одиночек (наблюдали 4744 кластера на 9490 узлов).
  const totC = new Float64Array(n)
  for (let i = 0; i < n; i++) totC[i] = k[i]

  const passes = 12
  for (let pass = 0; pass < passes; pass++) {
    let moved = false
    for (let i = 0; i < n; i++) {
      if (adj[i].length === 0 || totalW <= 0) continue
      const current = nodeCommunity[i]
      const weights = new Map<number, number>()
      for (const e of adj[i]) {
        const c = nodeCommunity[e.j]
        weights.set(c, (weights.get(c) ?? 0) + e.w)
      }
      const gainOf = (c: number, wToC: number): number => wToC - (k[i] * totC[c]) / totalW
      let best = current
      let bestGain = gainOf(current, weights.get(current) ?? 0)
      for (const [c, wToC] of weights) {
        if (c === current) continue
        const gain = gainOf(c, wToC)
        if (gain > bestGain + 1e-9) { bestGain = gain; best = c }
      }
      if (best !== current) {
        totC[current] -= k[i]
        totC[best] += k[i]
        nodeCommunity[i] = best
        moved = true
      }
    }
    if (!moved) break
  }

  // Перенумеровать сообщества по размеру (крупные — первые).
  const sizeByCommunity = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    sizeByCommunity.set(nodeCommunity[i], (sizeByCommunity.get(nodeCommunity[i]) ?? 0) + 1)
  }
  const ordered = [...sizeByCommunity.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c)
  const remap = new Map<number, number>()
  ordered.forEach((c, i) => remap.set(c, i))

  const assignment = new Map<string, number>()
  const members = new Map<number, CodeMapNode[]>()
  for (let i = 0; i < n; i++) {
    const cid = remap.get(nodeCommunity[i]) ?? 0
    assignment.set(ids[i], cid)
    const node = snap.nodes.get(ids[i])
    if (!node) continue
    const list = members.get(cid)
    if (list) list.push(node)
    else members.set(cid, [node])
  }

  const result: Community[] = []
  for (const [cid, nodes] of [...members.entries()].sort((a, b) => a[0] - b[0])) {
    // Топ-узлы по fan-in внутри сообщества — детерминированная метка без LLM.
    // В метку идут только узлы с РЕАЛЬНЫМ fan-in: иначе подсистема называлась
    // «_buffer · _buildingProjects · _cache» (приватные поля с нулевой связностью,
    // отсортированные по алфавиту). Нет сигнала — метим по каталогу.
    const rankedAll = nodes
      .filter(isLabelCandidate)
      .map(nd => ({ node: nd, fanIn: snap.incoming.get(nd.id)?.length ?? 0 }))
      .sort((a, b) => b.fanIn - a.fanIn || a.node.name.localeCompare(b.node.name))
    const ranked = rankedAll.filter(r => r.fanIn > 0).slice(0, 3)
    const dirCount = new Map<string, number>()
    for (const nd of nodes) {
      const dir = nd.filePath.includes('/') ? nd.filePath.slice(0, nd.filePath.lastIndexOf('/')) : ''
      if (dir) dirCount.set(dir, (dirCount.get(dir) ?? 0) + 1)
    }
    const topDir = [...dirCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
    const labelNodes = ranked.length > 0 ? ranked : rankedAll.slice(0, 3)
    const label = labelNodes.length > 0
      ? labelNodes.map(r => r.node.name).join(' · ')
      : (topDir || `cluster ${cid}`)
    result.push({
      id: cid,
      size: nodes.length,
      label,
      topDir,
      topNodes: labelNodes.map(r => ({ name: r.node.name, filePath: r.node.filePath, fanIn: r.fanIn })),
    })
  }

  communityCache.set(projectId, { key, communities: result, assignment })
  return { communities: result, assignment }
}

// ─── Shortest path ───────────────────────────────────────────────────────────

export interface PathResult {
  found: boolean
  hops: PathHop[]
  /** Уверенность пути = минимум по рёбрам. */
  confidence: number
  weakest: CodeEdgePrecision | null
}

/**
 * Кратчайший путь между двумя узлами (BFS по ненаправленным calls/references/
 * imports). Возвращает сам путь и «слабое звено» — где карта не уверена.
 */
export function findPath(
  projectId: string,
  fromId: string,
  toId: string,
  opts: { maxDepth?: number; relations?: CodeEdgeType[] } = {},
): PathResult {
  const snap = getSnapshot(projectId)
  const maxDepth = Math.max(1, Math.min(opts.maxDepth ?? 6, 12))
  const types = opts.relations && opts.relations.length > 0 ? new Set(opts.relations) : new Set(ANALYTICS_TYPES)
  if (!snap.nodes.has(fromId) || !snap.nodes.has(toId)) return { found: false, hops: [], confidence: 0, weakest: null }
  if (fromId === toId) return { found: true, hops: [{ node: snap.nodes.get(fromId) ?? null, edge: null, type: null, precision: null }], confidence: 1, weakest: null }

  const prev = new Map<string, { via: string; type: CodeEdgeType; precision: CodeEdgePrecision }>()
  const visited = new Set<string>([fromId])
  let frontier: string[] = [fromId]

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = []
    for (const id of frontier) {
      const links = snap.undirected.get(id) ?? []
      for (const link of links) {
        if (!types.has(link.type) || visited.has(link.id)) continue
        visited.add(link.id)
        prev.set(link.id, { via: id, type: link.type, precision: link.precision })
        if (link.id === toId) {
          return buildPath(snap, fromId, toId, prev)
        }
        next.push(link.id)
      }
    }
    frontier = next
  }
  return { found: false, hops: [], confidence: 0, weakest: null }
}

function buildPath(
  snap: GraphSnapshot,
  fromId: string,
  toId: string,
  prev: Map<string, { via: string; type: CodeEdgeType; precision: CodeEdgePrecision }>,
): PathResult {
  const chain: string[] = [toId]
  let cursor = toId
  for (;;) {
    const step = prev.get(cursor)
    if (!step) break
    chain.push(step.via)
    if (step.via === fromId) break
    cursor = step.via
  }
  chain.reverse()

  const hops: PathHop[] = []
  let confidence = 1
  let weakest: CodeEdgePrecision | null = null
  for (let i = 0; i < chain.length; i++) {
    const node = snap.nodes.get(chain[i]) ?? null
    if (i === 0) {
      hops.push({ node, edge: null, type: null, precision: null })
      continue
    }
    const step = prev.get(chain[i])
    if (!step) continue
    const w = PRECISION_WEIGHT[step.precision] ?? 0.5
    if (w < confidence) { confidence = w; weakest = step.precision }
    hops.push({
      node,
      edge: {
        id: `${chain[i - 1]}|${step.type}|${chain[i]}|0`,
        projectId: '',
        fromNode: chain[i - 1],
        toNode: chain[i],
        type: step.type,
        precision: step.precision,
        filePath: node?.filePath ?? '',
        line: 0,
      },
      type: step.type,
      precision: step.precision,
    })
  }
  return { found: chain[0] === fromId, hops, confidence, weakest }
}

// ─── Affected (impact) ───────────────────────────────────────────────────────

export interface AffectedResult {
  root: CodeMapNode | null
  results: Array<{ node: CodeMapNode; depth: number; via: CodeEdgeType }>
  byFile: Array<{ filePath: string; count: number }>
}

/**
 * Обратная достижимость: кто зависит от узла (прямо и транзитивно) в пределах
 * depth. Отвечает на «что сломается, если поправить это».
 * Для файла — начинаем со всех его символов.
 */
export function affectedNodes(
  projectId: string,
  nodeId: string,
  opts: { depth?: number; relations?: CodeEdgeType[]; limit?: number } = {},
): AffectedResult {
  const snap = getSnapshot(projectId)
  const depthCap = Math.max(1, Math.min(opts.depth ?? 3, 8))
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000))
  const types = opts.relations && opts.relations.length > 0 ? new Set(opts.relations) : new Set(ANALYTICS_TYPES)

  const root = snap.nodes.get(nodeId) ?? null
  const seeds = root && root.kind === 'file'
    ? [...snap.nodes.values()].filter(n => n.filePath === root.filePath && n.kind !== 'file' && n.kind !== 'package').map(n => n.id)
    : [nodeId]

  const seen = new Map<string, { depth: number; via: CodeEdgeType }>()
  let frontier = seeds.slice()
  for (const id of frontier) seen.set(id, { depth: 0, via: 'calls' })
  let depth = 0
  while (depth < depthCap && frontier.length > 0 && seen.size < limit) {
    depth++
    const next: string[] = []
    for (const id of frontier) {
      for (const inc of snap.incoming.get(id) ?? []) {
        if (!types.has(inc.type) || seen.has(inc.id)) continue
        const node = snap.nodes.get(inc.id)
        if (!node || node.kind === 'package') continue
        seen.set(inc.id, { depth, via: inc.type })
        next.push(inc.id)
        if (seen.size >= limit) break
      }
      if (seen.size >= limit) break
    }
    frontier = next
  }

  const results: AffectedResult['results'] = []
  const fileCount = new Map<string, number>()
  for (const [id, meta] of seen) {
    if (seeds.includes(id)) continue
    const node = snap.nodes.get(id)
    if (!node) continue
    results.push({ node, depth: meta.depth, via: meta.via })
    const key = node.filePath || `(${node.kind})`
    fileCount.set(key, (fileCount.get(key) ?? 0) + 1)
  }
  results.sort((a, b) => a.depth - b.depth || a.node.name.localeCompare(b.node.name))
  const byFile = [...fileCount.entries()]
    .map(([filePath, count]) => ({ filePath, count }))
    .sort((a, b) => b.count - a.count)
  return { root, results, byFile }
}

// ─── Хелпер: узел по id/имени ────────────────────────────────────────────────

export function resolveAnalyticsNode(projectId: string, query: string): CodeMapNode | null {
  const byId = store.getNode(projectId, query)
  if (byId) return byId
  const matches = store.findNodes(projectId, query, 5)
  if (matches.length === 0) return null
  // Предпочитаем символы файлам/пакетам при совпадении имени.
  return matches.find(m => m.kind !== 'file' && m.kind !== 'package') ?? matches[0]
}
