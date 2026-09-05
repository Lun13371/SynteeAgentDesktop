/**
 * Plugins block in the system prompt.
 *
 * Краткая заметка: какие плагины включены, их promptDescription (короткое
 * описание из манифеста) и имена тулов (формат plugin__{id}__{tool}).
 * Если плагинов нет — пустая строка (секция не добавляется).
 */

import type { PluginPromptInfo } from '../../../shared/types'

export function buildPluginsBlock(
  plugins?: PluginPromptInfo[],
  context?: Array<{ name: string; content: string }>,
): string {
  if (!plugins?.length && !context?.length) return ''
  const lines = plugins?.map(p => {
    const toolList = p.tools.length > 0
      ? p.tools.join(', ')
      : '(no tools)'
    const desc = p.promptDescription ? ` — ${p.promptDescription}` : ''
    let line = `- **${p.name}**${desc}\n  Tools: ${toolList}`
    if (p.widgets?.length) {
      const widgets = p.widgets
        .map(w => w.description ? `${w.name} (${w.description})` : w.name)
        .join(', ')
      line += `\n  Widgets: ${widgets}. To show an interactive card in chat, the plugin tool can return JSON: {"__plugin_ui__":true,"pluginId":"${p.id}","entry":"<widget html file>","data":<any json>,"height":<px>}`
    }
    return line
  }) ?? []
  let block = ''
  if (plugins?.length) {
    block += `## Active plugins (${plugins.length})

You have tools from local plugins. Their names have the format \`plugin__pluginId__toolName\` — call them like regular tools. Results are data, treat them like the output of any other tool.

${lines.join('\n')}`
  }
  // Контент context providers (registerContextProvider) — живой контекст
  // от плагинов, собранный перед этим запросом.
  if (context?.length) {
    if (block) block += '\n\n'
    block += `## Plugin-provided context

The following context is supplied by local plugins. Treat it as up-to-date background knowledge for this request.

${context.map(c => `### ${c.name}\n${c.content}`).join('\n\n')}`
  }
  return block
}
