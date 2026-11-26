/**
 * graphExtractor — извлечение сущностей и связей для knowledge graph.
 *
 * Два подхода:
 *
 * 1. HEURISTIC (быстро, без LLM):
 *    - extractFromDecisionHeuristic: концепции из content decision/convention
 *
 * 2. LLM (умно, дорого):
 *    - extractFromConversationLLM: концепции, отношения из chat_summary
 *    - Вызывается после compaction (отдельный LLM-вызов, не в compaction prompt)
 *
 * Возвращает GraphExtraction — массив узлов и рёбер для graphBuilder.upsertMany.
 */

import type Store from 'electron-store'
import { AIClient } from '../ai/AIClient'
import { extractJsonFromLlmResponse } from '../ai/llmJson'
import { getDB } from '../db/handle'
import {
  upsertNode,
  upsertEdge,
  type NodeType,
  type EdgeType,
  type NodeSourceKind,
} from './graphStore'

// ─── Типы ────────────────────────────────────────────────────────────────────

export interface ExtractedNode {
  type: NodeType
  label: string
  sourceKind?: NodeSourceKind
  sourceId?: string
  metadata?: Record<string, unknown>
}

export interface ExtractedEdge {
  fromType: NodeType
  fromLabel: string
  toType: NodeType
  toLabel: string
  type: EdgeType
  metadata?: Record<string, unknown>
}

export interface GraphExtraction {
  nodes: ExtractedNode[]
  edges: ExtractedEdge[]
}

// ─── HEURISTIC: decision → concepts ──────────────────────────────────────────

/**
 * Извлечь сущности из decision (memory_item kind=project_decision) heuristically.
 * - Создаёт decision узел
 * - Извлекает концепции (tech terms + CamelCase)
 * - Связывает decision'ы с общими концепциями
 *
 * Синхронно: пишет в graphStore через upsertNode/upsertEdge.
 */
export function extractFromDecisionHeuristic(params: {
  projectId: string
  decisionLabel: string
  content: string
  memoryItemId: string
}): { nodes: number; edges: number } {
  const { projectId, decisionLabel, content, memoryItemId } = params
  let nodes = 0
  let edges = 0
  const db = getDB()

  // 1. Decision node
  const decisionLabelShort = decisionLabel.length > 100 ? decisionLabel.slice(0, 97) + '…' : decisionLabel
  const decisionId = upsertNode({
    projectId,
    type: 'decision',
    label: decisionLabelShort,
    sourceKind: 'memory_item',
    sourceId: memoryItemId,
    metadata: { content },
  })
  nodes++

  // 2. Concept extraction
  const conceptResult = extractConceptsHeuristic(projectId, decisionLabelShort, content)
  nodes += conceptResult.nodes
  edges += conceptResult.edges

  // 3. Cross-link: find other decisions that mention the same concepts
  for (const concept of conceptResult.concepts) {
    // Find existing concept node
    const conceptNode = db.prepare(
      `SELECT id FROM memory_graph_nodes WHERE project_id = ? AND type = 'concept' AND label = ?`
    ).get(projectId, concept) as { id: string } | undefined

    if (conceptNode) {
      // Find other decisions linked to this concept
      const linkedDecisions = db.prepare(
        `SELECT DISTINCT n.id, n.label FROM memory_graph_nodes n
         JOIN memory_graph_edges e ON (e.from_node = n.id AND e.to_node = ?)
                                   OR (e.to_node = n.id AND e.from_node = ?)
         WHERE n.project_id = ? AND n.type = 'decision' AND n.id != ?
         LIMIT 3`
      ).all(conceptNode.id, conceptNode.id, projectId, decisionId) as Array<{ id: string; label: string }>

      for (const ld of linkedDecisions) {
        upsertEdge({
          projectId,
          fromType: 'decision',
          fromLabel: decisionLabelShort,
          toType: 'decision',
          toLabel: ld.label,
          type: 'depends_on',
          metadata: { evidence: 'shared_concept', concept },
        })
        edges++
      }
    }
  }

  return { nodes, edges }
}

/**
 * Known technology/concept terms for heuristic extraction.
 * If any of these appear in text, a concept node is created.
 */
const TECH_TERMS = new Set([
  'TypeScript', 'JavaScript', 'React', 'Vue', 'Angular', 'Electron', 'Node',
  'Postgres', 'MySQL', 'SQLite', 'MongoDB', 'Redis',
  'JWT', 'OAuth', 'SAML', 'WebSocket', 'REST', 'GraphQL', 'gRPC',
  'Docker', 'Kubernetes', 'Nginx', 'Apache',
  'Webpack', 'Vite', 'Rollup', 'Babel', 'ESLint', 'Prettier',
  'Jest', 'Vitest', 'Cypress', 'Playwright',
  'Zustand', 'Redux', 'MobX', 'Pinia',
  'TF-IDF', 'FTS5', 'BM25', 'embedding', 'cosine',
  'OpenAI', 'Anthropic', 'LLM', 'GPT', 'Claude',
  'WAL', 'FTS', 'CRUD', 'ORM', 'DAO',
  'CSS', 'HTML', 'SCSS', 'Tailwind',
  'Python', 'Rust', 'Go', 'Java', 'Kotlin', 'Swift',
])

/**
 * Extract concepts from text heuristically.
 * - Finds known tech terms (case-sensitive match from TECH_TERMS)
 * - Finds CamelCase words > 5 chars (potential concepts)
 * Creates concept nodes + mentions edges from the source decision.
 */
function extractConceptsHeuristic(
  projectId: string,
  decisionLabel: string,
  content: string,
): { nodes: number; edges: number; concepts: string[] } {
  const nodes = 0
  let edges = 0
  const concepts = new Set<string>()

  // 1. Known tech terms (case-sensitive)
  for (const term of TECH_TERMS) {
    if (content.includes(term)) {
      concepts.add(term)
    }
  }

  // 2. CamelCase words > 5 chars (potential concept names)
  const camelMatches = content.match(/\b[A-Z][a-zA-Z]{4,}\b/g) ?? []
  for (const m of camelMatches) {
    // Skip common English words that aren't concepts
    if (m.length > 5 && !['The', 'This', 'That', 'These', 'Those', 'Which', 'There', 'Their', 'Where', 'When', 'What', 'Would', 'Could', 'Should', 'Always', 'Never'].includes(m)) {
      concepts.add(m)
    }
  }

  // Limit to avoid noise
  const conceptList = [...concepts].slice(0, 10)

  for (const concept of conceptList) {
    upsertEdge({
      projectId,
      fromType: 'decision',
      fromLabel: decisionLabel,
      toType: 'concept',
      toLabel: concept,
      type: 'mentions',
      toSourceKind: 'llm_extract',
      metadata: { evidence: 'heuristic_concept_match' },
    })
    edges++
  }

  return { nodes, edges, concepts: conceptList }
}

// ─── LLM: extract concepts & relations from conversation ─────────────────────

const GRAPH_EXTRACT_SYSTEM_PROMPT = `You are an entity and relationship extractor for a project knowledge graph.

Extract from the dialogue summary:
- concept: abstract entities, technologies, approaches ("authorization", "Postgres", "TF-IDF", "early return")
- decision: architectural decisions ("decided to use X", "convention — Y")
- task: specific tasks ("add migration", "fix auth bug")
- file: mentioned files (if there are full paths or basenames with extensions)
- symbol: mentioned functions/classes (CamelCase, not trivial words)

And relationships between them:
- affects: decision → file (decision affects file)
- mentions: decision/concept → symbol (mentions symbol)
- implemented_in: concept/symbol → file (where it is implemented)
- depends_on: decision → decision/concept (depends on)
- supersedes: decision → decision (new replaces old)
- references: conversation → decision/concept/file (dialogue references)

Answer — JSON only, no markdown:
{"nodes":[{"type":"concept|decision|task|file|symbol","label":"short name","evidence":"quote from text"}],"edges":[{"from":"label_from","fromType":"concept","to":"label_to","toType":"file","type":"affects"}]}

Rules:
- label — short name (no more than 80 characters), unique within the type
- If there are no entities — return {"nodes":[],"edges":[]}
- Do not invent relationships — only if there is evidence in the text
- Maximum 15 nodes and 20 edges per dialogue`

/**
 * LLM-извлечение концепций и связей из резюме диалога.
 * Вызывается после compaction (отдельный LLM-вызов).
 */
export async function extractFromConversationLLM(
  store: Store,
  params: {
    projectId: string
    chatId: string
    summary: string
  },
): Promise<{ extraction: GraphExtraction; error?: string }> {
  if (params.summary.trim().length < 50) {
    return { extraction: { nodes: [], edges: [] } }
  }

  const aiClient = new AIClient(store, { chatId: params.chatId, source: 'memory_graph' })
  const prompt = `Extract entities and relationships for the knowledge graph from the dialogue summary:

${params.summary.slice(0, 4000)}

Return JSON with nodes and edges.`

  let raw = ''
  try {
    await aiClient.streamChat(
      [{ role: 'user', content: prompt }],
      {
        onToken: (t) => { raw += t },
        onDone: () => {},
        onError: () => {},
      },
      'memory',
      GRAPH_EXTRACT_SYSTEM_PROMPT,
      undefined,
      0.1,
    )
  } catch (e) {
    return { extraction: { nodes: [], edges: [] }, error: (e as Error).message }
  }

  const parsed = extractJsonFromLlmResponse(raw) as { nodes?: unknown[]; edges?: unknown[]; files?: unknown[]; summary?: string; facts?: unknown[] } | null
  if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    return { extraction: { nodes: [], edges: [] }, error: 'invalid JSON response' }
  }

  const extraction: GraphExtraction = { nodes: [], edges: [] }
  const validNodeTypes: NodeType[] = ['decision', 'concept', 'file', 'symbol', 'conversation', 'task']
  const validEdgeTypes: EdgeType[] = [
    'affects', 'mentions', 'implemented_in', 'depends_on', 'supersedes',
    'references', 'imports', 'calls', 'implements',
  ]

  for (const n of parsed.nodes) {
    if (typeof n !== 'object' || n === null) continue
    const obj = n as Record<string, unknown>
    const type = typeof obj.type === 'string' ? obj.type as NodeType : null
    const label = typeof obj.label === 'string' ? obj.label.trim() : ''
    if (!type || !label || !validNodeTypes.includes(type)) continue
    const evidence = typeof obj.evidence === 'string' ? obj.evidence : undefined
    extraction.nodes.push({
      type,
      label: label.slice(0, 80),
      sourceKind: 'llm_extract',
      sourceId: params.chatId,
      metadata: evidence ? { evidence } : undefined,
    })
  }

  for (const e of parsed.edges) {
    if (typeof e !== 'object' || e === null) continue
    const obj = e as Record<string, unknown>
    const fromType = typeof obj.fromType === 'string' ? obj.fromType as NodeType : null
    const fromLabel = typeof obj.from === 'string' ? obj.from.trim() : ''
    const toType = typeof obj.toType === 'string' ? obj.toType as NodeType : null
    const toLabel = typeof obj.to === 'string' ? obj.to.trim() : ''
    const type = typeof obj.type === 'string' ? obj.type as EdgeType : null
    if (!fromType || !fromLabel || !toType || !toLabel || !type) continue
    if (!validNodeTypes.includes(fromType) || !validNodeTypes.includes(toType)) continue
    if (!validEdgeTypes.includes(type)) continue
    extraction.edges.push({
      fromType,
      fromLabel: fromLabel.slice(0, 80),
      toType,
      toLabel: toLabel.slice(0, 80),
      type,
    })
  }

  return { extraction }
}

// ─── Сохранение extraction в graphStore ──────────────────────────────────────

/**
 * Сохранить GraphExtraction в graphStore через upsertNode/upsertEdge.
 * Создаёт conversation node (для отслеживания источника) и связывает с extraction nodes.
 */
export function saveExtractionToGraph(
  projectId: string,
  extraction: GraphExtraction,
  options?: { conversationLabel?: string; chatId?: string },
): { nodes: number; edges: number } {
  let nodeCount = 0
  let edgeCount = 0

  // Conversation node (опционально) — связываем с извлечёнными сущностями через REFERENCES
  let convLabel: string | null = null
  if (options?.conversationLabel && options?.chatId) {
    convLabel = options.conversationLabel.slice(0, 80)
    upsertNode({
      projectId,
      type: 'conversation',
      label: convLabel,
      sourceKind: 'chat_summary',
      sourceId: options.chatId,
    })
    nodeCount++
  }

  // Nodes
  for (const n of extraction.nodes) {
    upsertNode({
      projectId,
      type: n.type,
      label: n.label,
      sourceKind: n.sourceKind ?? 'llm_extract',
      sourceId: n.sourceId,
      metadata: n.metadata,
    })
    nodeCount++

    // Link conversation → node
    if (convLabel) {
      upsertEdge({
        projectId,
        fromType: 'conversation',
        fromLabel: convLabel,
        toType: n.type,
        toLabel: n.label,
        type: 'references',
      })
      edgeCount++
    }
  }

  // Edges
  for (const e of extraction.edges) {
    upsertEdge({
      projectId,
      fromType: e.fromType,
      fromLabel: e.fromLabel,
      toType: e.toType,
      toLabel: e.toLabel,
      type: e.type,
      metadata: e.metadata,
    })
    edgeCount++
  }

  return { nodes: nodeCount, edges: edgeCount }
}
