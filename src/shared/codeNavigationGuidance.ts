// Keep the main agent and sub-agents on the same code-navigation policy.
export const PROJECT_MAP_GUIDANCE = 'For code structure (callers, dependencies, code paths, or change impact), start with project_map when exposed and the index is usable. Use semantic for a concept without a known symbol, search for a named symbol, callers/callees for call relationships, path to connect two nodes, and affected for change impact. Reserve overview for a project-wide survey. If the graph is unavailable or inconclusive, fall back to targeted search and source reads. Verify important findings in the source: a partial or heuristic graph is not proof of absence.'

export function buildSubagentMapGuidance(options: { hasProject: boolean; hasMapTool: boolean; isolatedWorktree: boolean }): string {
  if (!options.hasProject || !options.hasMapTool) return ''
  const worktreeNote = options.isolatedWorktree
    ? '\nThe index is for the parent project, not this isolated worktree. Treat graph results as hints; verify paths and current code in your worktree using relative paths.'
    : ''
  return `\n\n## Tools — code navigation\n\n${PROJECT_MAP_GUIDANCE}${worktreeNote}`
}
