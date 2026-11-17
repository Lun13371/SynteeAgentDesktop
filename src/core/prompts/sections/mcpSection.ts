/**
 * Extension install paths reference — so the agent knows where to put
 * new skills and MCP servers when the user directly asks. Shown always
 * (even without workdir — then only global paths).
 */
export function buildInstallPathsBlock(workdir?: string, globalSkillsDir?: string, globalPluginsDir?: string): string {
  const skillsLines: string[] = []
  if (globalSkillsDir) skillsLines.push(`- Globally: ${globalSkillsDir.replace(/\\/g, '/')}/  (absolute path)`)
  if (workdir) skillsLines.push(`- In project:  .syntee/skills/  (relative to workdir)`)
  const mcpLines: string[] = ['- Globally: ~/.syntee/mcp.json']
  if (workdir) mcpLines.push('- In project:  .mcp.json  (relative to workdir)')
  const pluginLines: string[] = []
  if (globalPluginsDir) pluginLines.push(`- Globally: ${globalPluginsDir.replace(/\\/g, '/')}/{pluginId}/  (absolute path)`)
  if (workdir) pluginLines.push(`- In project:  .syntee/plugins/{pluginId}/  (relative to workdir)`)

  const pluginsSection = pluginLines.length > 0 ? `
Plugins (folder with plugin.json manifest + CJS entry):
${pluginLines.join('\n')}
plugin.json: { "id", "name", "version", "description", "promptDescription" (short, ~200 chars — goes into the system prompt), "main": "dist/index.js", "permissions": ["net","clipboard","notifications",...] }
Entry exports activate(syntee) / deactivate(). syntee API: registerTool({name, description, parameters, handler}), log(), storage.get/set/delete, clipboard, notifications, net.fetch (permission-gated). Plugin tools are named plugin__{pluginId}__{toolName}.` : ''

  return `## Where to install extensions

Skills (.md with YAML frontmatter: name, description + instruction body):
${skillsLines.join('\n')}

MCP servers (JSON, Claude Code format):
${mcpLines.join('\n')}
Record format:
\`\`\`
{ "mcpServers": { "<name>": { "command": "...", "args": [...], "env": {...} } } }
\`\`\`
For a remote server instead of command/args: { "url": "https://...", "type": "streamable-http" }

On install: do NOT delete existing entries — add a new key. Do NOT invent secrets/env-vars — ask the user. MCP connects automatically after writing the file.${pluginsSection}`
}
