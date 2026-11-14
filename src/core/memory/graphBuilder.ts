/**
 * graphBuilder — orchestration: full rebuild + incremental updates.
 *
 * buildProjectGraph: полная перестройка графа проекта.
 *   1. Очистка старого графа
 *   2. Извлечение из всех memory_items kind=project_decision/convention (heuristic)
 *   3. Conversation nodes из chat_summaries
 *   4. Prune isolated nodes
 *
 * incrementalUpdateDecision: вызывается после save_memory kind=project_decision.
 *   Heuristic extraction из нового/обновлённого решения.
 *
 * incrementalUpdateConversation: вызывается после compaction.
 *   LLM extraction из нового chat_summary.
 */

import type Store from 'electron-store'
import { getDB } from '../db/handle'
import {
  deleteProjectGraph,
  pruneIsolatedNodes,
  upsertNode,
} from './graphStore'
import {
  extractFromDecisionHeuristic,
  extractFromConversationLLM,
  saveExtractionToGraph,
} from './graphExtractor'
import type { MemoryItem } from './MemoryStore'

// ─── FULL REBUILD ────────────────────────────────────────────────────────────

let _buildingProjects = new Set<string>()

/**
 * Полная перестройка графа проекта.
 * Удаляет ВСЕ узлы/рёбра проекта и строит заново из всех источников.
 *
 * @returns статистика: { nodes, edges, decisions, conversations }
 */
export function buildProjectGraph(projectId: string): {
  nodes: number
  edges: number
  decisions: number
  conversations: number
} {
  if (_buildingProjects.has(projectId)) {
    return { nodes: 0, edges: 0, decisions: 0, conversations: 0 }
  }
  _buildingProjects.add(projectId)
  try {
  // 1. Полная очистка графа проекта
  deleteProjectGraph(projectId)

  let totalNodes = 0
  let totalEdges = 0
  let decisions = 0
  let conversations = 0

  // 2. Извлечение из всех memory_items kind=project_decision (heuristic)
  const db = getDB()
  const decisionsRows = db.prepare(
    `SELECT id, title, content FROM memory_items
     WHERE scope = 'project' AND project_id = ? AND kind = 'project_decision'`
  ).all(projectId) as Array<{ id: string; title: string | null; content: string }>

  for (const row of decisionsRows) {
    const label = (row.title || row.content).slice(0, 80)
    const result = extractFromDecisionHeuristic({
      projectId,
      decisionLabel: label,
      content: row.content,
      memoryItemId: row.id,
    })
    totalNodes += result.nodes
    totalEdges += result.edges
    decisions++
  }

  // 2b. Извлечение из memory_items kind='convention' (heuristic)
  const conventionRows = db.prepare(
    `SELECT id, title, content FROM memory_items
     WHERE scope = 'project' AND project_id = ? AND kind = 'convention'`
  ).all(projectId) as Array<{ id: string; title: string | null; content: string }>

  for (const row of conventionRows) {
    const label = (row.title || row.content).slice(0, 80)
    const result = extractFromDecisionHeuristic({
      projectId,
      decisionLabel: label,
      content: row.content,
      memoryItemId: row.id,
    })
    totalNodes += result.nodes
    totalEdges += result.edges
  }

  // 3. Sync conversations из chat_summaries (без LLM — просто conversation nodes)
  const summaryRows = db.prepare(
    `SELECT cs.chat_id, cs.content, c.title
     FROM chat_summaries cs
     JOIN chats c ON c.id = cs.chat_id
     WHERE c.project_id = ?`
  ).all(projectId) as Array<{ chat_id: string; content: string; title: string }>

  for (const row of summaryRows) {
    if (row.content.trim().length < 50) continue
    const label = (row.title || `Чат ${row.chat_id.slice(0, 8)}`).slice(0, 80)
    upsertNode({
      projectId,
      type: 'conversation',
      label,
      sourceKind: 'chat_summary',
      sourceId: row.chat_id,
      metadata: { title: row.title, summary: row.content.slice(0, 200) },
    })
    totalNodes++
    conversations++
  }

  // 4. Prune isolated nodes (без рёбер, кроме pinned)
  pruneIsolatedNodes(projectId)

  return {
    nodes: totalNodes,
    edges: totalEdges,
    decisions,
    conversations,
  }
  } finally {
    _buildingProjects.delete(projectId)
  }
}

// ─── INCREMENTAL: decision ───────────────────────────────────────────────────

/**
 * Incremental update при save_memory kind=project_decision.
 * Heuristic extraction: концепции и связи.
 * Быстро, без LLM.
 */
export function incrementalUpdateDecision(item: MemoryItem): { nodes: number; edges: number } {
  if (!item.projectId) return { nodes: 0, edges: 0 }
  if (item.kind !== 'project_decision' && item.kind !== 'convention') return { nodes: 0, edges: 0 }

  return extractFromDecisionHeuristic({
    projectId: item.projectId,
    decisionLabel: (item.title || item.content).slice(0, 80),
    content: item.content,
    memoryItemId: item.id,
  })
}

// ─── INCREMENTAL: conversation (LLM) ────────────────────────────────────────

/**
 * Incremental update при compaction (новый chat_summary).
 * LLM extraction концепций и связей из резюме диалога.
 *
 * Cost-control: skip если summary короткий. Использует fast-модель.
 */
export async function incrementalUpdateConversation(
  store: Store,
  params: {
    projectId: string
    chatId: string
    summary: string
    chatTitle?: string
  },
): Promise<{ nodes: number; edges: number; error?: string }> {
  const { extraction, error } = await extractFromConversationLLM(store, {
    projectId: params.projectId,
    chatId: params.chatId,
    summary: params.summary,
  })

  if (error) {
    return { nodes: 0, edges: 0, error }
  }

  const convLabel = (params.chatTitle ?? `Чат ${params.chatId.slice(0, 8)}`).slice(0, 80)
  const result = saveExtractionToGraph(params.projectId, extraction, {
    conversationLabel: convLabel,
    chatId: params.chatId,
  })

  return result
}