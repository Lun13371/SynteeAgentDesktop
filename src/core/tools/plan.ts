import { homedir } from 'os'
import { join } from 'path'
import { writeFile as fsWriteFile } from 'fs/promises'
import { writeFileSync, mkdirSync } from 'fs'
import { ensureDirFor } from './_shared'

// ── savePlanToFile — хелпер записи готового плана в .md ─────────────────────
// Вызывается из main/ipc/chat.ipc.ts в конце planning-turn'а, после того как
// из ответа модели извлечён <plan>-блок. Тул save_plan удалён — модель пишет
// план прямо в ответе, обёрнутый в <plan title="..." summary="...">…</plan>.
export async function savePlanToFile(params: {
  title: string
  content: string
  summary: string
}): Promise<string> {
  const plansDir = join(homedir(), 'Documents', 'Syntee', 'Plans')
  const safeName = sanitizePlanName(params.title)
  const filePath = join(plansDir, `plan_${safeName}.md`)
  await ensureDirFor(filePath)
  const fullContent = `# ${params.title}\n\n> ${params.summary}\n\n${params.content}`
  await fsWriteFile(filePath, fullContent, 'utf-8')
  return filePath
}

/**
 * Синхронная версия — используется в sendDone (chat.ipc.ts), где нельзя
 * await'ить (буферный флоу вокруг). Создаёт директорию и пишет файл sync.
 */
export function savePlanToFileSync(params: {
  title: string
  content: string
  summary: string
}): string {
  const plansDir = join(homedir(), 'Documents', 'Syntee', 'Plans')
  try {
    mkdirSync(plansDir, { recursive: true })
  } catch { /* already exists */ }
  const safeName = sanitizePlanName(params.title)
  const filePath = join(plansDir, `plan_${safeName}.md`)
  const fullContent = `# ${params.title}\n\n> ${params.summary}\n\n${params.content}`
  writeFileSync(filePath, fullContent, 'utf-8')
  return filePath
}

function sanitizePlanName(title: string): string {
  // eslint-disable-next-line no-control-regex
  return title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 80) || 'plan'
}
