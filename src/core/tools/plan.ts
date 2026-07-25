import { homedir } from 'os'
import { join } from 'path'
import { writeFile as fsWriteFile } from 'fs/promises'
import { ensureDirFor, type ToolResult } from './_shared'

// ── save_plan — только в режиме планирования ─────────────────────────────────
export async function savePlan(params: { title: string; content: string; summary: string }): Promise<ToolResult> {
  try {
    const plansDir = join(homedir(), 'Documents', 'Syntee', 'Plans')
    // Санитизируем имя файла
    const safeName = params.title
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/\s+/g, '_')
      .slice(0, 80) || 'plan'
    const filePath = join(plansDir, `plan_${safeName}.md`)
    await ensureDirFor(filePath)
    const fullContent = `# ${params.title}\n\n> ${params.summary}\n\n${params.content}`
    await fsWriteFile(filePath, fullContent, 'utf-8')
    return { success: true, output: filePath }
  } catch (e: unknown) {
    return { success: false, output: '', error: String(e) }
  }
}

export const PLAN_TOOL_SCHEMA = {
  type: 'function' as const,
  function: {
    name: 'save_plan',
    description: 'Сохраняет готовый план в .md файл. Вызывай ТОЛЬКО когда план полностью готов.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Краткое название плана (станет именем файла).' },
        content: { type: 'string', description: 'Полный текст плана в markdown формате.' },
        summary: { type: 'string', description: 'Одна строка — итоговый вердикт: что именно будет сделано.' },
      },
      required: ['title', 'content', 'summary'],
    },
  },
}
