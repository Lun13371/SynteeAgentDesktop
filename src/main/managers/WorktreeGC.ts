import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import type { Dirent } from 'fs'
import { readdir, rm, stat } from 'fs/promises'
import { loadAllSubagents } from '../../core/db/subagents'
import { runGit } from '../git/runGit'

/**
 * §worktree-gc — сборка мусора keep-нутых git-worktree суб-агентов.
 *
 * Проблема: worktree, сохранённый «для ручного разбора» (merge-конфликт при
 * done, ошибка суб-агента с правками, рестарт), раньше не поднимался никем
 * никогда — папки в userData/worktrees/<parentHash>/<agentId>/ жили вечно и
 * тянули гигабайты build-артефактов (cargo target/, node_modules), невидимых
 * для git status. Ветку `syntee-sub/*` в родительском репо подчищает
 * discardWorktree / cleanupAbandonedWorktree — но только в сценариях, где
 * cleanup вообще вызывается.
 *
 * Решение: свип папки worktrees/ при старте приложения, строго ПОСЛЕ
 * loadPersisted() (он ремонтирует running/pending → cancelled, поэтому всё,
 * что осталось в папке, — deliberately-kept или сирота):
 *   - папка без записи в БД (или запись не worktree-изоляции) → сирота
 *     (крах до persist) → удалить;
 *   - запись running/pending → живая, не трогаем;
 *   - запись старше WORKTREE_TTL_MS → удалить папку + ветку syntee-sub/* в
 *     родительском репо (best-effort: workdir мог быть уже удалён).
 *
 * TTL = 4 дня: достаточно, чтобы заметить и спасти правки из note в summary,
 * но мусор не копится неделями. Правки суб-агентов после TTL считаются
 * устаревшими: родительский проект за это время уезжает далеко вперёд,
 * ручной merge 18-дневней давности всё равно неразрешим безболезненно.
 */

export const WORKTREE_TTL_MS = 4 * 24 * 60 * 60 * 1000

const RM_OPTS = { recursive: true, force: true, maxRetries: 3, retryDelay: 200 } as const

/** Размер папки (best-effort: исчезнувшие файлы просто пропускаем). */
async function dirSize(path: string): Promise<number> {
  let total = 0
  const stack: string[] = [path]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: Dirent[]
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else {
        try { total += (await stat(full)).size } catch { /* файл исчез — не важно */ }
      }
    }
  }
  return total
}

async function removeDir(path: string): Promise<void> {
  try { await rm(path, RM_OPTS) } catch { /* локи антивируса и т.п. — не роняем свип */ }
}

/**
 * Свип stale/осиротевших worktree. Вызывается фоном после init() — не
 * блокирует запуск, но до завершения удаляемые папки продолжают занимать
 * место (на 10+ ГБ первом прогоне счёт и удаление могут занять до минуты).
 * Возвращает освобождённые байты.
 */
export async function sweepStaleWorktrees(): Promise<number> {
  const root = join(app.getPath('userData'), 'worktrees')
  if (!existsSync(root)) return 0

  // Свежий снимок БД: loadPersisted уже сохранил ремонт running/pending →
  // cancelled, поэтому статусам здесь можно верить.
  const records = new Map(loadAllSubagents().map(row => [row.id, row]))
  let freed = 0
  let removed = 0

  for (const parentHash of await readdir(root, { withFileTypes: true })) {
    if (!parentHash.isDirectory()) continue
    const parentDir = join(root, parentHash.name)
    for (const agentDir of await readdir(parentDir, { withFileTypes: true })) {
      if (!agentDir.isDirectory()) continue
      const worktreePath = join(parentDir, agentDir.name)
      const row = records.get(agentDir.name)

      // Сирота: записи нет, либо worktree-изоляция не была активна — папка
      // от краха до persist. Ветки в репо не знаем (хеш workdir
      // необратим) — метаданные подчистит `worktree prune` при следующем
      // создании worktree этим родителем (WorktreeIsolation.createSubagentWorktree).
      if (!row || row.isolationMode !== 'worktree' || !row.workdir) {
        freed += await dirSize(worktreePath)
        await removeDir(worktreePath)
        removed++
        continue
      }

      // Живой суб-агент — не трогаем.
      if (row.status === 'running' || row.status === 'pending') continue

      const finishedAt = row.finishedAt ?? row.createdAt
      if (Date.now() - finishedAt < WORKTREE_TTL_MS) continue

      freed += await dirSize(worktreePath)
      await removeDir(worktreePath)
      removed++
      // Ветка в родительском репо — best-effort: workdir мог быть удалён.
      try { await runGit(row.workdir, ['branch', '-D', `syntee-sub/${row.id}`]) } catch { /* noop */ }
      try { await runGit(row.workdir, ['worktree', 'prune']) } catch { /* noop */ }
    }
  }

  if (removed > 0) {
    console.log(`[WorktreeGC] removed ${removed} stale worktrees, freed ${(freed / 1024 / 1024).toFixed(1)} MB`)
  }
  return freed
}
