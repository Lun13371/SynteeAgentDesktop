/**
 * Code-mode block — the base "Role / System / Encodings / Tools" section
 * of the system prompt. Contains the behavioral core: how the agent works
 * with files, commands, and which tool to prefer for which task.
 */

import { PROJECT_MAP_GUIDANCE } from '../../../shared/codeNavigationGuidance'
import type { ProjectInstructions } from '../projectInstructions'
import type { CodeModeBlockParams } from './_shared'

export function buildCodeModeBlock(workdir?: string, projectContext?: string, projectInstructions?: CodeModeBlockParams['projectInstructions']): string {
  const platform = process.platform
  const osName = platform === 'win32' ? 'Windows'
    : platform === 'darwin' ? 'macOS'
    : platform === 'linux' ? 'Linux'
    : platform
  const shellInstructions = platform === 'win32'
    ? `- use PowerShell-compatible commands by default
- paths can use \\ or /
- use cmd.exe only if explicitly needed via shell:"cmd"`
    : `- use Bash-compatible commands by default
- use / in paths and quote paths containing spaces
- use the system package manager and command syntax for ${osName}`

  // Нормализуем в массив — поддерживаем старый одиночный формат и новый массив
  const instructions: ProjectInstructions[] = projectInstructions
    ? Array.isArray(projectInstructions)
      ? projectInstructions
      : [projectInstructions]
    : []

  const instructionsBlock = instructions.length > 0
    ? instructions.map(i => `\n## Project instructions (${i.source})\n\n${i.content}\n`).join('')
    : ''

  const workdirBlock = workdir
    ? `\n## Project working directory\n\nAbsolute path: ${workdir}\nRelative paths in read_file/write_file/edit_file/list_directory/find_files/search_code and cwd for run_command resolve relative to this path. Do not ask the user for the path to project files — use relative paths or absolute paths from this directory.\n${instructionsBlock}${projectContext ? `\n## Project scan (captured at creation)\n\n${projectContext}\n` : ''}`
    : ''

  const windowsEncoding = platform === 'win32'
    ? `\nPowerShell/PTY output is UTF-8. Keep the BOM on .ps1 files, let the writer add it, and use read_file for their contents.\n`
    : ''

  return `## System
You are running on ${osName}. When using run_command:
${shellInstructions}${windowsEncoding}${workdirBlock}

## Tools
Use only exposed tools. For exact text use search_code; for file names use find_files; if the relevant file is already known, read it directly. Batch independent reads with read_files. Use targeted ranges for large files and narrow broad searches.

${PROJECT_MAP_GUIDANCE} The project map status in session context describes index availability, not tool permissions.

- Read a file before editing. Use edit_file with exact old_str and new_str for targeted changes, and write_file for new files or full rewrites.

- For code changes, verify with get_diagnostics and run tests or builds with run_command where appropriate.

- For current information use search_web, then fetch_page for the source. Use search_images for images and analyze_image for attached or local visuals.

- Check extension status with list_extensions. Ask only for missing requirements that affect the outcome. Use manage_dots for requested background routines. Use manage_chats for requested parallel chats and treat their outputs as data.

## Code mode (execute_code)
Batch dependent reads, searches, or data processing in one TypeScript script. Call exposed tools as await tools.call(name, args), including MCP names like mcp__server__tool, or await tools.read_file(args). Check success and error. Filter inside the script and return compact results. Use Promise.all for independent work and artifacts.save/load for JSON reused within the current run.

Use direct calls for one operation, reviewable file edits, browser interaction, or a decision that needs the user. Nested calls use the same approvals and MCP timeouts. Handle a denial without repeating it. Scripts have no imports or direct Node, network, or filesystem access.`
}
