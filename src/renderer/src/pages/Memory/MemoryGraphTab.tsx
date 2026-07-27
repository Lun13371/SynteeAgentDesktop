/**
 * MemoryGraphTab — вкладка knowledge graph в MemoryPage.
 * Force-directed визуализация через vis-network.
 * Узлы окрашены по типу, размер ∝ weight/degree.
 * Клик по узлу → боковая панель с метаданными + pin/delete.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Network, type Node as VisNode, type Edge as VisEdge, type Options } from 'vis-network/standalone'
import AppIcon, { type IconName } from '../../components/ui/AppIcon/AppIcon'
import './MemoryGraphTab.css'

// ─── Типы (mirror graphStore.ts, но без зависимостей на main side) ───────────

interface GraphNode {
  id: string
  type: string
  label: string
  weight: number
  pinned: boolean
  sourceKind: string | null
  sourceId: string | null
}

interface GraphEdge {
  id: string
  fromNode: string
  toNode: string
  type: string
  weight: number
}

interface GraphStats {
  nodeCount: number
  edgeCount: number
  byNodeType: Record<string, number>
  byEdgeType: Record<string, number>
  hubs: Array<{ id: string; label: string; type: string; degree: number }>
  recentDecisions: Array<{ id: string; label: string; targets: Array<{ label: string; type: string; edgeType: string }> }>
}

// ─── Конфигурация цветов и иконок по типам узлов ────────────────────────────

const NODE_TYPE_META: Record<string, { label: string; color: string; icon: IconName }> = {
  decision: { label: 'Решение', color: '#3b82f6', icon: 'folder' },
  concept: { label: 'Концепция', color: '#10b981', icon: 'sparkles' },
  file: { label: 'Файл', color: '#f59e0b', icon: 'fileText' },
  symbol: { label: 'Символ', color: '#8b5cf6', icon: 'code' },
  conversation: { label: 'Диалог', color: '#ec4899', icon: 'messageSquare' },
  task: { label: 'Задача', color: '#ef4444', icon: 'check' },
}

const EDGE_TYPE_LABELS: Record<string, string> = {
  affects: 'влияет на',
  mentions: 'упоминает',
  implemented_in: 'реализован в',
  depends_on: 'зависит от',
  supersedes: 'заменяет',
  references: 'ссылается',
  imports: 'импортирует',
  calls: 'вызывает',
  implements: 'реализует',
}

// ─── Компонент ───────────────────────────────────────────────────────────────

interface MemoryGraphTabProps {
  projectId?: string
}

export default function MemoryGraphTab({ projectId }: MemoryGraphTabProps) {
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null)
  const [stats, setStats] = useState<GraphStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [filterTypes, setFilterTypes] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const networkRef = useRef<Network | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async () => {
    if (!projectId) {
      setGraph({ nodes: [], edges: [] })
      setStats(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [graphData, statsData] = await Promise.all([
        (window.syntee as any).graph.get(projectId, { limit: 300 }) as Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>,
        (window.syntee as any).graph.stats(projectId) as Promise<GraphStats>,
      ])
      setGraph(graphData)
      setStats(statsData)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  // ─── Построение vis-network ──────────────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current || !graph) return

    // Фильтрация узлов по типам
    const filteredNodes = filterTypes.size > 0
      ? graph.nodes.filter(n => filterTypes.has(n.type))
      : graph.nodes
    const filteredNodeIds = new Set(filteredNodes.map(n => n.id))
    const filteredEdges = graph.edges.filter(e =>
      filteredNodeIds.has(e.fromNode) && filteredNodeIds.has(e.toNode)
    )

    // Подсчёт degree для каждого узла
    const degreeMap: Record<string, number> = {}
    for (const e of filteredEdges) {
      degreeMap[e.fromNode] = (degreeMap[e.fromNode] ?? 0) + 1
      degreeMap[e.toNode] = (degreeMap[e.toNode] ?? 0) + 1
    }

    const visNodes: VisNode[] = filteredNodes.map(n => {
      const meta = NODE_TYPE_META[n.type] ?? { color: '#6b7280', label: n.type, icon: 'circle' as IconName }
      const degree = degreeMap[n.id] ?? 0
      // Размер: base 10 + weight*4 + degree*1.5, max 40
      const size = Math.min(40, 10 + n.weight * 4 + degree * 1.5)
      return {
        id: n.id,
        label: n.label.length > 25 ? n.label.slice(0, 22) + '…' : n.label,
        title: `[${meta.label}] ${n.label}\nweight: ${n.weight.toFixed(1)}\ndegree: ${degree}${n.pinned ? '\n★ pinned' : ''}`,
        color: {
          background: meta.color,
          border: n.pinned ? '#fbbf24' : meta.color,
          highlight: { background: meta.color, border: '#ffffff' },
          hover: { background: meta.color, border: '#ffffff' },
        },
        size,
        shape: 'dot',
        font: {
          color: '#d1d5db',
          size: 13,
          face: 'system-ui, sans-serif',
          strokeWidth: 3,
          strokeColor: '#0f172a',
          vadjust: 0,
        },
        borderWidth: n.pinned ? 3 : 1.5,
        shadow: { enabled: true, color: 'rgba(0,0,0,0.3)', size: 8, x: 0, y: 2 },
      }
    })

    const visEdges: VisEdge[] = filteredEdges.map(e => ({
      id: e.id,
      from: e.fromNode,
      to: e.toNode,
      title: EDGE_TYPE_LABELS[e.type] ?? e.type,
      color: {
        color: 'rgba(107, 114, 128, 0.4)',
        highlight: '#9ca3af',
        hover: '#9ca3af',
      },
      width: Math.max(0.5, Math.min(3, e.weight)),
      arrows: { to: { enabled: true, scaleFactor: 0.6 } },
      smooth: { enabled: true, type: 'continuous', roundness: 0.5 },
    }))

    const options: Options = {
      physics: {
        enabled: true,
        solver: 'barnesHut',
        barnesHut: {
          gravitationalConstant: -8000,
          centralGravity: 0.3,
          springLength: 120,
          springConstant: 0.04,
          damping: 0.09,
          avoidOverlap: 0.8,
        },
        stabilization: {
          enabled: true,
          iterations: 200,
          updateInterval: 50,
          fit: true,
        },
        maxVelocity: 50,
      },
      interaction: {
        hover: true,
        tooltipDelay: 200,
        navigationButtons: false,
        keyboard: false,
        zoomView: true,
        dragView: true,
        dragNodes: true,
      },
      layout: { improvedLayout: true, randomSeed: 42 },
      nodes: {
        borderWidth: 1.5,
        scaling: { min: 10, max: 40 },
      },
      edges: {
        scaling: { min: 0.5, max: 3 },
        smooth: { type: 'continuous' },
      },
    }

    const network = new Network(containerRef.current, { nodes: visNodes, edges: visEdges }, options)
    network.on('click', (params: { nodes: string[] }) => {
      if (params.nodes.length > 0) {
        const nodeId = params.nodes[0]
        const node = filteredNodes.find(n => n.id === nodeId)
        setSelectedNode(node ?? null)
      } else {
        setSelectedNode(null)
      }
    })
    networkRef.current = network
    // Отключаем физику после стабилизации — без этого Barnes-Hut solver
    // продолжает работать каждый кадр до размонтирования, потребляя CPU.
    // После 200 итераций layout уже сходится, визуально ничего не меняется.
    network.once('stabilizationIterationsDone', () => {
      network.setOptions({ physics: { enabled: false } })
    })

    return () => {
      network.destroy()
      networkRef.current = null
    }
  }, [graph, filterTypes])

  // ─── Actions ─────────────────────────────────────────────────────────────

  const handleRebuild = async () => {
    if (!projectId) return
    setLoading(true)
    try {
      await (window.syntee as any).graph.rebuild(projectId)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handlePin = async (id: string, pinned: boolean) => {
    await (window.syntee as any).graph.pinNode(id, pinned)
    await load()
    setSelectedNode(prev => prev ? { ...prev, pinned } : null)
  }

  const handleDelete = async (id: string) => {
    await (window.syntee as any).graph.deleteNode(id)
    setSelectedNode(null)
    await load()
  }

  const handlePruneIsolated = async () => {
    if (!projectId) return
    await (window.syntee as any).graph.pruneIsolated(projectId)
    await load()
  }

  const toggleFilter = (type: string) => {
    setFilterTypes(prev => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  if (!projectId) {
    return (
      <div className="memory-graph-empty">
        <AppIcon name="gitBranch" size="lg" tone="muted" />
        <p>Выберите проект для просмотра графа</p>
      </div>
    )
  }

  return (
    <div className="memory-graph-tab">
      {/* Toolbar */}
      <div className="memory-graph-toolbar">
        <div className="memory-graph-stats">
          {stats && (
            <>
              <span className="graph-stat">Узлов: <strong>{stats.nodeCount}</strong></span>
              <span className="graph-stat">Рёбер: <strong>{stats.edgeCount}</strong></span>
              {stats.hubs.length > 0 && (
                <span className="graph-stat">
                  Хабы: {stats.hubs.slice(0, 3).map(h => `${h.label}(${h.degree})`).join(', ')}
                </span>
              )}
            </>
          )}
        </div>
        <div className="memory-graph-actions">
          <button className="graph-action-btn" onClick={handlePruneIsolated} title="Удалить изолированные узлы">
            <AppIcon name="trash" size="sm" /> Чистка
          </button>
          <button className="graph-action-btn graph-action-btn--primary" onClick={handleRebuild} disabled={loading} title="Полная перестройка">
            <AppIcon name="refreshCw" size="sm" /> {loading ? '...' : 'Перестроить'}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="memory-graph-filters">
        <span className="filter-label">Типы:</span>
        {Object.entries(NODE_TYPE_META).map(([type, meta]) => (
          <button
            key={type}
            className={`graph-filter-chip ${filterTypes.has(type) ? 'graph-filter-chip--active' : ''}`}
            style={filterTypes.has(type) ? { borderColor: meta.color, background: `${meta.color}22` } : {}}
            onClick={() => toggleFilter(type)}
          >
            <span className="filter-dot" style={{ background: meta.color }} />
            {meta.label}
          </button>
        ))}
        {filterTypes.size > 0 && (
          <button className="graph-filter-clear" onClick={() => setFilterTypes(new Set())}>
            Сбросить
          </button>
        )}
      </div>

      {error && <div className="memory-graph-error">{error}</div>}

      <div className="memory-graph-content">
        {/* Graph canvas */}
        <div className="memory-graph-canvas" ref={containerRef} />

        {/* Side panel: selected node */}
        {selectedNode && (
          <div className="memory-graph-sidepanel">
            <div className="sidepanel-header">
              <span
                className="sidepanel-type-badge"
                style={{ background: NODE_TYPE_META[selectedNode.type]?.color ?? '#6b7280' }}
              >
                {NODE_TYPE_META[selectedNode.type]?.label ?? selectedNode.type}
              </span>
              <button className="sidepanel-close" onClick={() => setSelectedNode(null)}>×</button>
            </div>
            <div className="sidepanel-body">
              <div className="sidepanel-label">{selectedNode.label}</div>
              <div className="sidepanel-meta">
                <div>Weight: <strong>{selectedNode.weight.toFixed(1)}</strong></div>
                <div>Pinned: <strong>{selectedNode.pinned ? 'да ★' : 'нет'}</strong></div>
                {selectedNode.sourceKind && <div>Source: <strong>{selectedNode.sourceKind}</strong></div>}
                {selectedNode.sourceId && (
                  <div className="sidepanel-source-id">ID: <code>{selectedNode.sourceId.slice(0, 40)}</code></div>
                )}
              </div>
              <div className="sidepanel-actions">
                <button className="sidepanel-btn" onClick={() => handlePin(selectedNode.id, !selectedNode.pinned)}>
                  <AppIcon name="pin" size="sm" /> {selectedNode.pinned ? 'Открепить' : 'Закрепить'}
                </button>
                <button className="sidepanel-btn sidepanel-btn--danger" onClick={() => handleDelete(selectedNode.id)}>
                  <AppIcon name="trash" size="sm" /> Удалить
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
