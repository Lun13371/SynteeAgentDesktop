/**
 * MemoryGraphTab — вкладка knowledge graph в MemoryPage.
 * Force-directed визуализация через vis-network.
 * Узлы окрашены по типу, размер ∝ weight/degree.
 * Клик по узлу → боковая панель с метаданными + pin/delete.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Network, type Node as VisNode, type Edge as VisEdge, type Options } from 'vis-network/standalone'
import AppIcon, { type IconName } from '../../components/ui/AppIcon/AppIcon'
import { whileHoverSm, whileTapSm, whileHoverTiny, whileTapTiny, whileHoverListItem, whileTapListItem, springHover } from '../../utils/motionPresets'
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
  selectedProjectId: string
  onSelectProject: (id: string) => void
  projects: Array<{ id: string; name: string; workdir: string }>
}

export default function MemoryGraphTab({ selectedProjectId, onSelectProject, projects }: MemoryGraphTabProps) {
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null)
  const [stats, setStats] = useState<GraphStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [filterTypes, setFilterTypes] = useState<Set<string>>(new Set())
  const [viewMode, setViewMode] = useState<'all' | 'memory' | 'files'>('all')
  const [error, setError] = useState<string | null>(null)
  const networkRef = useRef<Network | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async () => {
    if (!selectedProjectId) {
      setGraph({ nodes: [], edges: [] })
      setStats(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [graphData, statsData] = await Promise.all([
        (window.syntee as any).graph.get(selectedProjectId, { limit: 300 }) as Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>,
        (window.syntee as any).graph.stats(selectedProjectId) as Promise<GraphStats>,
      ])
      setGraph(graphData)
      setStats(statsData)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [selectedProjectId])

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
      // Размер: base 14 + weight*5 + degree*2, max 45
      const size = Math.min(45, 14 + n.weight * 5 + degree * 2)
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
          size: 14,
          face: 'system-ui, sans-serif',
          strokeWidth: 4,
          strokeColor: 'rgba(0,0,0,0.65)',
          vadjust: 0,
        },
        borderWidth: n.pinned ? 4 : 2,
        shadow: { enabled: true, color: meta.color + '50', size: 14, x: 0, y: 0 },
      }
    })

    const visEdges: VisEdge[] = filteredEdges.map(e => ({
      id: e.id,
      from: e.fromNode,
      to: e.toNode,
      title: EDGE_TYPE_LABELS[e.type] ?? e.type,
      color: {
        color: 'rgba(140, 140, 160, 0.22)',
        highlight: '#9ca3af',
        hover: '#9ca3af',
      },
      width: Math.max(1, Math.min(4, e.weight * 1.5)),
      arrows: { to: { enabled: true, scaleFactor: 0.5 } },
      smooth: { enabled: true, type: 'cubicBezier', roundness: 0.4 },
    }))

    const options: Options = {
      physics: {
        enabled: true,
        solver: 'barnesHut',
        barnesHut: {
          gravitationalConstant: -6000,
          centralGravity: 0.5,
          springLength: 100,
          springConstant: 0.08,
          damping: 0.12,
          avoidOverlap: 1.0,
        },
        stabilization: {
          enabled: true,
          iterations: 300,
          updateInterval: 25,
          fit: true,
        },
        maxVelocity: 50,
      },
      interaction: {
        hover: true,
        tooltipDelay: 150,
        navigationButtons: false,
        keyboard: true,
        zoomView: true,
        dragView: true,
        dragNodes: true,
      },
      layout: { improvedLayout: true, randomSeed: 42 },
      nodes: {
        borderWidth: 2,
        scaling: { min: 14, max: 45 },
      },
      edges: {
        scaling: { min: 1, max: 4 },
        smooth: { type: 'cubicBezier', roundness: 0.4 },
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
    if (!selectedProjectId) return
    setLoading(true)
    try {
      await (window.syntee as any).graph.rebuild(selectedProjectId)
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
    if (!selectedProjectId) return
    await (window.syntee as any).graph.pruneIsolated(selectedProjectId)
    await load()
  }

  const handleZoomIn = () => {
    const net = networkRef.current
    if (!net) return
    const scale = net.getScale()
    net.moveTo({ scale: scale * 1.3, animation: { duration: 200, easingFunction: 'easeInOutQuad' } })
  }

  const handleZoomOut = () => {
    const net = networkRef.current
    if (!net) return
    const scale = net.getScale()
    net.moveTo({ scale: Math.max(0.1, scale / 1.3), animation: { duration: 200, easingFunction: 'easeInOutQuad' } })
  }

  const handleZoomFit = () => {
    const net = networkRef.current
    if (!net) return
    net.fit({ animation: { duration: 400, easingFunction: 'easeInOutQuad' } })
  }

  const toggleFilter = (type: string) => {
    setFilterTypes(prev => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  // View mode presets: "memory" shows decisions/concepts/conversations/tasks,
  // "files" shows files/symbols, "all" shows everything.
  const applyViewMode = (mode: 'all' | 'memory' | 'files') => {
    setViewMode(mode)
    if (mode === 'memory') {
      setFilterTypes(new Set(['decision', 'concept', 'conversation', 'task']))
    } else if (mode === 'files') {
      setFilterTypes(new Set(['file', 'symbol']))
    } else {
      setFilterTypes(new Set())
    }
  }

  // Connected nodes для выбранного узла — вычисляем из graph.edges
  const connectedNodes = useMemo(() => {
    if (!selectedNode || !graph) return []
    const result: Array<{ id: string; label: string; type: string; edgeType: string; direction: 'out' | 'in' }> = []
    for (const e of graph.edges) {
      if (e.fromNode === selectedNode.id) {
        const target = graph.nodes.find(n => n.id === e.toNode)
        if (target) result.push({ id: target.id, label: target.label, type: target.type, edgeType: e.type, direction: 'out' })
      } else if (e.toNode === selectedNode.id) {
        const target = graph.nodes.find(n => n.id === e.fromNode)
        if (target) result.push({ id: target.id, label: target.label, type: target.type, edgeType: e.type, direction: 'in' })
      }
    }
    return result
  }, [selectedNode, graph])

  // ─── Render ──────────────────────────────────────────────────────────────

  if (!selectedProjectId) {
    return (
      <div className="memory-graph-empty">
        <div className="memory-graph-empty-icon-wrap">
          <AppIcon name="gitBranch" size="lg" tone="muted" />
        </div>
        <p>Выберите проект для просмотра графа знаний</p>
        <select
          className="memory-graph-project-select"
          value={selectedProjectId}
          onChange={(e) => onSelectProject(e.target.value)}
        >
          <option value="">— выберите проект —</option>
          {projects.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <span className="memory-graph-empty-hint">Граф строится автоматически из диалогов и решений проекта</span>
      </div>
    )
  }

  return (
    <div className="memory-graph-tab">
      {/* Toolbar */}
      <div className="memory-graph-toolbar">
        <select
          className="memory-graph-project-select"
          value={selectedProjectId}
          onChange={(e) => onSelectProject(e.target.value)}
        >
          {projects.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <div className="memory-graph-stats">
          {stats && (
            <>
              <div className="graph-stat-card">
                <span className="graph-stat-card-icon"><AppIcon name="layers" size="sm" tone="muted" /></span>
                <span className="graph-stat-card-value">{stats.nodeCount}</span>
                <span className="graph-stat-card-label">узлов</span>
              </div>
              <div className="graph-stat-card">
                <span className="graph-stat-card-icon"><AppIcon name="gitBranch" size="sm" tone="muted" /></span>
                <span className="graph-stat-card-value">{stats.edgeCount}</span>
                <span className="graph-stat-card-label">рёбер</span>
              </div>
              {stats.hubs.length > 0 && (
                <div className="graph-stat-hubs">
                  {stats.hubs.slice(0, 3).map(h => (
                    <span key={h.id} className="graph-hub-chip">
                      {h.label.length > 14 ? h.label.slice(0, 12) + '…' : h.label}
                      <span className="graph-hub-chip-degree">·{h.degree}</span>
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <div className="memory-graph-actions">
          <motion.button className="graph-action-btn" onClick={handlePruneIsolated} title="Удалить изолированные узлы" whileHover={whileHoverSm} whileTap={whileTapSm} transition={springHover}>
            <AppIcon name="trash" size="sm" /> Чистка
          </motion.button>
          <motion.button className="graph-action-btn graph-action-btn--primary" onClick={handleRebuild} disabled={loading} title="Полная перестройка" whileHover={whileHoverSm} whileTap={whileTapSm} transition={springHover}>
            <AppIcon name="refreshCw" size="sm" className={loading ? 'graph-action-btn-spinner' : ''} /> {loading ? '…' : 'Перестроить'}
          </motion.button>
        </div>
      </div>

      {/* View mode toggle: Memory / Files / All */}
      <div className="memory-graph-view-toggle">
        {(['all', 'memory', 'files'] as const).map(mode => (
          <motion.button
            key={mode}
            className={`graph-view-btn ${viewMode === mode ? 'graph-view-btn--active' : ''}`}
            onClick={() => applyViewMode(mode)}
            whileHover={whileHoverListItem}
            whileTap={whileTapListItem}
            transition={springHover}
          >
            {viewMode === mode && (
              <motion.span
                layoutId="graph-view-active"
                className="graph-view-btn-pill"
                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
              />
            )}
            <span className="graph-view-btn-label">
              {mode === 'all' ? 'Все' : mode === 'memory' ? 'Память' : 'Файлы'}
            </span>
          </motion.button>
        ))}
      </div>

      {/* Filters */}
      <div className="memory-graph-filters">
        <span className="filter-label">Типы:</span>
        {Object.entries(NODE_TYPE_META).map(([type, meta]) => (
          <motion.button
            key={type}
            className={`graph-filter-chip ${filterTypes.has(type) ? 'graph-filter-chip--active' : ''}`}
            style={filterTypes.has(type) ? { borderColor: meta.color, background: `${meta.color}22` } : {}}
            onClick={() => toggleFilter(type)}
            whileHover={whileHoverListItem}
            whileTap={whileTapListItem}
            transition={springHover}
          >
            <span className="filter-dot" style={{ background: meta.color }} />
            {meta.label}
          </motion.button>
        ))}
        {filterTypes.size > 0 && (
          <motion.button className="graph-filter-clear" onClick={() => setFilterTypes(new Set())} whileHover={whileHoverSm} whileTap={whileTapSm} transition={springHover}>
            Сбросить
          </motion.button>
        )}
      </div>

      {error && <div className="memory-graph-error">{error}</div>}

      <div className="memory-graph-content">
        {/* Graph canvas with overlays */}
        <div className="memory-graph-canvas-wrap">
          <div className="memory-graph-canvas" ref={containerRef} />

          {/* Legend overlay */}
          {graph && graph.nodes.length > 0 && (
            <div className="memory-graph-legend">
              <div className="memory-graph-legend-title">Типы узлов</div>
              {Object.entries(NODE_TYPE_META).map(([type, meta]) => {
                const count = graph.nodes.filter(n => n.type === type).length
                if (count === 0) return null
                return (
                  <div
                    key={type}
                    className={`memory-graph-legend-item ${filterTypes.size > 0 && !filterTypes.has(type) ? 'memory-graph-legend-item--off' : ''}`}
                    onClick={() => toggleFilter(type)}
                  >
                    <span className="memory-graph-legend-dot" style={{ background: meta.color, color: meta.color }} />
                    {meta.label}
                    <span className="memory-graph-legend-count">{count}</span>
                  </div>
                )
              })}
              {filterTypes.size > 0 && (
                <div
                  className="memory-graph-legend-item"
                  onClick={() => setFilterTypes(new Set())}
                  style={{ marginTop: 2, color: 'var(--accent)', fontWeight: 600 }}
                >
                  ↺ Показать все
                </div>
              )}
            </div>
          )}

          {/* Zoom controls */}
          <div className="memory-graph-zoom">
            <motion.button className="memory-graph-zoom-btn" onClick={handleZoomIn} title="Приблизить" whileHover={whileHoverTiny} whileTap={whileTapTiny} transition={springHover}>
              <AppIcon name="plus" size="sm" />
            </motion.button>
            <motion.button className="memory-graph-zoom-btn" onClick={handleZoomOut} title="Отдалить" whileHover={whileHoverTiny} whileTap={whileTapTiny} transition={springHover}>
              <AppIcon name="minus" size="sm" />
            </motion.button>
            <motion.button className="memory-graph-zoom-btn" onClick={handleZoomFit} title="Вписать в экран" whileHover={whileHoverTiny} whileTap={whileTapTiny} transition={springHover}>
              <AppIcon name="maximize" size="sm" />
            </motion.button>
          </div>
        </div>

        {/* Side panel: selected node */}
        <AnimatePresence>
          {selectedNode && (
            <motion.div
              className="memory-graph-sidepanel"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ type: 'spring', stiffness: 360, damping: 30 }}
            >
              <div className="sidepanel-header">
                <span
                  className="sidepanel-type-badge"
                  style={{ background: NODE_TYPE_META[selectedNode.type]?.color ?? '#6b7280' }}
                >
                  {NODE_TYPE_META[selectedNode.type]?.label ?? selectedNode.type}
                </span>
                <motion.button className="sidepanel-close" onClick={() => setSelectedNode(null)} whileHover={whileHoverTiny} whileTap={whileTapTiny} transition={springHover}>×</motion.button>
              </div>
              <div className="sidepanel-body">
                <div className="sidepanel-label">{selectedNode.label}</div>

                {/* Metadata grid */}
                <div>
                  <div className="sidepanel-section-title">Метаданные</div>
                  <div className="sidepanel-meta">
                    <div className="sidepanel-meta-item">
                      <span className="sidepanel-meta-key">Weight</span>
                      <span className="sidepanel-meta-value">{selectedNode.weight.toFixed(1)}</span>
                    </div>
                    <div className="sidepanel-meta-item">
                      <span className="sidepanel-meta-key">Pinned</span>
                      <span className="sidepanel-meta-value">{selectedNode.pinned ? '★ да' : 'нет'}</span>
                    </div>
                    {selectedNode.sourceKind && (
                      <div className="sidepanel-meta-item">
                        <span className="sidepanel-meta-key">Источник</span>
                        <span className="sidepanel-meta-value">{selectedNode.sourceKind}</span>
                      </div>
                    )}
                    {connectedNodes.length > 0 && (
                      <div className="sidepanel-meta-item">
                        <span className="sidepanel-meta-key">Связей</span>
                        <span className="sidepanel-meta-value">{connectedNodes.length}</span>
                      </div>
                    )}
                  </div>
                  {selectedNode.sourceId && (
                    <div className="sidepanel-source-id" style={{ marginTop: 8 }}>
                      <code>{selectedNode.sourceId.slice(0, 40)}</code>
                    </div>
                  )}
                </div>

                {/* Connected nodes */}
                {connectedNodes.length > 0 && (
                  <div>
                    <div className="sidepanel-section-title">Связанные узлы ({connectedNodes.length})</div>
                    <div className="sidepanel-connections">
                      {connectedNodes.slice(0, 8).map(cn => {
                        const meta = NODE_TYPE_META[cn.type] ?? { color: '#6b7280', label: cn.type }
                        return (
                          <div
                            key={cn.id + cn.edgeType + cn.direction}
                            className="sidepanel-connection-chip"
                            onClick={() => {
                              const node = graph?.nodes.find(n => n.id === cn.id)
                              if (node) setSelectedNode(node)
                            }}
                          >
                            <span className="sidepanel-connection-dot" style={{ background: meta.color }} />
                            <span className="sidepanel-connection-label">{cn.label}</span>
                            <span className="sidepanel-connection-type">
                              {cn.direction === 'out' ? '→' : '←'} {EDGE_TYPE_LABELS[cn.edgeType] ?? cn.edgeType}
                            </span>
                          </div>
                        )
                      })}
                      {connectedNodes.length > 8 && (
                        <div className="sidepanel-connections-more">
                          и ещё {connectedNodes.length - 8}…
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="sidepanel-actions">
                  <motion.button className="sidepanel-btn" onClick={() => handlePin(selectedNode.id, !selectedNode.pinned)} whileHover={whileHoverSm} whileTap={whileTapSm} transition={springHover}>
                    <AppIcon name="pin" size="sm" /> {selectedNode.pinned ? 'Открепить' : 'Закрепить'}
                  </motion.button>
                  <motion.button className="sidepanel-btn sidepanel-btn--danger" onClick={() => handleDelete(selectedNode.id)} whileHover={whileHoverSm} whileTap={whileTapSm} transition={springHover}>
                    <AppIcon name="trash" size="sm" /> Удалить
                  </motion.button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
