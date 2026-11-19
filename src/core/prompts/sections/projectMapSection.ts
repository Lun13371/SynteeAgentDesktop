/**
 * Project-map block — the agent learns it has a structural code map and that
 * structural questions are cheaper through it than through blind grep/read.
 *
 * Без этого блока тул `project_map` существовал, но агентом почти не
 * вызывался (1 вызов на 1538 тулов): в промпте не было ни слова о нём,
 * поэтому каждая навигация шла через search_code + read_file, съедая контекст.
 */

import type { ProjectMapPromptInfo } from './_shared'

export function buildProjectMapBlock(info?: ProjectMapPromptInfo): string {
  // Пока карты нет (не построена / ошибка) — не советуем инструмент впустую.
  if (!info || (info.state !== 'ready' && info.state !== 'building')) return ''
  const { files, nodes, edges, state } = info
  if (nodes === 0) return ''

  const status = state === 'ready'
    ? `ready — ${files} files, ${nodes} nodes, ${edges} edges`
    : `building in background (${files} files indexed so far)`

  return `\n## Project map (code graph) — ${status}
Use \`project_map\` BEFORE search_code/read_file for structural questions — it answers from the
indexed graph without pulling file contents into context:
- \`action="overview"\` — most-imported files/packages, size of the map (start here when unfamiliar)
- \`action="search"\` (symbol name) | \`action="semantic"\` (natural-language: "hashing", "сжатие истории")
- \`action="callers"\` / \`action="callees"\` — who uses X / what X uses (needs nodeId or query)
- \`action="file"\` — symbols + imports of a file (+ who imports it)
- \`action="god"\` (architecture hubs) | \`action="communities"\` (subsystems)
- \`action="path"\` (how A connects to B) | \`action="affected"\` (what breaks if X changes)
Edges carry precision: resolved (certain), heuristic (~ guess), ambiguous (?) — say so when it matters.
Read only the files the map points at, with offset/limit ranges.
`
}
