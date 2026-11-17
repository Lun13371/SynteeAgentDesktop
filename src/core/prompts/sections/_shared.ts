/**
 * Shared types for system-prompt sections.
 * These are imported by the individual section builders and re-exported
 * from buildSystemPrompt.ts for backwards compatibility.
 */

import type { ProjectInstructions } from '../projectInstructions'
import type { Skill } from '../../../shared/types'

/** Plugin info for system-prompt injection (see shared/types/plugin.ts). */
export type PluginPromptInfo = import('../../../shared/types').PluginPromptInfo

/** Memory counters for the system prompt — agent sees how much memory it has. */
export interface MemoryStats {
  globalCount: number
  projectCount: number
  globalByKind: Record<string, number>
  projectByKind: Record<string, number>
}

/** Knowledge graph stats rendered in the system prompt — only the fields
 *  buildGraphStatsBlock actually shows (see memorySection.ts). */
export interface GraphStats {
  nodeCount: number
  edgeCount: number
  hubs: Array<{ label: string; degree: number }>
  recentDecisions: Array<{ label: string; targets: Array<{ label: string }> }>
  fileHubs?: Array<{ label: string; degree: number; topImports: string[] }>
}

/** One-shot skill — instructions temporarily injected for this run. */
export interface OneShotSkill {
  name: string
  instructions: string
}

/** Code-mode block params. */
export interface CodeModeBlockParams {
  workdir?: string
  projectContext?: string
  projectInstructions?: ProjectInstructions[] | ProjectInstructions | null
}

export type { ProjectInstructions, Skill }
