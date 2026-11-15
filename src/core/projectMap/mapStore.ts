/**
 * mapStore — CRUD графа кода проекта (code_map_* таблицы).
 *
 * Граф детерминированный: id узлов/рёбер выводятся из пути/имени, поэтому
 * повторный разбор файла даёт те же id (стабильные входящие рёбра). Инкрементал
 * устроен как replaceFile: удалить узлы/исходящие рёбра файла → вставить новые.
 * Входящие рёбра из других файлов остаются; осиротевшие чистит pruneDanglingEdges.
 */
import { getDB } from '../db/handle'
import type {
  CodeMapNode, CodeMapEdge, CodeMapFile, CodeMapStatus, CodeMapGraph,
  CodeNodeKind, CodeEdgeType, CodeEdgePrecision, GetGraphOptions,
} from '../../shared/projectMap'

// ─── Детерминированные id ────────────────────────────────────────────────────

export function fileNodeId(filePath: string): string {
  return filePath
}

export function symbolNodeId(filePath: string, name: string, parentName?: string | null): string {
  const qualified = parentName ? `${parentName}.${name}` : name
  return `${filePath}#${qualified}`
}

export function packageNodeId(name: string): string {
  return `pkg:${name}`
}

export function edgeId(from: string, type: CodeEdgeType, to: string, line: number): string {
  return `${from}|${type}|${to}|${line}`
}

// ─── Мапперы строк ───────────────────────────────────────────────────────────

function rowToNode(row: Record<string, unknown>): CodeMapNode {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    filePath: row.file_path as string,
    name: row.name as string,
    kind: row.kind as CodeNodeKind,
    parentName: (row.parent_name as string | null) ?? null,
    lineStart: (row.line_start as number) ?? 0,
    lineEnd: (row.line_end as number) ?? 0,
    signature: (row.signature as string) ?? '',
    exported: Boolean(row.exported),
  }
}

function rowToEdge(row: Record<string, unknown>): CodeMapEdge {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    fromNode: row.from_node as string,
    toNode: row.to_node as string,
    type: row.type as CodeEdgeType,
    precision: row.precision as CodeEdgePrecision,
    filePath: row.file_path as string,
    line: (row.line as number) ?? 0,
  }
}

function rowToFile(row: Record<string, unknown>): CodeMapFile {
  return {
    projectId: row.project_id as string,
    path: row.path as string,
    language: (row.language as string | null) ?? null,
    hash: row.hash as string,
    mtime: (row.mtime as number) ?? 0,
    size: (row.size as number) ?? 0,
    parser: (row.parser as string | null) ?? null,
    truncated: Boolean(row.truncated),
    indexedAt: (row.indexed_at as number) ?? 0,
  }
}

// ─── Запись ──────────────────────────────────────────────────────────────────

/**
 * Атомарно заменить узлы и исходящие рёбра одного файла. Пакетные узлы (package)
 * сюда не входят — они глобальные на проект и живут через ensurePackageNode.
 */
export function replaceFile(
  projectId: string,
  file: CodeMapFile,
  nodes: CodeMapNode[],
  edges: CodeMapEdge[],
): void {
  const db = getDB()
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM code_map_nodes WHERE project_id = ? AND file_path = ?`).run(projectId, file.path)
    db.prepare(`DELETE FROM code_map_edges WHERE project_id = ? AND file_path = ?`).run(projectId, file.path)
    db.prepare(`DELETE FROM code_map_files WHERE project_id = ? AND path = ?`).run(projectId, file.path)

    db.prepare(
      `INSERT INTO code_map_files (project_id, path, language, hash, mtime, size, parser, truncated, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(projectId, file.path, file.language, file.hash, file.mtime, file.size, file.parser, file.truncated ? 1 : 0, file.indexedAt)

    const insNode = db.prepare(
      `INSERT OR REPLACE INTO code_map_nodes (id, project_id, file_path, name, kind, parent_name, line_start, line_end, signature, exported)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const n of nodes) {
      insNode.run(n.id, projectId, n.filePath, n.name, n.kind, n.parentName, n.lineStart, n.lineEnd, n.signature, n.exported ? 1 : 0)
    }

    const insEdge = db.prepare(
      `INSERT OR REPLACE INTO code_map_edges (id, project_id, from_node, to_node, type, precision, file_path, line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const e of edges) {
      insEdge.run(e.id, projectId, e.fromNode, e.toNode, e.type, e.precision, e.filePath, e.line)
    }
  })
  tx()
}

/** Внешний пакет — глобальный узел проекта, не привязан к файлу. */
export function ensurePackageNode(projectId: string, name: string): string {
  const id = packageNodeId(name)
  getDB().prepare(
    `INSERT OR IGNORE INTO code_map_nodes (id, project_id, file_path, name, kind, parent_name, line_start, line_end, signature, exported)
     VALUES (?, ?, '', ?, 'package', NULL, 0, 0, '', 0)`
  ).run(id, projectId, name)
  return id
}

export function removeFile(projectId: string, path: string): void {
  const db = getDB()
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM code_map_nodes WHERE project_id = ? AND file_path = ?`).run(projectId, path)
    db.prepare(`DELETE FROM code_map_edges WHERE project_id = ? AND file_path = ?`).run(projectId, path)
    db.prepare(`DELETE FROM code_map_files WHERE project_id = ? AND path = ?`).run(projectId, path)
  })
  tx()
}

/** Удалить рёбра, чьи узлы больше не существуют (после инкрементальных правок). */
export function pruneDanglingEdges(projectId: string): number {
  const res = getDB().prepare(
    `DELETE FROM code_map_edges
     WHERE project_id = ?
       AND (from_node NOT IN (SELECT id FROM code_map_nodes WHERE project_id = ?)
        OR to_node NOT IN (SELECT id FROM code_map_nodes WHERE project_id = ?))`
  ).run(projectId, projectId, projectId)
  return res.changes
}

export function clearProject(projectId: string): void {
  const db = getDB()
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM code_map_nodes WHERE project_id = ?`).run(projectId)
    db.prepare(`DELETE FROM code_map_edges WHERE project_id = ?`).run(projectId)
    db.prepare(`DELETE FROM code_map_files WHERE project_id = ?`).run(projectId)
  })
  tx()
}

// ─── Чтение ──────────────────────────────────────────────────────────────────

export function getGraph(projectId: string, opts: GetGraphOptions = {}): CodeMapGraph {
  const db = getDB()
  const limit = Math.max(1, Math.min(opts.limit ?? 5000, 20000))

  const nodeWhere: string[] = ['project_id = ?']
  const nodeParams: unknown[] = [projectId]
  if (opts.filePath) {
    nodeWhere.push('(file_path = ? OR kind = \'package\')')
    nodeParams.push(opts.filePath)
  }
  if (opts.kinds && opts.kinds.length > 0) {
    nodeWhere.push(`kind IN (${opts.kinds.map(() => '?').join(',')})`)
    nodeParams.push(...opts.kinds)
  }
  const nodes = db.prepare(
    `SELECT * FROM code_map_nodes WHERE ${nodeWhere.join(' AND ')} LIMIT ?`
  ).all(...nodeParams, limit) as Record<string, unknown>[]

  const edgeWhere: string[] = ['project_id = ?']
  const edgeParams: unknown[] = [projectId]
  if (opts.edgeTypes && opts.edgeTypes.length > 0) {
    edgeWhere.push(`type IN (${opts.edgeTypes.map(() => '?').join(',')})`)
    edgeParams.push(...opts.edgeTypes)
  }
  if (opts.filePath) {
    edgeWhere.push('file_path = ?')
    edgeParams.push(opts.filePath)
  }
  const edges = db.prepare(
    `SELECT * FROM code_map_edges WHERE ${edgeWhere.join(' AND ')} LIMIT ?`
  ).all(...edgeParams, limit * 4) as Record<string, unknown>[]

  return { nodes: nodes.map(rowToNode), edges: edges.map(rowToEdge) }
}

/** Все узлы проекта без рёбер — тёплая загрузка индекса (не тянет edges). */
export function listNodes(projectId: string, limit?: number, offset = 0): CodeMapNode[] {
  const db = getDB()
  const rows = (limit != null
    ? db.prepare(`SELECT * FROM code_map_nodes WHERE project_id = ? LIMIT ? OFFSET ?`).all(projectId, limit, offset)
    : db.prepare(`SELECT * FROM code_map_nodes WHERE project_id = ?`).all(projectId)
  ) as Record<string, unknown>[]
  return rows.map(rowToNode)
}

/** Узлы файла + рёбра, которые их касаются (drill-down в модалке). */
export function getFileGraph(projectId: string, path: string): CodeMapGraph {
  const db = getDB()
  const nodes = db.prepare(
    `SELECT * FROM code_map_nodes WHERE project_id = ? AND (file_path = ? OR id = ?)`
  ).all(projectId, path, fileNodeId(path)) as Record<string, unknown>[]
  const ids = nodes.map(n => n.id as string)
  if (ids.length === 0) return { nodes: [], edges: [] }
  const placeholders = ids.map(() => '?').join(',')
  const edges = db.prepare(
    `SELECT * FROM code_map_edges WHERE project_id = ? AND (from_node IN (${placeholders}) OR to_node IN (${placeholders}))`
  ).all(projectId, ...ids, ...ids) as Record<string, unknown>[]
  return { nodes: nodes.map(rowToNode), edges: edges.map(rowToEdge) }
}

export function findNodes(projectId: string, query: string, limit = 30): CodeMapNode[] {
  const db = getDB()
  const like = `%${query}%`
  const rows = db.prepare(
    `SELECT * FROM code_map_nodes WHERE project_id = ? AND name LIKE ? AND kind != 'package'
     ORDER BY CASE WHEN name = ? THEN 0 WHEN name LIKE ? THEN 1 ELSE 2 END, name LIMIT ?`
  ).all(projectId, like, query, `${query}%`, limit) as Record<string, unknown>[]
  return rows.map(rowToNode)
}

export function getNode(projectId: string, nodeId: string): CodeMapNode | null {
  const row = getDB().prepare(`SELECT * FROM code_map_nodes WHERE project_id = ? AND id = ?`)
    .get(projectId, nodeId) as Record<string, unknown> | undefined
  return row ? rowToNode(row) : null
}

/** Кто вызывает узел (входящие calls/references). */
export function getCallers(projectId: string, nodeId: string): CodeMapEdge[] {
  const rows = getDB().prepare(
    `SELECT * FROM code_map_edges WHERE project_id = ? AND to_node = ? AND type IN ('calls','references')`
  ).all(projectId, nodeId) as Record<string, unknown>[]
  return rows.map(rowToEdge)
}

/** Кого вызывает узел (исходящие calls/references). */
export function getCallees(projectId: string, nodeId: string): CodeMapEdge[] {
  const rows = getDB().prepare(
    `SELECT * FROM code_map_edges WHERE project_id = ? AND from_node = ? AND type IN ('calls','references')`
  ).all(projectId, nodeId) as Record<string, unknown>[]
  return rows.map(rowToEdge)
}

export function getFileEdges(projectId: string, path: string, direction: 'out' | 'in'): CodeMapEdge[] {
  const fid = fileNodeId(path)
  const col = direction === 'out' ? 'from_node' : 'to_node'
  const rows = getDB().prepare(
    `SELECT * FROM code_map_edges WHERE project_id = ? AND ${col} = ? AND type = 'imports'`
  ).all(projectId, fid) as Record<string, unknown>[]
  return rows.map(rowToEdge)
}

/** Обновить mtime/size файла без переразбора (случай «touch»: hash тот же). */
export function updateFileStat(projectId: string, path: string, mtime: number, size: number): void {
  getDB().prepare(
    `UPDATE code_map_files SET mtime = ?, size = ? WHERE project_id = ? AND path = ?`
  ).run(mtime, size, projectId, path)
}

export function listFiles(projectId: string): CodeMapFile[] {
  const rows = getDB().prepare(`SELECT * FROM code_map_files WHERE project_id = ? ORDER BY path`)
    .all(projectId) as Record<string, unknown>[]
  return rows.map(rowToFile)
}

export function getFile(projectId: string, path: string): CodeMapFile | null {
  const row = getDB().prepare(`SELECT * FROM code_map_files WHERE project_id = ? AND path = ?`)
    .get(projectId, path) as Record<string, unknown> | undefined
  return row ? rowToFile(row) : null
}

export function getIndexedProjectIds(): string[] {
  const rows = getDB().prepare(`SELECT DISTINCT project_id FROM code_map_files`).all() as { project_id: string }[]
  return rows.map(r => r.project_id)
}

// ─── Статус ──────────────────────────────────────────────────────────────────

export function getStatus(projectId: string): CodeMapStatus {
  const row = getDB().prepare(`SELECT * FROM code_map_status WHERE project_id = ?`).get(projectId) as Record<string, unknown> | undefined
  if (!row) {
    return {
      projectId, state: 'idle', totalFiles: 0, indexedFiles: 0, totalNodes: 0, totalEdges: 0,
      startedAt: null, updatedAt: 0, error: null,
    }
  }
  return {
    projectId,
    state: row.state as CodeMapStatus['state'],
    totalFiles: (row.total_files as number) ?? 0,
    indexedFiles: (row.indexed_files as number) ?? 0,
    totalNodes: (row.total_nodes as number) ?? 0,
    totalEdges: (row.total_edges as number) ?? 0,
    startedAt: (row.started_at as number | null) ?? null,
    updatedAt: (row.updated_at as number) ?? 0,
    error: (row.error as string | null) ?? null,
  }
}

export function setStatus(projectId: string, patch: Partial<Omit<CodeMapStatus, 'projectId'>>): void {
  const db = getDB()
  const current = getStatus(projectId)
  const next = { ...current, ...patch, updatedAt: Date.now() }
  db.prepare(
    `INSERT OR REPLACE INTO code_map_status
     (project_id, state, total_files, indexed_files, total_nodes, total_edges, started_at, updated_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(projectId, next.state, next.totalFiles, next.indexedFiles, next.totalNodes, next.totalEdges, next.startedAt, next.updatedAt, next.error)
}

/** Пересчитать счётчики узлов/рёбер из фактических таблиц. */
export function refreshCounts(projectId: string): void {
  const db = getDB()
  const nodes = (db.prepare(`SELECT COUNT(*) c FROM code_map_nodes WHERE project_id = ?`).get(projectId) as { c: number }).c
  const edges = (db.prepare(`SELECT COUNT(*) c FROM code_map_edges WHERE project_id = ?`).get(projectId) as { c: number }).c
  const files = (db.prepare(`SELECT COUNT(*) c FROM code_map_files WHERE project_id = ?`).get(projectId) as { c: number }).c
  setStatus(projectId, { totalNodes: nodes, totalEdges: edges, indexedFiles: files })
}