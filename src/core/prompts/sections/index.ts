/**
 * System-prompt sections barrel — combines all section builders.
 */

export { buildCodeModeBlock } from './codeModeSection'
export { buildPlanningInjection, buildAskInjection } from './planningSection'
export { buildPersonaInjection } from './personaSection'
export { buildOneShotSkillBlock, buildSkillsBlock } from './skillsSection'
export { buildMcpBlock, buildInstallPathsBlock } from './mcpSection'
export { buildPluginsBlock } from './pluginsSection'
export { buildMemoryStatsBlock, buildGraphStatsBlock } from './memorySection'
export { buildSecretsBlock } from './secretsSection'
export type { ProtectedVarPromptInfo } from './secretsSection'

export type {
  McpPromptInfo,
  PluginPromptInfo,
  MemoryStats,
  GraphStats,
  PersonaInfo,
  PersonaSkill,
  OneShotSkill,
  CodeModeBlockParams,
} from './_shared'
