import type { ProjectMapPromptInfo } from './_shared'

/** Session state only; navigation policy lives in the static system prompt. */
export function buildProjectMapBlock(info?: ProjectMapPromptInfo): string {
  // No project at all — stay silent instead of adding a dead line to the tail.
  if (!info) return ''
  const heading = '\n## Project map (code graph)'

  const { files, nodes, edges, state } = info
  if (nodes === 0 || state === 'idle' || state === 'error') {
    return `${heading} — unavailable (${state}; no usable index)\n`
  }

  const coverage = state === 'ready' ? '' : ' (some files or relationships may be missing)'
  return `${heading} — ${state}: ${files} indexed files, ${nodes} nodes, ${edges} edges${coverage}\n`
}
