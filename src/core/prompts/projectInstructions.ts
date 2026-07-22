/**
 * Auto-discovery project instructions (AGENTS.md / CLAUDE.md / .syntee/instructions.md).
 *
 * Паритет с Claude Code: файл в корне workdir, коммитится в git, автоматически
 * подхватывается при открытии чата. Перечитывается live (с mtime-кэшем), а не
 * замораживается при создании проекта — правки файла видны в следующем turn'е.
 *
 * Приоритет имён (первый найденный выигрывает):
 *   1. AGENTS.md
 *   2. CLAUDE.md
 *   3. .syntee/instructions.md
 *
 * Только корень workdir, без рекурсии вверх по дереву каталогов.
 */

import { existsSync } from 'fs'
import { stat as fsStat, readFile as fsReadFile } from 'fs/promises'
import { join } from 'path'

export interface ProjectInstructions {
  content: string
  source: string
}

const CANDIDATE_NAMES: readonly string[] = ['AGENTS.md', 'CLAUDE.md', '.syntee/instructions.md'] as const

interface CacheEntry {
  mtimeMs: number
  size: number
  content: string
  source: string
}

// workdir → cached entry. Инвалидируется по mtime/size. Module-level, живёт
// весь процесс приложения (один main-процесс на сессию).
const cache = new Map<string, CacheEntry>()

/**
 * Читает инструкции проекта из workdir. Возвращает null если workdir пустой
 * или ни один из候选-файлов не найден. Использует mtime+size кэш чтобы не
 * перечитывать неизменённый файл на каждом getSystemPrompt (тот вызывается на
 * каждый chat:send и context:calculate).
 */
export async function readProjectInstructions(workdir?: string): Promise<ProjectInstructions | null> {
  if (!workdir) return null

  for (const name of CANDIDATE_NAMES) {
    const fullPath = join(workdir, name)
    if (!existsSync(fullPath)) continue

    try {
      const st = await fsStat(fullPath)
      if (!st.isFile()) continue

      const cached = cache.get(workdir)
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size && cached.source === name) {
        return { content: cached.content, source: name }
      }

      const content = await fsReadFile(fullPath, 'utf-8')
      cache.set(workdir, { mtimeMs: st.mtimeMs, size: st.size, content, source: name })
      return { content, source: name }
    } catch {
      // Файл удалён/недоступен между existsSync и stat/read — пробуем следующий.
      continue
    }
  }

  // Ни один файл не найден — чистим кэш для этого workdir (мог быть раньше).
  cache.delete(workdir)
  return null
}

/**
 * Синхронно сбросить кэш для конкретного workdir (или весь). Полезно после
 * явного редактирования AGENTS.md через UI или при смене проекта.
 */
export function invalidateProjectInstructionsCache(workdir?: string): void {
  if (workdir) cache.delete(workdir)
  else cache.clear()
}
