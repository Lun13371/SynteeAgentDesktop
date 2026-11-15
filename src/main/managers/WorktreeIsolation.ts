import { app } from 'electron'
import { join } from 'path'
import { createHash } from 'crypto'
import { existsSync, writeFileSync, unlinkSync, rmSync, mkdirSync, readFileSync } from 'fs'
import type { Dirent } from 'fs'
import { readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { runGit, isGitRepo, GIT_TIMEOUT_MS } from '../git/runGit'

/**
 * Изоляция параллельных суб-агентов через git worktree.
 *
 * Проблема: без изоляции параллельные суб-агенты одного проекта пишут в одно
 * рабочее дерево → гонки записи. Даже sequential суб-агент правит файлы родителя
 * в обход его undoStack, портя undo/снапшоты.
 *
 * Решение: для каждого суб-агента в режиме изоляции создаётся отдельный
 * `git worktree` от HEAD родителя. После завершения дельта сливается обратно
 * через `git apply --3way`; при конфликте worktree оставляется для ручного
 * разбора (данные не теряются).
 *
 * Worktree-и кладутся в `userData/worktrees/<parentHash>/<agentId>/` — вне
 * project workdir, чтобы не плодить двойную индексацию fast-context (watcher
 * смотрит только project workdir) и не требовать правок IGNORED_DIRS_DEFAULT.
 */

export interface WorktreeInfo {
  worktreePath: string
  branch: string
  baseSha: string
}

export interface MergeFileSnapshot {
  path: string
  contentBefore: string | null
}

export interface MergeResult {
  ok: boolean
  conflict: boolean
  /** true — worktree оставлен (конфликт/ошибка) для ручного разбора; false — очищен. */
  worktreeKept: boolean
  /** Состояние файлов в родителе до применения дельты суб-агента. */
  fileSnapshots: MergeFileSnapshot[]
  error?: string
}

function worktreesRootFor(parentWorkdir: string): string {
  const parentHash = createHash('sha1').update(parentWorkdir).digest('hex').slice(0, 12)
  return join(app.getPath('userData'), 'worktrees', parentHash)
}

/**
 * Создаёт отдельный git worktree от HEAD родителя.
 * @returns null, если parentWorkdir — не git-репо (caller fallback на shared).
 */
export async function createSubagentWorktree(
  parentWorkdir: string,
  agentId: string,
): Promise<WorktreeInfo | null> {
  const repoOk = await isGitRepo(parentWorkdir)
  if (!repoOk) return null

  // Подчищаем битые метаданные от прошлых сессий (краши и т.п.).
  try { await runGit(parentWorkdir, ['worktree', 'prune']) } catch { /* noop */ }

  const worktreesRoot = worktreesRootFor(parentWorkdir)
  const worktreePath = join(worktreesRoot, agentId)
  const branch = `syntee-sub/${agentId}`

  // baseSha — точка ветвления (HEAD родителя на момент spawn). Сохраняем, чтобы
  // позже вычислить дельту суб-агента даже если он делал коммиты в своей ветке.
  const baseSha = (await runGit(parentWorkdir, ['rev-parse', 'HEAD'])).trim()

  // Если путь существует — это битый worktree от краха с тем же agentId
  // (коллизия практически невозможна: agentId = agent-<ts>-<rand>). Удаляем.
  if (existsSync(worktreePath)) {
    try { rmSync(worktreePath, { recursive: true, force: true }) } catch { /* noop */ }
  }
  try { mkdirSync(worktreesRoot, { recursive: true }) } catch { /* noop */ }

  // Создаём worktree от HEAD с новой веткой. Ветка удобнее для диагностики
  // (`git branch --list 'syntee-sub/*'`), чем detached HEAD.
  await runGit(parentWorkdir, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'])

  return { worktreePath, branch, baseSha }
}

/**
 * Сливает дельту суб-агента обратно в рабочий дерево родителя через
 * `git apply --3way`. 3way позволяет разрешать пересечения с WIP-правками
 * родителя, если контекст совпадает; при неразрешимом конфликте — non-zero
 * exit, worktree оставляется.
 *
 * Дельта вычисляется как `git -C <worktree> diff <baseSha>` — это diff между
 * точкой ветвления и текущим состоянием worktree (включая staged + unstaged
 * правки суб-агента, а также его коммиты в ветке).
 */
export async function mergeWorktreeBack(
  parentWorkdir: string,
  info: WorktreeInfo,
): Promise<MergeResult> {
  const fileSnapshots: MergeFileSnapshot[] = []
  // Проверяем, что worktree ещё существует (мог быть удалён вручную).
  // ok:false — раньше возвращался ok:true, и родительский агент считал, что
  // изменения применены, хотя их нет (тихая потеря данных).
  if (!existsSync(info.worktreePath)) {
    return {
      ok: false,
      conflict: false,
      worktreeKept: false,
      fileSnapshots,
      error: 'worktree не найден (удалён вручную?) — изменения суб-агента не применены',
    }
  }

  // §untracked — intent-to-add: файлы, СОЗДАННЫЕ суб-агентом (untracked), не
  // попадают в `git diff <baseSha>` (их нет в индексе) и раньше молча терялись
  // при cleanup worktree после merge. `git add -N` включает их в diff как
  // new-file-патчи без реального staging контента. Файлы под .gitignore так
  // и не переносятся — осознанное ограничение git.
  try {
    await runGit(info.worktreePath, ['add', '-N', '--', '.'])
  } catch { /* noop — продолжаем с обычным diff */ }

  let diff: string
  try {
    diff = await runGit(info.worktreePath, ['diff', '--no-color', info.baseSha])
  } catch (e: any) {
    return { ok: false, conflict: false, worktreeKept: true, fileSnapshots, error: `diff failed: ${e.message}` }
  }

  // Снимаем состояние родительских файлов ДО git apply. Это становится частью
  // undoStack родительского turn'а: изменения суб-агента должны откатываться
  // той же кнопкой, что и изменения основного агента.
  // Use NUL-delimited names (not diff headers): Git quotes paths with spaces,
  // Unicode, tabs, or backslashes in `diff --git a/... b/...`. --no-renames
  // reports both sides of a rename as delete+add so rollback captures the old
  // source file and the absent destination independently.
  let uniquePaths: string[] = []
  try {
    const nameOutput = await runGit(info.worktreePath, ['diff', '--name-only', '-z', '--no-renames', info.baseSha])
    uniquePaths = [...new Set(nameOutput.split('\0').filter(Boolean))]
  } catch {
    // Fall back to plain diff parser only if --name-only failed.
    uniquePaths = [...new Set([...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map(m => m[2]).filter(Boolean))]
  }
  for (const relativePath of uniquePaths) {
    const absolutePath = join(parentWorkdir, relativePath)
    try {
      fileSnapshots.push({
        path: absolutePath,
        contentBefore: existsSync(absolutePath) ? readFileSync(absolutePath, 'utf-8') : null,
      })
    } catch {
      fileSnapshots.push({ path: absolutePath, contentBefore: null })
    }
  }

  // Нет изменений — применять нечего, можно чистить.
  if (!diff.trim()) {
    return { ok: true, conflict: false, worktreeKept: false, fileSnapshots }
  }

  // Записываем diff во временный файл и применяем в родительском workdir.
  // `git apply --3way` требует доступа к git object store родителя (есть, т.к.
  // worktree shares один object store с родителем по умолчанию).
  const patchFile = join(tmpdir(), `syntee-merge-${info.branch.replace(/[^a-z0-9_-]/gi, '_')}-${Date.now()}.patch`)
  try {
    writeFileSync(patchFile, diff, 'utf-8')
    await runGit(parentWorkdir, ['apply', '--3way', '--whitespace=nowarn', patchFile])
    return { ok: true, conflict: false, worktreeKept: false, fileSnapshots }
  } catch (e: any) {
    // Non-zero exit — конфликт применения или ошибка. Оставляем worktree для
    // ручного разбора, чтобы данные суб-агента не потерялись. При этом сам
    // `git apply --3way` мог испачкать дерево родителя: конфликтные файлы
    // остаются в worktree с маркерами <<<<<<< (UU в index). Возвращаем их к
    // версии родителя (stage 2 = ours), чтобы дерево не пачкалось тихо.
    await revertUnmergedToOurs(parentWorkdir)
    return {
      ok: false,
      conflict: true,
      worktreeKept: true,
      fileSnapshots,
      error: `git apply --3way failed: ${e.message}`,
    }
  } finally {
    try { unlinkSync(patchFile) } catch { /* noop */ }
  }
}

/** Коды unmerged-статусов из `git status --porcelain`. */
const UNMERGED_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/**
 * Откат незавершённого `git apply --3way`: конфликтные (unmerged) файлы
 * возвращаются к версии родителя (stage 2 = ours) и рестейжатся — index и
 * рабочее дерево возвращаются к пред-применённому состоянию. Файлы, которые
 * apply успел применить чисто до конфликта, остаются применёнными — callers
 * предупреждают об этом в note к summary.
 */
async function revertUnmergedToOurs(workdir: string): Promise<void> {
  try {
    const status = await runGit(workdir, ['status', '--porcelain', '-z'])
    for (const entry of status.split('\0')) {
      if (!entry) continue
      if (!UNMERGED_CODES.has(entry.slice(0, 2))) continue
      const file = entry.slice(3)
      try {
        await runGit(workdir, ['checkout', '--ours', '--', file])
        await runGit(workdir, ['add', '--', file])
      } catch { /* нет stage 2 (напр. DD) — пропускаем */ }
    }
  } catch { /* noop */ }
}

/**
 * Есть ли в worktree незакоммиченные правки/новые файлы. Используется при
 * ошибке/краше суб-агента для решения: сохранить worktree (правки не терять)
 * или удалить (полезной работы нет).
 */
export async function hasWorktreeChanges(worktreePath: string): Promise<boolean> {
  try {
    const status = await runGit(worktreePath, ['status', '--porcelain'])
    return status.trim().length > 0
  } catch {
    return false
  }
}

/**
 * §worktree-gc — сносит build-артефакты у keep-нутого worktree (node_modules,
 * cargo target/). Они в .gitignore, т.е. данных суб-агента не несут и в
 * hasWorktreeChanges/merge-back не попадают — «сохранён для ручного разбора»
 * перестаёт весить гигабайты и сводится к мегабайтам правок.
 *
 * Ограничения против ложных срабатываний: глубина ≤ 3, `target/` сносится
 * только если рядом лежит Cargo.toml (rust-проект), `node_modules` — по имени.
 * Best-effort: любые ошибки (локи файлов и т.п.) не роняют caller'а.
 */
export async function stripIgnoredHeavyDirs(worktreePath: string): Promise<void> {
  const RM_OPTS = { recursive: true, force: true, maxRetries: 3, retryDelay: 200 } as const
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return
    let entries: Dirent[]
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)
      if (entry.name === 'node_modules') {
        try { await rm(full, RM_OPTS) } catch { /* локи файлов — не критично */ }
        continue
      }
      if (entry.name === 'target' && existsSync(join(dir, 'Cargo.toml'))) {
        try { await rm(full, RM_OPTS) } catch { /* локи файлов — не критично */ }
        continue
      }
      await walk(full, depth + 1)
    }
  }
  try { await walk(worktreePath, 0) } catch { /* noop — best effort */ }
}

/**
 * Финализирует «осиротевший» worktree — суб-агент убит рестартом приложения
 * (loadPersisted ремонтирует запись в 'cancelled', но worktree и ветка
 * syntee-sub/* раньше оставались навсегда, а правки терялись). Есть
 * изменения → worktree сохраняется, возвращается его путь (для note в
 * записи). Нет изменений или worktree уже нет → удаляется, возвращается null.
 */
export async function cleanupAbandonedWorktree(
  parentWorkdir: string,
  agentId: string,
): Promise<string | null> {
  const worktreePath = join(worktreesRootFor(parentWorkdir), agentId)
  const info: WorktreeInfo = { worktreePath, branch: `syntee-sub/${agentId}`, baseSha: '' }
  if (!existsSync(worktreePath)) {
    try { await discardWorktree(parentWorkdir, info) } catch { /* noop */ }
    return null
  }
  if (await hasWorktreeChanges(worktreePath)) {
    // §worktree-gc — сохранённому для разбора worktree build-артефакты не нужны.
    await stripIgnoredHeavyDirs(worktreePath)
    return worktreePath
  }
  try { await discardWorktree(parentWorkdir, info) } catch { /* noop */ }
  return null
}

/**
 * Удаляет worktree и ветку. Безусловный — вызывается при discard (error/cancel)
 * и при успешном cleanup после merge.
 *
 * Порядок: сначала физический rm папки, потом prune. НЕ `git worktree remove`:
 * он выполняется под жёстким таймаутом runGit (GIT_TIMEOUT_MS = 8 c), которого
 * не хватает на дерево с тяжёлым build-артефактами (cargo target/ — гигабайты,
 * десятки тысяч файлов на Windows) — таймаут глотался тихо, и «удалённый»
 * worktree оставался на диске. fs/promises.rm без таймаута и не блокирует
 * event loop main-процесса; исчезнувшую папку добивает `worktree prune`.
 */
export async function discardWorktree(
  parentWorkdir: string,
  info: WorktreeInfo,
): Promise<void> {
  try {
    if (existsSync(info.worktreePath)) {
      await rm(info.worktreePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    }
  } catch {
    // упало частично (локи антивируса и т.п.) — prune всё равно подчистит метаданные
  }
  try { await runGit(parentWorkdir, ['worktree', 'prune']) } catch { /* noop */ }
  try {
    await runGit(parentWorkdir, ['branch', '-D', info.branch])
  } catch {
    // ветка может быть захвачена или уже удалена — игнорируем
  }
}

/** Синоним для cleanup после успешного merge — та же логика, что и discard. */
export async function cleanupWorktree(
  parentWorkdir: string,
  info: WorktreeInfo,
): Promise<void> {
  return discardWorktree(parentWorkdir, info)
}

export { GIT_TIMEOUT_MS }
