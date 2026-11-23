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
  // partial считается пригодной: граф отвечает, просто может быть неполон.
  if (!info || (info.state !== 'ready' && info.state !== 'partial' && info.state !== 'building')) return ''
  const { files, nodes, edges, state } = info
  if (nodes === 0) return ''

  const status = state === 'ready'
    ? `ready — ${files} files, ${nodes} nodes, ${edges} edges`
    : state === 'partial'
    ? `partial — ${files} files, ${nodes} nodes, ${edges} edges (file inventory incomplete: some files may be missing)`
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
If the target is ambiguous, retry with a candidate nodeId (for path: pass the ID in query/to).
If analytics reports a truncated snapshot, verify missing paths or dependencies with search_code/read_file.
Read only the files the map points at, with offset/limit ranges.
`
}
