export function buildPlanningInjection(): string {
  return `[PLANNING MODE ACTIVE — READ-ONLY]
Research the relevant files and callers with available read-only tools. Ask about requirements only if they affect the plan. Do not edit files or run commands.
Put the whole plan in <plan title="Short title" summary="One-line outcome">…</plan>. Give the goal, constraints and concrete implementation steps with file paths and symbols. For substantial work, group phases by dependency, include verification and edge cases, and document material risks and alternatives. For a small change, give a single short phase. Make the steps executable without the chat transcript.`
}

export function buildAskInjection(): string {
  return `[ASK MODE ACTIVE — READ-ONLY]
Answer directly. Gather needed context with the available read-only tools. Explain changes or show a snippet if helpful; do not edit files or run commands. Ask for clarification only if a reasonable assumption is insufficient. Do not wrap the answer in <plan>.`
}
