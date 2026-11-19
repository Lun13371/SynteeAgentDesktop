/**
 * project_map — навигация по графу кода проекта для агента.
 *
 * Даёт «кто вызывает X / от чего зависит Y / как связано A и B / что заденет
 * правка» без чтения файлов целиком — экономия контекста. Источник: code_map_*
 * (tree-sitter + резолвинг). Рёбра помечены точностью
 * (resolved/heuristic/ambiguous) — агент видит, где карта уверена, а где предполагает.
 *
 * action=semantic — поиск по СМЫСЛУ (локальная E5-модель в sidecar + lexical
 * fallback): вопрос естественным языком → релевантные символы/файлы с их
 * связями из графа. Работает даже когда ни одно имя не совпадает с запросом.
 *
 * Ответы ограничены бюджетом токенов (параметр budget, default 2000) — чтобы
 * один вызов карты не съедал контекст непредсказуемо.
 */
import type { ToolResult } from './_shared'
import * as store from '../projectMap/mapStore'
import { searchSemantic } from '../projectMap/mapSemantic'
import {
  godNodes, computeCommunities, findPath, affectedNodes, resolveAnalyticsNode,
} from '../projectMap/mapAnalytics'
import { log } from '../logger'
import type { CodeMapNode, CodeMapEdge, CodeMapSemanticHit, CodeEdgeType } from '../../shared/projectMap'

export interface ProjectMapArgs {
  action: 'search' | 'semantic' | 'callers' | 'callees' | 'file' | 'overview'
    | 'god' | 'communities' | 'path' | 'explain' | 'affected'
  query?: string
  /** Второй узел для action=path. */
  to?: string
  path?: string
  nodeId?: string
  limit?: number
  /** Глубина обхода для path/affected. */
  depth?: number
  /** Ограничить типы рёбер (calls|references|imports). */
  relations?: CodeEdgeType[]
  /** Бюджет ответа в токенах (≈3.5 символа на токен). Default 2000. */
  budget?: number
}

const DEFAULT_BUDGET_TOKENS = 2000
const CHARS_PER_TOKEN = 3.5
/** Хвост под подвал «обрезано» — он должен пройти даже при крошечном бюджете. */
const TRIM_NOTE_RESERVE = 120

function fmtNode(n: CodeMapNode): string {
  const loc = n.kind === 'file' || n.kind === 'package' ? '' : `:${n.lineStart}`
  const parent = n.parentName ? ` (${n.parentName})` : ''
  return `${n.name} [${n.kind}]${parent} — ${n.filePath}${loc}`
}

function fmtEdge(e: CodeMapEdge, other: CodeMapNode | null, dir: 'from' | 'to'): string {
  const mark = e.precision === 'resolved' ? '' : e.precision === 'ambiguous' ? ' ?' : e.precision === 'external' ? ' (ext)' : ' ~'
  const line = e.line ? `:${e.line}` : ''
  if (!other) return `${e.type}${mark} → ${dir === 'to' ? e.toNode : e.fromNode}${line}`
  return `${e.type}${mark} ${fmtNode(other)}${line}`
}

/** Краткие связи хита: до N имён callers/callees — «как оно вписано в проект». */
function fmtRelations(projectId: string, node: CodeMapNode, max = 3): string[] {
  const lines: string[] = []
  if (node.kind === 'file' || node.kind === 'package') return lines
  const callers = store.getCallers(projectId, node.id).slice(0, max)
  const callees = store.getCallees(projectId, node.id).slice(0, max)
  if (callers.length) {
    const names = callers
      .map(e => store.getNode(projectId, e.fromNode)?.name ?? e.fromNode)
      .join(', ')
    lines.push(`  called by (${callers.length}${callers.length >= max ? '+' : ''}): ${names}`)
  }
  if (callees.length) {
    const names = callees
      .map(e => store.getNode(projectId, e.toNode)?.name ?? e.toNode)
      .join(', ')
    lines.push(`  calls (${callees.length}${callees.length >= max ? '+' : ''}): ${names}`)
  }
  return lines
}

/** Совместный вывод хитов семантики: ранг, локация, канал совпадения, связи. */
function fmtSemanticHits(projectId: string, hits: CodeMapSemanticHit[]): string[] {
  const lines: string[] = []
  hits.forEach((h, i) => {
    const by = h.matchedBy === 'both' ? ' (name+meaning)' : h.matchedBy === 'semantic' ? ' (meaning)' : ' (name)'
    lines.push(`${i + 1}. ${fmtNode(h.node)}${by}`)
    if (i < 3) lines.push(...fmtRelations(projectId, h.node))
  })
  return lines
}

function resolveNode(projectId: string, args: ProjectMapArgs): CodeMapNode | null {
  if (args.nodeId) return store.getNode(projectId, args.nodeId)
  if (args.query) {
    const matches = store.findNodes(projectId, args.query, 1)
    return matches[0] ?? null
  }
  return null
}

/**
 * Обрезать ответ по бюджету токенов. Строки не режем посередине (кроме
 * последней) — они смысловые единицы; в подвале честно пишем, сколько ушло.
 */
export function trimToBudget(lines: string[], budgetTokens: number): string {
  const limitChars = Math.max(TRIM_NOTE_RESERVE + 200, Math.round(budgetTokens * CHARS_PER_TOKEN))
  let used = 0
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (used + line.length + 1 > limitChars) {
      const rest = lines.length - i
      const tail = `… trimmed ${rest} line${rest === 1 ? '' : 's'} by budget (raise "budget" for more)`
      // Если даже подвал не влезает — отдаём хотя бы начало ответа.
      if (used + tail.length + 1 > limitChars) out.push(tail)
      else out.push(tail)
      return out.join('\n')
    }
    used += line.length + 1
    out.push(line)
  }
  return out.join('\n')
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
  const started = Date.now()

  try {
    const result = await runAction(args, projectId, limit, status)
    log('[project_map] action=%s project=%s → %d chars in %dms',
      args.action, projectId.slice(0, 8), result.output.length, Date.now() - started)
    return result
  } catch (e) {
    log('[project_map] action=%s FAILED in %dms: %s',
      args.action, Date.now() - started, e instanceof Error ? e.message : String(e))
    return { success: false, output: '', error: e instanceof Error ? e.message : String(e) }
  }
}

async function runAction(
  args: ProjectMapArgs,
  projectId: string,
  limit: number,
  status: import('../../shared/projectMap').CodeMapStatus,
): Promise<ToolResult> {
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
            if (!n) return null
            // package-узлы живут вне файлов: показываем имя пакета, не пустой path.
            const label = n.kind === 'package' ? `${n.name} (external package)` : n.filePath
            return `  ${label} — imported by ${deg}`
          })
          .filter(Boolean)
        // Ядро архитектуры — сразу в обзоре: чаще всего именно оно нужно вместо чтения файлов.
        const gods = godNodes(projectId, 5)
        const godLines = gods.length
          ? ['Architecture hubs (god nodes):', ...gods.map(g => `  ${g.node.name} [${g.node.kind}] — ${g.node.filePath}:${g.node.lineStart} (fan-in ${g.fanIn}, fan-out ${g.fanOut})`)]
          : []
        const out = [
          `Project map: ${status.state}, ${status.totalNodes} nodes, ${status.totalEdges} edges, ${files.length} files.`,
          hubs.length ? `Most imported:\n${hubs.join('\n')}` : '',
          godLines.join('\n'),
          'Actions: search | semantic | callers | callees | file | god | communities | path | explain | affected',
        ].filter(Boolean).join('\n')
        return { success: true, output: trimToBudget(out.split('\n'), args.budget ?? DEFAULT_BUDGET_TOKENS) }
      }

      case 'god': {
        const gods = godNodes(projectId, limit)
        if (gods.length === 0) return { success: true, output: 'No call/import edges in the map yet.' }
        const lines = [`Architecture hubs — top ${gods.length} by degree (fan-in + fan-out):`]
        gods.forEach((g, i) => {
          lines.push(`${i + 1}. ${fmtNode(g.node)} — degree ${g.degree} (in ${g.fanIn} / out ${g.fanOut})`)
        })
        return { success: true, output: trimToBudget(lines, args.budget ?? DEFAULT_BUDGET_TOKENS) }
      }

      case 'communities': {
        const { communities } = computeCommunities(projectId)
        if (communities.length === 0) return { success: true, output: 'No edges to cluster — map has calls/imports yet to resolve.' }
        // Одиночные узлы (переменные/поля без calls/imports) — не подсистемы:
        // без этого фильтра список начинается с «N clusters», где N ≈ число узлов.
        const linked = communities.filter(c => c.size >= 2)
        const isolated = communities.reduce((sum, c) => sum + (c.size === 1 ? 1 : 0), 0)
        if (linked.length === 0) {
          return { success: true, output: `No subsystems yet — ${isolated} symbols have no call/import edges.` }
        }
        const shown = linked.slice(0, limit)
        const lines = [
          `Subsystems (Louvain): ${linked.length} cluster${linked.length === 1 ? '' : 's'} with 2+ linked symbols` +
            (isolated > 0 ? ` | ${isolated} isolated symbols (no calls/imports)` : ''),
          `Showing ${shown.length} largest.`,
        ]
        for (const c of shown) {
          const dir = c.topDir ? ` — ${c.topDir}` : ''
          lines.push(`\n[${c.id}] ${c.label} (${c.size} nodes)${dir}`)
          for (const n of c.topNodes) lines.push(`   ${n.name} — ${n.filePath} (in ${n.fanIn})`)
        }
        return { success: true, output: trimToBudget(lines, args.budget ?? DEFAULT_BUDGET_TOKENS) }
      }

      case 'path': {
        if (!args.query || !args.to) {
          return { success: false, output: '', error: 'path requires "query" (from) and "to" — names, ids or file paths.', }
        }
        const from = resolveAnalyticsNode(projectId, args.query)
        const to = resolveAnalyticsNode(projectId, args.to)
        if (!from) return { success: false, output: '', error: `No map node matches "${args.query}".` }
        if (!to) return { success: false, output: '', error: `No map node matches "${args.to}".` }
        const res = findPath(projectId, from.id, to.id, { maxDepth: args.depth, relations: args.relations })
        if (!res.found) {
          return { success: true, output: `No path found from ${from.name} to ${to.name} within depth ${args.depth ?? 6} (calls/references/imports).` }
        }
        const lines = [
          `Path ${from.name} → ${to.name}: ${res.hops.length - 1} hop(s), confidence ${(res.confidence * 100).toFixed(0)}%${res.weakest ? ` (weakest edge: ${res.weakest})` : ''}`,
        ]
        res.hops.forEach((hop, i) => {
          if (i === 0) { lines.push(`  1. ${fmtNode(hop.node!)}`); return }
          lines.push(`  ${i + 1}. --${hop.type}${hop.precision === 'resolved' ? '' : hop.precision === 'ambiguous' ? ' ?' : ' ~'}--> ${fmtNode(hop.node!)}`)
        })
        return { success: true, output: trimToBudget(lines, args.budget ?? DEFAULT_BUDGET_TOKENS) }
      }

      case 'explain': {
        const node = resolveNode(projectId, args)
        if (!node) return { success: false, output: '', error: 'Provide "nodeId" or "query" to identify the symbol.' }
        const { communities, assignment } = computeCommunities(projectId)
        const cid = assignment.get(node.id)
        const community = cid != null ? communities.find(c => c.id === cid) : undefined
        const callers = store.getCallers(projectId, node.id)
        const callees = store.getCallees(projectId, node.id)
        const lines = [`${fmtNode(node)}`]
        if (node.signature) lines.push(`  signature: ${node.signature}`)
        if (node.doc) lines.push(`  doc: ${node.doc.slice(0, 400).replace(/\s+/g, ' ')}`)
        lines.push(`  exported: ${node.exported ? 'yes' : 'no'}`)
        if (community) lines.push(`  subsystem: [${community.id}] ${community.label} (${community.size} nodes)`)
        if (callers.length) {
          lines.push(`\nCalled by (${callers.length}):`)
          for (const e of callers.slice(0, limit)) lines.push('  ' + fmtEdge(e, store.getNode(projectId, e.fromNode), 'from'))
        }
        if (callees.length) {
          lines.push(`\nCalls (${callees.length}):`)
          for (const e of callees.slice(0, limit)) lines.push('  ' + fmtEdge(e, store.getNode(projectId, e.toNode), 'to'))
        }
        const fileImports = store.getFileEdges(projectId, node.filePath, 'out').slice(0, 10)
        const fileDependents = store.getFileEdges(projectId, node.filePath, 'in').slice(0, 10)
        if (fileImports.length) {
          lines.push(`\nFile ${node.filePath} imports:`)
          for (const e of fileImports) lines.push('  ' + fmtEdge(e, store.getNode(projectId, e.toNode), 'to'))
        }
        if (fileDependents.length) {
          lines.push(`Imported by:`)
          for (const e of fileDependents) lines.push('  ' + fmtEdge(e, store.getNode(projectId, e.fromNode), 'from'))
        }
        return { success: true, output: trimToBudget(lines, args.budget ?? DEFAULT_BUDGET_TOKENS) }
      }

      case 'affected': {
        const target = args.nodeId
          ? store.getNode(projectId, args.nodeId)
          : args.path
            ? store.getNode(projectId, args.path)
            : resolveNode(projectId, args)
        if (!target) {
          return { success: false, output: '', error: 'affected requires "nodeId", "path" or "query".' }
        }
        const res = affectedNodes(projectId, target.id, { depth: args.depth ?? 3, relations: args.relations, limit: limit * 8 })
        if (res.results.length === 0) {
          return { success: true, output: `Nothing depends on ${target.name} (no incoming calls/references/imports).` }
        }
        const lines = [
          `Impact of changing ${fmtNode(target)}: ${res.results.length} dependent node(s) within depth ${args.depth ?? 3}`,
          'Files affected:',
          ...res.byFile.slice(0, limit).map(f => `  ${f.filePath} — ${f.count} node(s)`),
          '\nDependents:',
          ...res.results.slice(0, limit).map(r => `  ${'  '.repeat(Math.min(r.depth - 1, 3))}${fmtNode(r.node)} — via ${r.via} (depth ${r.depth})`),
        ]
        return { success: true, output: trimToBudget(lines, args.budget ?? DEFAULT_BUDGET_TOKENS) }
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
        return { success: true, output: trimToBudget(lines, args.budget ?? DEFAULT_BUDGET_TOKENS) }
      }

      case 'semantic': {
        if (!args.query) return { success: false, output: '', error: 'semantic requires "query" — a natural-language description of WHAT to find, e.g. "password validation logic" or "сжатие истории". For exact symbol names prefer action=search.' }
        const res = await searchSemantic(projectId, args.query, limit)
        const head = `Semantic search "${args.query}" — mode: ${res.mode}, ${res.indexedDocs}/${res.totalDocs} docs indexed:`
        if (res.hits.length === 0) {
          const note = res.mode === 'none'
            ? ' (project map has no indexed documents yet)'
            : res.mode === 'lexical'
              ? ' (semantic model warming up — lexical fallback used; try again soon for meaning-based ranking)'
              : ''
          return { success: true, output: `${head}\n  (no matches)${note}` }
        }
        const lines = [head, ...fmtSemanticHits(projectId, res.hits)]
        if (res.mode === 'lexical') {
          lines.push('(mode lexical: semantic model is not ready — ranking is word-based, not meaning-based)')
        }
        return { success: true, output: trimToBudget(lines, args.budget ?? DEFAULT_BUDGET_TOKENS) }
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
        return { success: true, output: trimToBudget([header, ...lines], args.budget ?? DEFAULT_BUDGET_TOKENS) }
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
        return { success: true, output: trimToBudget(lines, args.budget ?? DEFAULT_BUDGET_TOKENS) }
      }

      default:
        return {
          success: false, output: '',
          error: `Unknown action "${args.action}". Use search|semantic|callers|callees|file|overview|god|communities|path|explain|affected.`,
        }
  }
}
