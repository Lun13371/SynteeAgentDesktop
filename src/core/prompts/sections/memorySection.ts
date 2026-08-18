/**
 * Memory / knowledge-graph / notes blocks — the agent sees how much memory
 * it has, the project structure, and which project notes exist.
 */

import type { MemoryStats, GraphStats, NotesInfo } from './_shared'

/**
 * Memory stats block — the agent sees how much memory it has.
 * Shows global vs project counters, breakdown by kind.
 * If stats not provided — empty string.
 */
export function buildMemoryStatsBlock(stats?: MemoryStats): string {
  if (!stats) return ''
  const kindLabels: Record<string, string> = {
    user_fact: 'user facts',
    project_decision: 'decisions',
    convention: 'conventions',
    conversation: 'dialogs',
    agent_outcome: 'lessons',
  }
  const globalBreakdown = Object.entries(stats.globalByKind)
    .filter(([, c]) => c > 0)
    .map(([k, c]) => `${kindLabels[k] ?? k}: ${c}`)
    .join(', ') || 'empty'
  const projectBreakdown = stats.projectCount > 0
    ? Object.entries(stats.projectByKind)
        .filter(([, c]) => c > 0)
        .map(([k, c]) => `${kindLabels[k] ?? k}: ${c}`)
        .join(', ') || 'empty'
    : 'empty'

  let block = `\n## Memory (long-term)\nGlobal: ${stats.globalCount} (${globalBreakdown})\nProject: ${stats.projectCount} (${projectBreakdown})\nUse recall_memory to find what you need, save_memory to save the work outcome.\n`

  // Dynamic hints based on stats — guide the agent toward better memory hygiene.
  const totalMemories = stats.globalCount + stats.projectCount
  if (totalMemories > 30) {
    block += `💡 ${totalMemories} memories — recall_memory before answering project questions.\n`
  }
  if (stats.projectCount === 0) {
    block += `⚠ No project memories — save decisions/conventions as you learn them.\n`
  }
  if ((stats.projectByKind.conversation ?? 0) === 0 && (stats.globalByKind.conversation ?? 0) === 0) {
    block += `💡 No past dialog outcomes — save_memory at end of task.\n`
  }

  return block
}

/**
 * Knowledge graph stats block — the agent sees the project structure.
 * Shows node/edge counts by type, hub nodes, recent decisions.
 * If stats not provided or graph is empty — empty string.
 */
export function buildGraphStatsBlock(stats?: GraphStats): string {
  if (!stats || stats.nodeCount === 0) return ''

  const nodeTypeLabels: Record<string, string> = {
    decision: 'decisions',
    concept: 'concepts',
    file: 'files',
    symbol: 'symbols',
    conversation: 'dialogs',
    task: 'tasks',
  }
  const nodeBreakdown = Object.entries(stats.byNodeType)
    .filter(([, c]) => c > 0)
    .map(([t, c]) => `${nodeTypeLabels[t] ?? t}: ${c}`)
    .join(', ') || 'empty'

  const hubsStr = stats.hubs
    .filter(h => h.degree > 0)
    .slice(0, 3)
    .map(h => `${h.label}(${h.degree})`)
    .join(', ')

  const decisionsStr = stats.recentDecisions
    .slice(0, 3)
    .map(d => {
      const targets = d.targets.slice(0, 3).map(t => t.label).join(', ')
      return `  - ${d.label}${targets ? ` → ${targets}` : ''}`
    })
    .join('\n')

  let block = `\n## Project knowledge graph\nNodes: ${stats.nodeCount} (${nodeBreakdown})\nEdges: ${stats.edgeCount}\n`
  if (hubsStr) block += `Hubs: ${hubsStr}\n`
  if (decisionsStr) block += `Recent decisions:\n${decisionsStr}\n`

  // File relationships — top connected files with their imports
  if (stats.fileHubs && stats.fileHubs.length > 0) {
    const fileLines = stats.fileHubs
      .filter(fh => fh.degree > 0)
      .slice(0, 5)
      .map(fh => {
        const imports = fh.topImports.length > 0 ? ` →imports→ ${fh.topImports.join(', ')}` : ''
        return `  - ${fh.label}(${fh.degree} links)${imports}`
      })
      .join('\n')
    if (fileLines) block += `File relationships:\n${fileLines}\n`
  }

  block += `Use get_graph for details and mermaid visualization.\n`

  // Dynamic hints based on graph stats — guide the agent toward graph usage.
  if (stats.edgeCount < stats.nodeCount * 0.3 && stats.nodeCount > 5) {
    block += `⚠ Few edges — graph connections may be incomplete.\n`
  }
  if (stats.nodeCount > 20) {
    block += `💡 Graph has ${stats.nodeCount} nodes — use get_graph to explore project structure.\n`
  }
  if (stats.recentDecisions.length === 0) {
    block += `⚠ No recent decisions in graph — save project_decision to populate.\n`
  }

  return block
}

/**
 * Project notes block — the agent sees which notes exist in the project.
 * Only titles are shown (not content) to save tokens. The agent can use
 * manage_notes tool with action='list' to read full content.
 * If no notes or no info — empty string.
 */
export function buildNotesBlock(notesInfo?: NotesInfo): string {
  if (!notesInfo || notesInfo.count === 0) return ''
  const titles = notesInfo.notes.map((n, i) => `${i + 1}. ${n.title}`).join('\n')
  return `\n## Project notes (${notesInfo.count})\n${titles}\nUse manage_notes tool to read, create, update, or delete notes.\n`
}
