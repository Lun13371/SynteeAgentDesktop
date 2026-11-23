/**
 * Briefing continuity (git) — снапшот на стороне main-процесса.
 *
 * Раньше КАЖДЫЙ воркер запускал `git log` + `git status` сам (Agent.computeContinuity,
 * execFile внутри worker_thread) — лишняя пара процессов на каждый чат и на каждый
 * суб-агент, при том что результат меняется раз в коммит.
 *
 * Теперь main считает снапшот один раз на проект и переиспользует его:
 *  - подпись репозитория снимается БЕЗ запуска git: mtime+size у `.git/HEAD`,
 *    resolved-ref файла, `packed-refs` и `.git/index`. Пока подпись та же —
 *    коммиты не менялись;
 *  - изменённые файлы (git status) консультируются по mtime/size самих файлов
 *    из прошлого снапшота: если ни один не тронут, git не запускаем вовсе
 *    (TTL только продлевается). Явный список changedFiles от вызывающего
 *    учитывается так же — «нерелевантные» пути (docs/lock/dist/node_modules)
 *    не повод перезапускать git;
 *  - coalescing: параллельные чаты одного проекта ждут один и тот же promise;
 *  - peekBriefingContinuity() — синхронный доступ к уже посчитанному снапшоту
 *    (для путей, которым нельзя ждать).
 *
 * Воркеру снапшот приходит строкой в workerData (`briefingContinuity`) — см.
 * src/main/workers/ai-worker.ts. Формат текста совпадает с прежним
 * Agent.computeContinuity, чтобы хинт briefing не изменился.
 */
import { execFile } from 'child_process'
import { readFileSync, statSync } from 'fs'
import { join, resolve } from 'path'

/** Тёплый TTL: в его пределах снапшот отдаётся без git. */
const DEFAULT_TTL_MS = 120_000
/** Жёсткий TTL: даже при неизменной подписи пересчитываем раз в 10 минут. */
const HARD_TTL_MS = 10 * 60_000
const GIT_TIMEOUT_MS = 3_000
/** Сколько изменённых файлов отслеживаем по mtime (хватает для эвристики). */
const MAX_DIRTY_TRACKED = 8
/** Ограничение на число проектов в кеше. */
const MAX_ENTRIES = 50
/** Маркер «в workdir нет git-репозитория» — чтобы не спавнить git каждый раз. */
const NO_REPO = '__no_git__'

interface DirtyFile { path: string; mtimeMs: number; size: number }
/** Каталог, чья mtime меняется при появлении/удалении/переименовании записи. */
interface DirWitness { path: string; mtimeMs: number }

interface Entry {
  text: string
  computedAt: number
  signature: string
  dirty: DirtyFile[]
  dirs: DirWitness[]
}

const entries = new Map<string, Entry>()
const inflight = new Map<string, Promise<string>>()

/**
 * Пути, изменения в которых не влияют на briefing-continuity: документация,
 * картинки, lock-файлы и артефакты сборки. Такие правки не повод запускать git.
 */
const IRRELEVANT_RE = /(^|\/)(?:node_modules|dist|build|out|release|coverage|\.git)\/|(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|\.(?:md|markdown|txt|png|jpe?g|gif|svg|webp|ico|lock|map)$/i

export function isBriefingRelevantChange(file: string): boolean {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized) return false
  return !IRRELEVANT_RE.test(normalized)
}

function statSig(p: string): string {
  try {
    const s = statSync(p)
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return '-'
  }
}

/** `.git` может быть файлом (worktree/submodule): внутри `gitdir: <path>`. */
function resolveGitDir(workdir: string): string | null {
  const dotGit = join(workdir, '.git')
  try {
    if (statSync(dotGit).isDirectory()) return dotGit
    const content = readFileSync(dotGit, 'utf8')
    const m = /^gitdir:\s*(.+)$/m.exec(content)
    if (m) return resolve(workdir, m[1].trim())
  } catch { /* не git-репозиторий */ }
  return null
}

/** Дешёвая подпись состояния репозитория — только stat/readFile, без процессов. */
function gitSignature(workdir: string): string | null {
  const gitDir = resolveGitDir(workdir)
  if (!gitDir) return null
  const headPath = join(gitDir, 'HEAD')
  let headContent = ''
  try {
    headContent = readFileSync(headPath, 'utf8').trim()
  } catch {
    return null
  }
  const parts = [`head:${statSig(headPath)}`]
  const ref = /^ref:\s*(.+)$/m.exec(headContent)?.[1]?.trim()
  if (ref) parts.push(`ref:${statSig(join(gitDir, ref))}`)
  parts.push(`packed:${statSig(join(gitDir, 'packed-refs'))}`)
  parts.push(`index:${statSig(join(gitDir, 'index'))}`)
  return parts.join('|')
}

function dirtyUnchanged(dirty: DirtyFile[]): boolean {
  for (const d of dirty) {
    try {
      const s = statSync(d.path)
      if (s.mtimeMs !== d.mtimeMs || s.size !== d.size) return false
    } catch {
      // Файл исчез (или снова появился) — состояние git status изменилось.
      return false
    }
  }
  return true
}

function runGit(workdir: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise) => {
    execFile('git', args, { cwd: workdir, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout) => {
      resolvePromise(err ? '' : String(stdout))
    })
  })
}

/** Тот же формат, что раньше собирал Agent.computeContinuity. */
function formatContinuity(logOut: string, statusOut: string): string {
  const parts: string[] = []
  if (logOut) parts.push(`Последние коммиты: ${logOut.split('\n').join('; ').slice(0, 220)}`)
  if (statusOut) {
    const lines = statusOut.split('\n')
    const files = lines.slice(0, 8).map(l => l.slice(3).trim()).join(', ')
    parts.push(`Не закоммичено (${lines.length}): ${files.slice(0, 180)}`)
  }
  return parts.join('\n')
}

function captureDirty(workdir: string, statusOut: string): DirtyFile[] {
  const dirty: DirtyFile[] = []
  for (const line of statusOut.split('\n').slice(0, MAX_DIRTY_TRACKED)) {
    const rel = line.slice(3).trim()
    if (!rel) continue
    const abs = resolve(workdir, rel)
    try {
      const s = statSync(abs)
      dirty.push({ path: abs, mtimeMs: s.mtimeMs, size: s.size })
    } catch { /* удалённый файл не отслеживаем — dirtyUnchanged вернёт false при появлении */ }
  }
  return dirty
}

/**
 * Свидетели новых файлов: git status не увидит НОВЫЙ файл, если не смотреть
 * на mtime каталогов из прошлого status (файл появился/удалён — mtime
 * каталога меняется). Так «дешёвое» решение «ничего не менялось» остаётся
 * корректным и не требует запуска git.
 */
function captureDirs(workdir: string, statusOut: string): DirWitness[] {
  const dirs = new Map<string, DirWitness>()
  const add = (dir: string) => {
    if (dirs.has(dir)) return
    try {
      dirs.set(dir, { path: dir, mtimeMs: statSync(dir).mtimeMs })
    } catch { /* каталог исчез — не свидетель */ }
  }
  add(resolve(workdir))
  for (const line of statusOut.split('\n').slice(0, MAX_DIRTY_TRACKED)) {
    const rel = line.slice(3).trim()
    if (!rel) continue
    add(resolve(workdir, rel, '..'))
  }
  return [...dirs.values()].slice(0, MAX_DIRTY_TRACKED + 1)
}

function dirsUnchanged(dirs: DirWitness[]): boolean {
  for (const d of dirs) {
    try {
      if (statSync(d.path).mtimeMs !== d.mtimeMs) return false
    } catch {
      return false
    }
  }
  return true
}

function pruneEntries(): void {
  if (entries.size <= MAX_ENTRIES) return
  const ordered = [...entries.entries()].sort((a, b) => a[1].computedAt - b[1].computedAt)
  for (const [key] of ordered.slice(0, entries.size - MAX_ENTRIES)) entries.delete(key)
}

/** Уже посчитанный снапшот (без git и без ожидания). '' если кеша нет. */
export function peekBriefingContinuity(workdir?: string): string {
  if (!workdir) return ''
  return entries.get(resolve(workdir))?.text ?? ''
}

export interface BriefingContinuityOptions {
  /** Тёплый TTL; в его пределах git не запускается (по умолчанию 2 минуты). */
  ttlMs?: number
  /** Известные вызывающему изменённые файлы (относительно workdir). */
  changedFiles?: string[]
}

/**
 * Снапшот briefing-continuity для workdir. Git запускается только когда
 * подпись репозитория или mtime изменённых файлов разошлись с кешем.
 */
export async function getBriefingContinuity(
  workdir: string | undefined,
  opts: BriefingContinuityOptions = {},
): Promise<string> {
  if (!workdir) return ''
  const key = resolve(workdir)
  const ttl = Math.max(1_000, opts.ttlMs ?? DEFAULT_TTL_MS)
  const cached = entries.get(key)
  const signature = gitSignature(key)
  if (cached) {
    const age = Date.now() - cached.computedAt
    if (cached.signature === NO_REPO) {
      // Не git-репозиторий: пока `.git` не появился — git не запускаем вовсе.
      if (signature === null) {
        if (age >= ttl) entries.set(key, { ...cached, computedAt: Date.now() })
        return cached.text
      }
    } else if (signature === cached.signature && age < HARD_TTL_MS) {
      const explicitRelevant = (opts.changedFiles ?? []).filter(isBriefingRelevantChange)
      const known = new Set(cached.dirty.map(d => d.path))
      const newRelevant = explicitRelevant.some(f => !known.has(resolve(key, f)))
      // Сначала консультируемся с изменёнными файлами: если ни подпись
      // репозитория, ни сами файлы/каталоги не менялись — git не нужен.
      if (!newRelevant && dirtyUnchanged(cached.dirty) && dirsUnchanged(cached.dirs)) {
        // Не продлеваем TTL успешного git status: правки ранее чистых
        // отслеживаемых файлов могут не менять ни index, ни mtime каталога.
        return cached.text
      }
    }
  }
  if (signature === null) {
    // Нет git-репозитория — запоминаем это, чтобы не спавнить git каждый раз.
    entries.set(key, { text: '', computedAt: Date.now(), signature: NO_REPO, dirty: [], dirs: [] })
    pruneEntries()
    return ''
  }
  const running = inflight.get(key)
  if (running) return running
  const task = (async (): Promise<string> => {
    const [logOut, statusOut] = await Promise.all([
      runGit(key, ['log', '-3', '--pretty=format:%h %s']),
      runGit(key, ['status', '--porcelain']),
    ])
    const status = statusOut.trim()
    const text = formatContinuity(logOut.trim(), status)
    entries.set(key, {
      text,
      computedAt: Date.now(),
      signature: gitSignature(key) ?? NO_REPO,
      dirty: captureDirty(key, status),
      dirs: captureDirs(key, status),
    })
    pruneEntries()
    return text
  })().catch(() => '')
  inflight.set(key, task)
  void task.finally(() => { inflight.delete(key) })
  return task
}

/**
 * Версия для пути отправки сообщения: не тормозим старт чата.
 *  - кеш уже есть → отдаём его сразу, обновление догревается в фоне;
 *  - кеша нет → ждём git не дольше budgetMs (обычно десятки мс), иначе ''
 *    и снапшот появится к следующему запросу.
 */
export async function getBriefingContinuityWithin(
  workdir: string | undefined,
  budgetMs = 400,
  opts: BriefingContinuityOptions = {},
): Promise<string> {
  if (!workdir) return ''
  const peeked = peekBriefingContinuity(workdir)
  const task = getBriefingContinuity(workdir, opts)
  if (peeked) {
    void task
    return peeked
  }
  const budget = new Promise<string>((resolvePromise) => {
    const t = setTimeout(() => resolvePromise(''), Math.max(50, budgetMs))
    if (typeof (t as unknown as { unref?: () => void }).unref === 'function') (t as unknown as { unref: () => void }).unref()
  })
  return Promise.race([task, budget])
}

/**
 * main знает об изменениях файлов раньше, чем git (правки тулов) — помечаем
 * кеш устаревшим, чтобы следующий Briefing пересчитал status. Нерелевантные
 * пути (docs/lock/артефакты) кеш не сбрасывают.
 */
export function noteBriefingChanges(workdir: string | undefined, files: string[]): void {
  if (!workdir || files.length === 0) return
  const key = resolve(workdir)
  const entry = entries.get(key)
  if (!entry) return
  if (files.some(isBriefingRelevantChange)) entries.set(key, { ...entry, computedAt: 0 })
}

/** Полный сброс снапшота проекта (смена ветки/worktree, ручной refresh). */
export function invalidateBriefingContinuity(workdir?: string): void {
  if (!workdir) {
    entries.clear()
    inflight.clear()
    return
  }
  const key = resolve(workdir)
  entries.delete(key)
  inflight.delete(key)
}
