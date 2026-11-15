/**
 * project_map — навигация по графу кода проекта для агента.
 *
 * Даёт «кто вызывает X / от чего зависит Y» без чтения файлов целиком —
 * экономия контекста. Источник: code_map_* (tree-sitter + резолвинг).
 * Рёбра помечены точностью (resolved/heuristic/ambiguous) — агент видит,
 * где карта уверена, а где предполагает.
 */
import type { ToolResult } from './_shared'
import * as store from '../projectMap/mapStore'
import type { CodeMapNode, CodeMapEdge } from '../../shared/projectMap'

export interface ProjectMapArgs {
  action: 'search' | 'callers' | 'callees' | 'file' | 'overview'
  query?: string
  path?: string
  nodeId?: string
  limit?: number
}

function fmtNode(n: CodeMapNode): string {
  const loc = n.kind === 'file' || n.kind === 'package' ? '' : `:${n.lineStart}`
  const parent = n.parentName ? ` (${n.parentName})` : ''
  return `${n.name} [${n.kind}]${parent} — ${n.filePath}${loc}`
}

function fmtEdge(e: CodeMapEdge, other: CodeMapNode | null, dir: 'from' | 'to'): string {
  const mark = e.precision === 'resolved' ? '' : e.precision === 'ambiguous' ? ' ?' : ' ~'
  const line = e.line ? `:${e.line}` : ''
  if (!other) return `${e.type}${mark} → ${dir === 'to' ? e.toNode : e.fromNode}${line}`
  return `${e.type}${mark} ${fmtNode(other)}${line}`
}

function resolveNode(projectId: string, args: ProjectMapArgs): CodeMapNode | null {
  if (args.nodeId) return store.getNode(projectId, args.nodeId)
  if (args.query) {
    const matches = store.findNodes(projectId, args.query, 1)
    return matches[0] ?? null
  }
  return null
}

export async function projectMapQuery(args: ProjectMapArgs, projectId?: string): Promise<ToolResult> {
  if (!projectId) {
    return { success: false, output: '', error: 'No active project for project_map. Open a project first.' }
  }
  const status = store.getStatus(projectId)
  if (status.state === 'idle' && status.totalNodes === 0) {
    return { success: false, output: '', error: 'Project map is not built yet. It builds in the background — try again shortly, or use search_code/read_file meanwhile.' }
  }
  const limit = Math.max(1, Math.min(args.limit ?? 25, 100))

  try {
    switch (args.action) {
      case 'overview': {
        const files = store.listFiles(projectId)
        const { edges } = store.getGraph(projectId, { edgeTypes: ['imports'], limit: 20000 })
        const degree = new Map<string, number>()
        for (const e of edges) {
          degree.set(e.toNode, (degree.get(e.toNode) ?? 0) + 1)
        }
        const hubs = [...degree.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([id, deg]) => {
            const n = store.getNode(projectId, id)
            return n ? `  ${n.filePath} — imported by ${deg}` : null
          })
          .filter(Boolean)
        const out = [
          `Project map: ${status.state}, ${status.totalNodes} nodes, ${status.totalEdges} edges, ${files.length} files.`,
          hubs.length ? `Most imported:\n${hubs.join('\n')}` : '',
        ].filter(Boolean).join('\n')
        return { success: true, output: out }
      }

      case 'search': {
        if (!args.query) return { success: false, output: '', error: 'search requires "query" (symbol name).' }
        const nodes = store.findNodes(projectId, args.query, limit)
        if (nodes.length === 0) return { success: true, output: `No symbols matching "${args.query}".` }
        const lines = nodes.map(fmtNode)
        // Для первого совпадения сразу покажем связи — частый сценарий.
        const top = nodes[0]
        const callers = store.getCallers(projectId, top.id).slice(0, 8)
        const callees = store.getCallees(projectId, top.id).slice(0, 8)
        if (callers.length) {
          lines.push(`\nCallers of ${top.name}:`)
          for (const e of callers) lines.push('  ' + fmtEdge(e, store.getNode(projectId, e.fromNode), 'from'))
        }
        if (callees.length) {
          lines.push(`\nCalls from ${top.name}:`)
          for (const e of callees) lines.push('  ' + fmtEdge(e, store.getNode(projectId, e.toNode), 'to'))
        }
        return { success: true, output: lines.join('\n') }
      }

      case 'callers':
      case 'callees': {
        const node = resolveNode(projectId, args)
        if (!node) return { success: false, output: '', error: 'Provide "nodeId" or "query" to identify the symbol.' }
        const edges = args.action === 'callers'
          ? store.getCallers(projectId, node.id)
          : store.getCallees(projectId, node.id)
        const shown = edges.slice(0, limit)
        const header = `${args.action === 'callers' ? 'Callers of' : 'Calls from'} ${fmtNode(node)} (${edges.length} total):`
        if (shown.length === 0) return { success: true, output: header + '\n  (none)' }
        const lines = shown.map(e => '  ' + fmtEdge(e, store.getNode(projectId, args.action === 'callers' ? e.fromNode : e.toNode), args.action === 'callers' ? 'from' : 'to'))
        return { success: true, output: [header, ...lines].join('\n') }
      }

      case 'file': {
        if (!args.path) return { success: false, output: '', error: 'file requires "path" (relative file path).' }
        const graph = store.getFileGraph(projectId, args.path)
        if (graph.nodes.length === 0) return { success: true, output: `No map data for "${args.path}".` }
        const symbols = graph.nodes.filter(n => n.kind !== 'file' && n.kind !== 'package')
        const deps = store.getFileEdges(projectId, args.path, 'out')
        const dependents = store.getFileEdges(projectId, args.path, 'in')
        const lines = [`File: ${args.path} (${symbols.length} symbols)`]
        if (symbols.length) {
          lines.push('Symbols:')
          for (const n of symbols.slice(0, limit)) lines.push('  ' + fmtNode(n))
        }
        if (deps.length) {
          lines.push('Imports:')
          for (const e of deps.slice(0, limit)) lines.push('  ' + fmtEdge(e, store.getNode(projectId, e.toNode), 'to'))
        }
        if (dependents.length) {
          lines.push('Imported by:')
          for (const e of dependents.slice(0, limit)) lines.push('  ' + fmtEdge(e, store.getNode(projectId, e.fromNode), 'from'))
        }
        return { success: true, output: lines.join('\n') }
      }

      default:
        return { success: false, output: '', error: `Unknown action "${args.action}". Use search|callers|callees|file|overview.` }
    }
  } catch (e) {
    return { success: false, output: '', error: e instanceof Error ? e.message : String(e) }
  }
}