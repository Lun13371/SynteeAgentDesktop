/**
 * FileIndexer — индексатор файлов проекта для @mention-пикера.
 *
 * Watcher: fs.watch(recursive: true) на корень workdir — на Windows это
 * ReadDirectoryChangesW (kernel-level callback, 0% CPU в простое, один handle
 * на всё дерево). chokidar здесь заменён сознательно: он держит тысячи
 * FS-handles + stat-calls и грузит main-процесс даже в простое. Рекурсивные
 * события приходят с полным путём — игнор-фильтрация та же, что и в scanDir.
 *
 * API:
 *  - startIndexing(workdir, opts?) — ставит watcher, затем первичный scan;
 *    конкурентные вызовы получают промис того же скана
 *  - stopIndexing(workdir) — останавливает (скан прерывается)
 *  - searchFiles(workdir, query) — возвращает FileEntry[] отсортированный
 *    через filterMentions (fuzzy)
 *  - getRecentFiles(workdir, limit) — последние изменённые файлы (для @ без query)
 *
 * Инвентарь (для карты проекта и других потребителей полного списка):
 *  - whenInventoryReady(workdir, timeoutMs?) → Promise<FileInventoryStatus|null>
 *  - onInventoryComplete(workdir, cb, { timeoutMs }) → отписка
 *  - getInventoryStatus / isInventoryAuthoritative / isIndexReady
 *  - waitForIndexReady(workdir, timeoutMs?) → boolean (старое, без polling внутри)
 * Статус различает «скан закончился» (ready) и «список полон и актуален»
 * (authoritative = complete + живой watcher), чтобы потребитель мог отложить
 * сверку без polling и честно сообщить о частичности.
 *
 * Лимиты: maxFiles=20000 на проект (защита от гигантских mono-repo),
 * maxDepth=10 — глубже обычного обхода для полноты. Срабатывание лимита или
 * ошибка чтения каталога → complete=false (инвентарь не выдаётся за полный).
 */
import { watch, type FSWatcher } from 'fs'
import { basename, relative, sep } from 'path'
import { readdir, stat } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { execFile } from 'child_process'
import type { MentionItem } from '../../shared/types'
import { filterMentions, mimeFromExt, mentionTypeFromFilename } from '../../shared/mentions'

export interface FileEntry {
  path: string
  relPath: string
  name: string
  mime: string
  size: number
  mtime: number
  type: 'file' | 'image'
}

interface IndexEntry {
  workdir: string
  /** null — watcher поставить не удалось (или он окончательно упал). */
  watcher: FSWatcher | null
  files: FileEntry[]
  ready: boolean
  /** Список файлов, которые видит git (уже с применённым .gitignore). null — не git-проект. */
  gitFiles: Set<string> | null
  gitignore: GitignorePatterns
  /** Скан завершён без усечения лимитами и без ошибок чтения каталогов. */
  complete: boolean
  /** Сработал maxFiles/maxDepth — в files не весь проект. */
  truncated: boolean
  /** Каталоги/файлы, которые не удалось прочитать (права/исчезли/заняты во время обхода). */
  scanErrors: number
  /** Recursive watcher установлен и не падал → инкрементальные обновления идут. */
  watcherActive: boolean
  /**
   * События могли потеряться (filename=null, зазор между пере-подписками
   * watcher'а, stat упал не-ENOENT) — снимок мог разойтись с диском.
   * Гасится только сверкой (`rescan`), до неё инвентарь не авторитетен.
   */
  stale: boolean
  /** Лимиты первичного скана: нужны для повторной сверки. */
  maxFiles: number
  maxDepth: number
  /** stopIndexing во время скана: результат выбрасывается, ждущие получают null. */
  cancelled: boolean
  startedAt: number
  updatedAt: number
  durationMs: number
}

const _indexes = new Map<string, IndexEntry>()

/**
 * Сигналы on-demand сверки инвентаря (по одному на живой индекс).
 * Сверка нужна там, где watcher-события могли потеряться.
 */
const _rescanSignals = new Map<string, (reason: string) => void>()

/**
 * Идущие первичные сканы. Повторный (в т.ч. конкурентный) startIndexing
 * получает ТОТ ЖЕ промис: раньше второй вызов возвращался мгновенно, и
 * потребитель полного списка видел частичный кэш.
 */
const _starting = new Map<string, Promise<void>>()
/** Токены отмены для startIndexing, ещё не дошедшего до конца скана. */
const _cancelTokens = new Map<string, { cancelled: boolean }>()
/** Ждущие завершения первичного скана (promise/callback API без polling). */
type InventoryWaiter = (status: FileInventoryStatus | null) => void
const _waiters = new Map<string, Set<InventoryWaiter>>()

// ─── Подписка на изменения файлов (для project map и др. потребителей) ───────
type FileChangeCallback = (relPaths: string[]) => void
const _changeListeners = new Map<string, Set<FileChangeCallback>>()

/** Подписаться на изменения файлов workdir. Возвращает функцию отписки. */
export function subscribeFileChanges(workdir: string, cb: FileChangeCallback): () => void {
  let set = _changeListeners.get(workdir)
  if (!set) {
    set = new Set()
    _changeListeners.set(workdir, set)
  }
  set.add(cb)
  return () => {
    set!.delete(cb)
    if (set!.size === 0) _changeListeners.delete(workdir)
  }
}

function emitFileChanges(workdir: string, relPaths: string[]): void {
  const set = _changeListeners.get(workdir)
  if (!set || relPaths.length === 0) return
  for (const cb of set) {
    try { cb(relPaths) } catch (e) { console.warn('[fileIndexer] change listener error:', e) }
  }
}

// Игнорируемые директории (синхронно с fs.ipc.DEFAULT_IGNORE_DIRS).
// Дополнительно — типичные мусорные папки.
const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'out', '.git', '__pycache__', '.venv', 'build',
  '.next', 'coverage', '.cache', '.turbo', '.parcel-cache', 'target',
  '.gradle', '.idea', '.vscode', '.hermes', '.mimocode', '.playwright-mcp',
  '.planning', 'logs', 'tmp', 'tmp_out', '.opencode', '.syntee',
  '.angular', '.svelte-kit', '.nuxt', '.expo', 'Pods', 'vendor',
  'venv', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.vite',
  'obj', 'release', 'storybook-static', '.docusaurus',
  'cmake-build-debug', 'cmake-build-release',
  // Unity / Visual Studio / общий мусор (сравнение case-insensitive).
  'library', 'temp', 'builds', 'bin', 'obj', 'logs',
])

const IGNORED_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', // картинки — НЕТ, они нужны! убираем ниже
])

// Картинки НЕ игнорируем — они нужны для @прикрепления. Убираем из IGNORED_EXTS.
IGNORED_EXTS.clear()

const BINARY_EXTS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.wasm', '.lib', '.obj', '.bin', '.dat',
  '.db', '.sqlite', '.db-shm', '.db-wal', '.o', '.a', '.class', '.jar', '.war',
  '.ttf', '.otf', '.woff', '.woff2', '.eot', '.lock', '.log', '.zip', '.gz',
  '.tar', '.rar', '.7z', '.bz2', '.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
])

const MAX_FILES = 20000
const MAX_DEPTH = 10
const SCAN_DEBOUNCE_MS = 200
/** Debounce сверки после потерянных событий: реже инкремента, но без лага. */
const RESCAN_DEBOUNCE_MS = 500
/**
 * Повтор сверки, если переобход упёрся в нечитаемые файлы (EPERM/EBUSY).
 * Без этого один занятый файл навсегда оставлял бы `complete=false`
 * (fail-closed) и карта проекта никогда больше не чистила бы граф.
 */
const RESCAN_RETRY_MS = 5_000
const RESCAN_RETRY_MAX = 3

// ── .gitignore парсинг (упрощённый) ──────────────────────────────────────────

interface GitignorePatterns {
  dirs: Set<string>
  /** Паттерны директорий с путём: `Assets/polyperfect/` → 'Assets/polyperfect'. */
  dirPaths: Set<string>
  files: Set<string>
  /** Паттерны файлов с путём: `docs/generated.md` → матчим по суффиксу пути. */
  filePaths: Set<string>
  exts: Set<string>
  /**
   * Glob-паттерны (`**`, `*`, `?`) и отрицания (`!`). Проверяются по relPath
   * в порядке объявления: последнее совпадение побеждает (семантика git).
   */
  globs: Array<{ re: RegExp; negate: boolean }>
}

/**
 * .gitignore-паттерн → RegExp по posix-relPath.
 * `src/**\/*.d.ts` → `^src/(?:.*\/)?[^/]*\.d\.ts$`, `**\/x` → `(?:^|.*\/)x`.
 * Паттерн без слэша матчится на любом уровне (`*.tmp`), со слэшем — от корня.
 */
export function gitignoreGlobToRegex(pat: string): RegExp {
  const anchored = pat.includes('/')
  let re = ''
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i]
    if (ch === '*') {
      if (pat[i + 1] === '*') {
        if (pat[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
      } else {
        re += '[^/]*'
      }
    } else if (ch === '?') {
      re += '[^/]'
    } else if ('\\^$+.()|{}[]'.includes(ch)) {
      re += '\\' + ch
    } else {
      re += ch
    }
  }
  return new RegExp((anchored ? '^' : '(?:^|.*/)') + re + '$')
}


/**
 * Развернуть символьные классы `[abc]` в варианты строки. Unity-шные
 * `.gitignore` пишут `[Ll]ibrary/`, `[Tt]emp/` — буквальное сравнение имён
 * с ними не работало, и кэш движка (десятки тысяч файлов) попадал в индекс.
 */
export function expandCharClasses(pat: string): string[] {
  if (!pat.includes('[') || !pat.includes(']')) return [pat]
  let variants: string[] = ['']
  let inClass = false
  let cls = ''
  for (const ch of pat) {
    if (!inClass) {
      if (ch === '[') { inClass = true; cls = '' }
      else variants = variants.map(v => v + ch)
    } else if (ch === ']') {
      inClass = false
      const opts = cls.length > 0 ? cls.split('') : []
      // Слишком широкие/битые классы не разворачиваем — паттерн как literal.
      if (opts.length === 0 || variants.length * opts.length > 64) return [pat]
      variants = variants.flatMap(v => opts.map(o => v + o))
    } else {
      cls += ch
    }
  }
  return inClass ? [pat] : variants
}

/** Экспортирован для тестов: работа с реальным .gitignore проекта. */
export function parseGitignore(workdir: string): GitignorePatterns {
  const result: GitignorePatterns = { dirs: new Set(), dirPaths: new Set(), files: new Set(), filePaths: new Set(), exts: new Set(), globs: [] }
  const giPath = workdir + sep + '.gitignore'
  if (!existsSync(giPath)) return result
  try {
    const content = readFileSync(giPath, 'utf-8')
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const negate = line.startsWith('!')
      // Убираем ведущий / (anchor to root) для упрощения
      const pat = (negate ? line.slice(1) : line).replace(/^\//, '')
      if (!pat) continue
      for (const variant of expandCharClasses(pat)) {
        // Простое расширение (*.log, *.pdb) — быстрый путь без regex.
        if (/^\*\.[^*?/]+$/.test(variant)) {
          result.exts.add(variant.slice(1))
          continue
        }
        // Glob-паттерны и отрицания — в отдельный список с regex (порядок важен).
        if (negate || /[*?]/.test(variant)) {
          if (!variant.endsWith('/')) result.globs.push({ re: gitignoreGlobToRegex(variant), negate })
          continue
        }
        // Директория (заканчивается на /)
        if (variant.endsWith('/')) {
          const name = variant.slice(0, -1)
          if (name.includes('/')) result.dirPaths.add(name)
          else result.dirs.add(name)
          continue
        }
        // Паттерн с путём — файл в конкретной папке (docs/generated.md)
        if (variant.includes('/')) {
          result.filePaths.add(variant)
          continue
        }
        // Точный файл/паттерн без слеша — добавляем как файл
        result.files.add(variant)
      }
    }
  } catch { /* ok */ }
  return result
}

/**
 * Файлы, которые видит git: отслеживаемые + неотслеживаемые, но не игнорируемые.
 * Это эталонный список для «что вообще является частью проекта» — .gitignore
 * учитывается самим git (`**`, `!`, вложенные .gitignore).
 * Возвращает null, если workdir не под git (или git недоступен) — тогда
 * работают эвристики parseGitignore/IGNORED_DIRS.
 *
 * Асинхронно: `git ls-files` на большом репозитории идёт сотни миллисекунд,
 * sync-вызов подвесил бы main-процесс на старте каждого проекта.
 */
export async function listGitFiles(workdir: string): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        ['-C', workdir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        { encoding: 'utf-8', maxBuffer: 128 * 1024 * 1024, windowsHide: true, timeout: 20_000 },
        (err, stdout) => {
          if (err || !stdout) { resolve(null); return }
          const set = new Set<string>()
          for (const p of stdout.split('\0')) {
            if (p) set.add(p.split('\\').join('/'))
          }
          resolve(set.size > 0 ? set : null)
        },
      )
    } catch {
      resolve(null)
    }
  })
}

/** Экспортирован для тестов. */
export function isIgnored(
  relPath: string,
  name: string,
  gitignore: GitignorePatterns,
  gitFiles?: Set<string> | null,
): boolean {
  // Git — источник истины: файла нет в git-списке (уже с применённым .gitignore)
  // → он не часть проекта. Снимает весь класс проблем: сгенерированные *.d.ts,
  // node_modules, локальные артефакты сборки.
  if (gitFiles && !gitFiles.has(relPath)) return true

  const segments = relPath.split('/')
  for (const seg of segments) {
    // ФС Windows case-insensitive — 'TEMP' и 'temp' одно и то же; сравним так же.
    if (IGNORED_DIRS.has(seg.toLowerCase())) return true
    if (gitignore.dirs.has(seg)) return true
  }
  for (const dirPath of gitignore.dirPaths) {
    if (relPath === dirPath || relPath.startsWith(dirPath + '/')) return true
  }
  if (gitignore.files.has(name)) return true
  for (const filePath of gitignore.filePaths) {
    if (relPath === filePath || relPath.endsWith('/' + filePath)) return true
  }
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot >= 0) {
    const ext = lower.slice(dot)
    if (gitignore.exts.has(ext)) return true
    if (BINARY_EXTS.has(ext)) return true
  }
  // Glob-правила: последнее совпадение побеждает (как в git).
  if (gitignore.globs.length > 0) {
    let verdict = false
    for (const g of gitignore.globs) {
      if (g.re.test(relPath)) verdict = !g.negate
    }
    if (verdict) return true
  }
  // Скрытые файлы (.env, .gitignore — оставляем; остальные .dotfiles — скрываем)
  if (name.startsWith('.') && name !== '.env' && name !== '.gitignore' && name !== '.editorconfig') {
    return true
  }
  return false
}

/**
 * Игнорируется ли путь в рамках уже запущенного индекса workdir.
 * Нужен потребителям watcher-событий (карта проекта): fileIndexer не эмитит
 * игнорируемые пути, но защита на стороне потребителя тоже полезна.
 * Если индекс не запущен — считает по .gitignore без git-списка.
 */
export function isPathIgnored(workdir: string, relPath: string): boolean {
  const entry = _indexes.get(workdir)
  const name = relPath.split('/').pop() ?? relPath
  if (entry) return isIgnored(relPath, name, entry.gitignore, entry.gitFiles)
  return isIgnored(relPath, name, parseGitignore(workdir), null)
}

// ── Первичный scan ───────────────────────────────────────────────────────────

/** Все директории, в которых есть файлы из git-списка (префиксы путей). */
function buildDirSet(files: Set<string>): Set<string> {
  const dirs = new Set<string>()
  for (const f of files) {
    let idx = f.lastIndexOf('/')
    while (idx > 0) {
      const dir = f.slice(0, idx)
      if (dirs.has(dir)) break
      dirs.add(dir)
      idx = dir.lastIndexOf('/')
    }
  }
  return dirs
}

interface ScanStats {
  files: number
  /** Упёрлись в maxFiles/maxDepth — инвентарь неполный. */
  truncated: boolean
  /** Сколько каталогов не удалось прочитать. */
  scanErrors: number
  /** Скан прерван (stopIndexing). */
  cancelled: boolean
}

async function scanDir(
  workdir: string,
  gitignore: GitignorePatterns,
  gitFiles: Set<string> | null,
  gitDirs: Set<string> | null,
  onFile: (entry: FileEntry) => void,
  limits: { maxFiles: number; maxDepth: number; isCancelled?: () => boolean },
): Promise<ScanStats> {
  const stats: ScanStats = { files: 0, truncated: false, scanErrors: 0, cancelled: false }
  const stack: Array<{ dir: string; depth: number }> = [{ dir: workdir, depth: 0 }]
  while (stack.length > 0) {
    if (limits.isCancelled?.()) { stats.cancelled = true; break }
    if (stats.files >= limits.maxFiles) { stats.truncated = true; break }
    const { dir, depth } = stack.pop()!
    // Глубже лимита не идём, но факт усечения запоминаем: молча «готовый»
    // инвентарь на глубоком дереве — это тихая потеря файлов для карты.
    if (depth > limits.maxDepth) { stats.truncated = true; continue }
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      stats.scanErrors++
      continue
    }
    for (const d of dirents) {
      if (limits.isCancelled?.()) { stats.cancelled = true; break }
      if (stats.files >= limits.maxFiles) { stats.truncated = true; break }
      const fullPath = dir + sep + d.name
      const relPath = relative(workdir, fullPath).split(sep).join('/')
      if (d.isDirectory()) {
        if (IGNORED_DIRS.has(d.name.toLowerCase()) || gitignore.dirs.has(d.name)) continue
        if (d.name.startsWith('.') && d.name !== '.env') continue
        // Git-список знает точно: если в поддереве нет ни одного файла из git —
        // не спускаемся (node_modules, .cache и прочие локальные артефакты).
        if (gitDirs && !gitDirs.has(relPath)) continue
        stack.push({ dir: fullPath, depth: depth + 1 })
        continue
      }
      if (d.isFile()) {
        if (isIgnored(relPath, d.name, gitignore, gitFiles)) continue
        let st
        try {
          st = await stat(fullPath)
        } catch (e) {
          // ENOENT/ENOTDIR — файл исчез между readdir и stat, это норма.
          // Остальные коды (EPERM/EBUSY/EACCES) — «не смог прочитать»: файл
          // существует, но в снимок не попадёт. Молча терять его нельзя,
          // иначе complete=true выдаёт неполный инвентарь за полный.
          const code = (e as NodeJS.ErrnoException | undefined)?.code
          if (code !== 'ENOENT' && code !== 'ENOTDIR') stats.scanErrors++
          continue
        }
        const mime = mimeFromExt(d.name)
        onFile({
          path: fullPath,
          relPath,
          name: d.name,
          mime,
          size: st.size,
          mtime: st.mtimeMs,
          type: mentionTypeFromFilename(d.name) as 'file' | 'image',
        })
        stats.files++
      }
    }
  }
  return stats
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Опции первичного скана. Необязательны: значения по умолчанию — MAX_FILES/MAX_DEPTH. */
export interface FileInventoryOptions {
  maxFiles?: number
  maxDepth?: number
}

/**
 * Состояние файлового инвентаря workdir.
 *
 * - `ready` — первичный скан завершён, `getAllFiles` отдаёт его результат.
 * - `complete` — скан дошёл до конца без усечения лимитами и без ошибок
 *   чтения каталогов: список файлов полон НА МОМЕНТ окончания скана.
 *   Пока снимок `stale` (события терялись, идёт сверка) — `false`: сырые поля
 *   статуса fail-closed, чтобы потребитель не считал непроверенный список
 *   полным.
 * - `authoritative` — `complete` + watcher жив, значит список актуален и
 *   сейчас (изменения применяются инкрементально). Потребитель полного
 *   инвентаря (карта проекта) должен строить граф только при `true`,
 *   иначе честно помечать карту частичной.
 */
export interface FileInventoryStatus {
  workdir: string
  ready: boolean
  complete: boolean
  authoritative: boolean
  /** Упёрлись в maxFiles/maxDepth — в `files` не весь проект. */
  truncated: boolean
  /** Каталоги/файлы, которые не удалось прочитать (права/занятость, не ENOENT). */
  scanErrors: number
  /** Размер инвентаря. */
  files: number
  /** Watcher следит за изменениями (не падал и не отключён). */
  watcherActive: boolean
  /**
   * События терялись (null filename / пере-подписка watcher'а / stat-ошибка):
   * содержимое могло разойтись с диском, идёт сверка. Пока `true`,
   * `complete` и `authoritative` тоже `false`.
   */
  stale: boolean
  startedAt: number
  updatedAt: number
  durationMs: number
}

function toInventoryStatus(entry: IndexEntry): FileInventoryStatus {
  // Fail-closed: пока снимок stale (события терялись, сверка не закончена),
  // `complete` тоже false. Потребитель (карта проекта) выводит авторитетность
  // из сырых полей ready/complete/watcherActive, а не из `authoritative`,
  // и по ней решает, можно ли удалять узлы из графа. Непроверенный снимок
  // не должен давать такое право.
  const verified = !entry.stale
  return {
    workdir: entry.workdir,
    ready: entry.ready,
    complete: entry.ready && entry.complete && verified,
    authoritative: entry.ready && entry.complete && entry.watcherActive && verified,
    truncated: entry.truncated,
    scanErrors: entry.scanErrors,
    files: entry.files.length,
    watcherActive: entry.watcherActive,
    stale: entry.stale,
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt,
    durationMs: entry.durationMs,
  }
}

/** Разбудить ждущих завершения скана workdir (один раз на скан). */
function notifyInventory(workdir: string, status: FileInventoryStatus | null): void {
  const set = _waiters.get(workdir)
  if (!set) return
  _waiters.delete(workdir)
  for (const waiter of set) {
    try { waiter(status) } catch { /* ignore */ }
  }
}

/**
 * Запускает индексацию workdir. Idempotent: повторный вызов — в том числе
 * конкурентный, пока идёт первичный скан — не создаёт второй watcher и
 * возвращает промис того же скана. Возвращаемый Promise<void> резолвится,
 * когда первичный scan завершён и инвентарь согласован с изменениями,
 * пришедшими за время скана.
 */
export async function startIndexing(workdir: string, options: FileInventoryOptions = {}): Promise<void> {
  const existing = _indexes.get(workdir)
  if (existing?.ready) return
  const inFlight = _starting.get(workdir)
  if (inFlight) return inFlight
  const token = { cancelled: false }
  _cancelTokens.set(workdir, token)
  const run = runIndexing(workdir, options, token).finally(() => {
    _starting.delete(workdir)
    _cancelTokens.delete(workdir)
  })
  _starting.set(workdir, run)
  return run
}

async function runIndexing(
  workdir: string,
  options: FileInventoryOptions,
  token: { cancelled: boolean },
): Promise<void> {
  const maxFiles = Math.max(1, options.maxFiles ?? MAX_FILES)
  const maxDepth = Math.max(0, options.maxDepth ?? MAX_DEPTH)
  const startedAt = Date.now()

  // Недостроенный прошлый индекс (упавший старт) — снимаем, чтобы не утёк watcher.
  const previous = _indexes.get(workdir)
  if (previous && !previous.ready) {
    try { await previous.watcher?.close() } catch { /* ignore */ }
    _indexes.delete(workdir)
  }
  // Старый сигнал сверки указывает на замыкание прошлого индекса — снимаем.
  _rescanSignals.delete(workdir)

  const entry: IndexEntry = {
    workdir,
    watcher: null,
    files: [],
    ready: false,
    gitFiles: null,
    gitignore: parseGitignore(workdir),
    complete: false,
    truncated: false,
    scanErrors: 0,
    watcherActive: false,
    stale: false,
    maxFiles,
    maxDepth,
    cancelled: false,
    startedAt,
    updatedAt: startedAt,
    durationMs: 0,
  }
  _indexes.set(workdir, entry)

  // ── Incremental update: только изменившиеся файлы, НЕ полный rescan. ──
  // Копим изменившиеся пути в Set и debounce'ом обрабатываем только их
  // (stat каждого + upsert/remove в entry.files + re-sort).
  let debounceTimer: NodeJS.Timeout | null = null
  /** Debounce сверки (потерянные события) — отдельно от инкремента. */
  let rescanTimer: NodeJS.Timeout | null = null
  /** Счётчик подряд неудачных сверок (нечитаемые файлы) для bounded retry. */
  let rescanRetries = 0
  const pendingPaths = new Set<string>()
  // Пока идёт первичный скан, watcher-события НЕ обрабатываются сразу, а копятся:
  // всё, что изменилось за время скана (на большом репозитории — секунды),
  // применяется сразу после него. Иначе такие изменения терялись навсегда —
  // список объявлялся готовым, будучи уже устаревшим.
  let scanning = true
  // Все мутации entry.files (инкремент, сверка) сериализованы: два flush'а
  // внахлёст могли вернуть в список запись, которую соседний уже удалил,
  // и снимок переставал соответствовать диску.
  let mutation: Promise<void> = Promise.resolve()
  const serial = (fn: () => Promise<void>): Promise<void> => {
    const next = mutation.then(fn, fn)
    mutation = next.then(() => undefined, () => undefined)
    return next
  }

  /** Убрать запись из инвентаря. Возвращает relPath, если запись была. */
  const dropIndexed = (fullPath: string): string | null => {
    const idx = entry.files.findIndex(f => f.path === fullPath)
    if (idx < 0) return null
    const [removed] = entry.files.splice(idx, 1)
    return removed.relPath
  }

  const flushPending = async (): Promise<void> => {
    debounceTimer = null
    const paths = Array.from(pendingPaths)
    pendingPaths.clear()
    if (paths.length === 0) return
    const changedRel: string[] = []
    for (const fullPath of paths) {
      const relPath = relative(workdir, fullPath).split(sep).join('/')
      const name = basename(fullPath)
      // Игнорируемые пути НЕ эмитим: раньше событие уходило потребителям
      // (карта проекта) и файл из node_modules/сгенерированный *.d.ts
      // переразбирался и попадал в граф мимо полного скана.
      // Здесь проверяем эвристиками (.gitignore + IGNORED_DIRS), а не git-списком:
      // только что созданный файл в git-списке ещё отсутствует.
      // Исключение — файл, который git уже видит: он часть проекта по
      // определению (git применил .gitignore целиком), иначе изменение
      // отслеживаемого файла (docs/generated.md, *.lock) молча выкидывало бы
      // его из авторитетного снимка.
      const ignored = entry.gitFiles?.has(relPath) ? false : isIgnored(relPath, name, entry.gitignore)
      if (ignored) {
        dropIndexed(fullPath)
        continue
      }
      let st
      try {
        st = await stat(fullPath)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException | undefined)?.code
        // Удаление подтверждает только ENOENT/ENOTDIR. EPERM/EBUSY/EACCES
        // (Windows: файл занят, антивирус, права) — «не смог прочитать»,
        // файл может быть на месте. Удалять по такому stat'у индексированную
        // запись нельзя: watcher о ней больше не сообщит, и авторитетный
        // снимок навсегда потеряет файл. Просим сверку.
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          // файл удалён — событие всё равно нужно (потребитель уберёт его из графа)
          changedRel.push(relPath)
          dropIndexed(fullPath)
        } else {
          requestRescan(`stat ${code ?? 'failed'}: ${relPath}`)
        }
        continue
      }
      if (!st.isFile()) {
        // Событие по каталогу (Windows шлёт их и на перечисление содержимого).
        // В инвентаре файлов ему не место — иначе папка всплывает в @mention
        // и в графе карты как «файл». Но если запись была, потребителю нужно
        // событие: файл на этом пути исчез, узел из графа надо убрать.
        if (dropIndexed(fullPath)) changedRel.push(relPath)
        continue
      }
      changedRel.push(relPath)
      // Новый файл, которого не было в git-списке на момент скана — добавляем,
      // чтобы следующая полная сборка его не выбросила.
      if (entry.gitFiles && !entry.gitFiles.has(relPath)) entry.gitFiles.add(relPath)
      const fe: FileEntry = {
        path: fullPath,
        relPath,
        name,
        mime: mimeFromExt(name),
        size: st.size,
        mtime: st.mtimeMs,
        type: mentionTypeFromFilename(name) as 'file' | 'image',
      }
      const idx = entry.files.findIndex(f => f.path === fullPath)
      if (idx >= 0) entry.files[idx] = fe
      else entry.files.push(fe)
    }
    // re-sort — дёшево даже для 10к (ms), зато порядок mtime актуален.
    entry.files.sort((a, b) => b.mtime - a.mtime)
    entry.updatedAt = Date.now()
    emitFileChanges(workdir, changedRel)
  }
  const flush = (): Promise<void> => serial(flushPending)

  /**
   * Сверка инвентаря с диском — полный переобход без пере-подписки watcher'а.
   * Нужна там, где события могли потеряться: `filename === null` из fs.watch,
   * зазор между close и новым watch() при пере-подписке, stat, упавший
   * не-ENOENT. Пишет только в свой снимок и не сбрасывает записи, которые
   * инвентарь уже принял (`gitFiles` объединяется с текущим содержимым).
   */
  const rescanNow = async (): Promise<void> => {
    if (entry.cancelled) return
    if (rescanTimer) { clearTimeout(rescanTimer); rescanTimer = null }
    const before = new Map(entry.files.map(f => [f.path, f]))
    const gitFiles = entry.gitFiles
      ? new Set([...entry.gitFiles, ...entry.files.map(f => f.relPath)])
      : null
    const collected: FileEntry[] = []
    const stats = await scanDir(
      workdir,
      entry.gitignore,
      gitFiles,
      gitFiles ? buildDirSet(gitFiles) : null,
      (fe) => collected.push(fe),
      { maxFiles: entry.maxFiles, maxDepth: entry.maxDepth, isCancelled: () => entry.cancelled },
    )
    if (entry.cancelled) return
    if (gitFiles) entry.gitFiles = gitFiles
    collected.sort((a, b) => b.mtime - a.mtime)
    // Запись, не попавшая в переобход, могла не удалиться, а «не прочитаться»
    // (EPERM/EBUSY на Windows): файл на месте, stat по нему упал. Удалять
    // такую запись из авторитетного снимка нельзя — сохраняем прежнюю.
    const after = new Set(collected.map(f => f.path))
    for (const [p, prev] of before) {
      if (after.has(p)) continue
      // Удаление подтверждает только ENOENT/ENOTDIR; прочие коды и каталог
      // на месте файла — не повод терять запись молча.
      let gone = false
      try {
        gone = !(await stat(p)).isFile()
      } catch (e) {
        const code = (e as NodeJS.ErrnoException | undefined)?.code
        gone = code === 'ENOENT' || code === 'ENOTDIR'
      }
      if (gone) continue
      collected.push(prev)
      after.add(p)
    }
    collected.sort((a, b) => b.mtime - a.mtime)
    entry.files = collected
    entry.truncated = stats.truncated
    entry.scanErrors = stats.scanErrors
    entry.complete = !stats.truncated && stats.scanErrors === 0
    entry.stale = false
    entry.updatedAt = Date.now()
    entry.durationMs = entry.updatedAt - entry.startedAt
    // Сверка заменяет инкрементальные события, которых не было: потребителю
    // (карта проекта) нужны и изменённые/добавленные, и исчезнувшие файлы.
    const changedRel: string[] = []
    for (const f of collected) {
      const prev = before.get(f.path)
      if (!prev || prev.mtime !== f.mtime || prev.size !== f.size) changedRel.push(f.relPath)
    }
    for (const [p, f] of before) if (!after.has(p)) changedRel.push(f.relPath)
    emitFileChanges(workdir, changedRel)

    // Нечитаемые файлы (EPERM/EBUSY) — не повод навсегда оставить снимок
    // неполным: пробуем ещё несколько раз, пока файл не освободится.
    if (entry.scanErrors > 0 && rescanRetries < RESCAN_RETRY_MAX && !entry.cancelled) {
      rescanRetries++
      if (rescanTimer) clearTimeout(rescanTimer)
      rescanTimer = setTimeout(() => {
        rescanTimer = null
        void rescan().catch(e => console.warn(`[fileIndexer] rescan retry failed for ${workdir}:`, e))
      }, RESCAN_RETRY_MS)
      rescanTimer.unref?.()
    } else if (entry.scanErrors === 0) {
      rescanRetries = 0
    }
  }
  const rescan = (): Promise<void> => serial(rescanNow)

  /**
   * Запросить сверку (debounce). Сразу помечает снимок stale: пока сверка не
   * закончилась, `authoritative` = false — «полный и актуальный» инвентарь
   * с дырой не отдаётся. Во время первичного скана сверку выполнит финализация.
   */
  const requestRescan = (reason: string): void => {
    entry.stale = true
    if (entry.cancelled) return
    if (scanning) return
    if (rescanTimer) clearTimeout(rescanTimer)
    rescanTimer = setTimeout(() => {
      rescanTimer = null
      void rescan().catch(e => console.warn(`[fileIndexer] rescan failed for ${workdir} (${reason}):`, e))
    }, RESCAN_DEBOUNCE_MS)
    // Таймер не должен держать event loop (main-процесс Electron / тесты).
    rescanTimer.unref?.()
  }
  _rescanSignals.set(workdir, requestRescan)

  const scheduleRescan = (fullPath: string): void => {
    pendingPaths.add(fullPath)
    if (scanning) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      void flush().catch(e => console.warn(`[fileIndexer] flush failed for ${workdir}:`, e))
    }, SCAN_DEBOUNCE_MS)
  }

  // Watcher ставим ДО скана: события, пришедшие во время скана, копятся
  // в pendingPaths и применяются перед объявлением готовности.
  entry.watcher = installWatcher(workdir, scheduleRescan, entry, requestRescan)
  entry.watcherActive = entry.watcher !== null

  // Git — эталонный список файлов проекта (учитывает .gitignore целиком:
  // `**`, `!`, вложенные .gitignore). Без git работают эвристики.
  const gitFiles = await listGitFiles(workdir)
  if (token.cancelled || entry.cancelled) { notifyInventory(workdir, null); return }
  entry.gitFiles = gitFiles
  const gitDirs = gitFiles ? buildDirSet(gitFiles) : null

  // Первичный scan (быстрее chokidar для нашего кэша)
  const stats = await scanDir(
    workdir,
    entry.gitignore,
    gitFiles,
    gitDirs,
    (fe) => entry.files.push(fe),
    { maxFiles, maxDepth, isCancelled: () => token.cancelled || entry.cancelled },
  )
  if (token.cancelled || entry.cancelled || stats.cancelled) {
    notifyInventory(workdir, null)
    return
  }

  entry.files.sort((a, b) => b.mtime - a.mtime)
  // Догоняем изменения, пришедшие во время скана: инвентарь должен быть
  // согласован ДО того, как мы объявим его готовым.
  scanning = false
  if (pendingPaths.size > 0) {
    try { await flush() } catch (e) { console.warn(`[fileIndexer] flush failed for ${workdir}:`, e) }
  }
  if (token.cancelled || entry.cancelled) { notifyInventory(workdir, null); return }

  entry.truncated = stats.truncated
  entry.scanErrors = stats.scanErrors
  entry.complete = !stats.truncated && stats.scanErrors === 0
  // События, потерянные во время скана (filename=null, пере-подписка
  // watcher'а), закрываем сверкой ДО объявления готовности: иначе снимок
  // с дырой будет объявлен полным и авторитетным.
  if (entry.stale) {
    try { await rescan() } catch (e) { console.warn(`[fileIndexer] rescan failed for ${workdir}:`, e) }
  }
  if (token.cancelled || entry.cancelled) { notifyInventory(workdir, null); return }

  entry.ready = true
  entry.updatedAt = Date.now()
  entry.durationMs = entry.updatedAt - startedAt
  if (entry.truncated || entry.scanErrors > 0 || !entry.watcherActive) {
    // Молча «готовый» инвентарь на усечённом/битом дереве — это тихая потеря
    // файлов для карты проекта. Оставляем след в логе и в статусе.
    console.warn(
      `[fileIndexer] ${workdir}: inventory incomplete ` +
      `(files=${entry.files.length}, truncated=${entry.truncated}, ` +
      `scanErrors=${entry.scanErrors}, watcher=${entry.watcherActive})`,
    )
  }
  notifyInventory(workdir, toInventoryStatus(entry))
}

/**
 * Поставить recursive-watcher и держать его живым.
 *
 * fs.watch(recursive) на Windows — ReadDirectoryChangesW: один kernel-handle на
 * всё дерево, 0% CPU в простое (chokidar держал тысячи handles + stat-calls).
 * Watcher может умереть (переполнение внутреннего буфера, протухший handle) —
 * тогда изменения молча перестают приходить, а инвентарь выглядит готовым.
 * Поэтому одна попытка пере-подписки, а если не вышло — честно
 * `watcherActive=false`, и потребитель увидит `authoritative=false`.
 */
function installWatcher(
  workdir: string,
  onPath: (fullPath: string) => void,
  entry: IndexEntry,
  onLostEvents: (reason: string) => void,
): FSWatcher | null {
  const attach = (attempt: number): FSWatcher | null => {
    try {
      const watcher = watch(workdir, { recursive: true, persistent: true }, (_event, filename) => {
        // filename === null — путь неизвестен (переполнение внутреннего буфера
        // ReadDirectoryChangesW на Windows, редкие гонки). Игнорировать такое
        // событие нельзя: удаление файла так и осталось бы в «авторитетном»
        // снимке. Просим сверку — она восстановит соответствие диску.
        if (!filename) { onLostEvents('null filename'); return }
        // filename приходит с '\\' или '/' сепараторами — нормализуем.
        onPath(workdir + sep + filename.split('/').join(sep).split('\\').join(sep))
      })
      watcher.on('error', (e) => {
        console.warn(`[fileIndexer] watcher error for ${workdir}:`, e)
        try { watcher.close() } catch { /* ignore */ }
        entry.watcherActive = false
        if (attempt < 1) {
          const retried = attach(attempt + 1)
          entry.watcher = retried
          entry.watcherActive = retried !== null
          // Между close() и новым watch() события не доставляются: что
          // изменилось в этом зазоре — неизвестно, закрываем сверкой.
          if (retried) onLostEvents('watcher restarted')
        }
      })
      return watcher
    } catch (e) {
      console.warn(`[fileIndexer] watcher failed for ${workdir}:`, e)
      return null
    }
  }
  return attach(0)
}

/** Останавливает индексацию workdir. Если первичный скан ещё идёт — он
 *  прерывается, а ждущие завершения (whenInventoryReady/onInventoryComplete)
 *  получают null. */
export async function stopIndexing(workdir: string): Promise<void> {
  const token = _cancelTokens.get(workdir)
  if (token) token.cancelled = true
  const entry = _indexes.get(workdir)
  if (!entry) {
    // Индексация не запущена — ждущим ждать нечего.
    notifyInventory(workdir, null)
    return
  }
  entry.cancelled = true
  try {
    await entry.watcher?.close()
  } catch { /* ignore */ }
  _rescanSignals.delete(workdir)
  _indexes.delete(workdir)
  notifyInventory(workdir, null)
}

/** Останавливает все индексации (при выходе из приложения). */
export async function stopAllIndexing(): Promise<void> {
  const dirs = Array.from(_indexes.keys())
  await Promise.all(dirs.map(stopIndexing))
}

/** Готов ли индекс для workdir (первичный scan завершён). */
export function isIndexReady(workdir: string): boolean {
  return _indexes.get(workdir)?.ready ?? false
}

/**
 * Текущее состояние инвентаря или null, если индексация не запускалась.
 * `authoritative` — единственный надёжный признак «список полон и актуален»:
 * скан не усечён лимитами, каталоги читались, watcher жив.
 */
export function getInventoryStatus(workdir: string): FileInventoryStatus | null {
  const entry = _indexes.get(workdir)
  return entry ? toInventoryStatus(entry) : null
}

/** Полон ли инвентарь и актуален ли он сейчас (complete + живой watcher). */
export function isInventoryAuthoritative(workdir: string): boolean {
  const entry = _indexes.get(workdir)
  return entry ? entry.ready && entry.complete && entry.watcherActive && !entry.stale : false
}

/**
 * Попросить сверку инвентаря с диском (on-demand, с debounce внутри).
 *
 * Нужна там, где watcher-события могли потеряться и потребитель знает об этом
 * сам (ручной resync, длинная операция с ФС). Пока сверка не завершилась,
 * статус отдаёт `stale=true` и `authoritative=false` — «авторитетным» снимок
 * с дырой не объявляется. Если индекс не запущен — no-op.
 */
export function requestInventoryRescan(workdir: string): void {
  _rescanSignals.get(workdir)?.('on demand')
}

/**
 * Промис завершения первичного скана workdir — без polling.
 *
 * Резолвится сразу, если индекс уже готов, иначе — событием окончания скана.
 * `null` по таймауту или если индексацию остановили/не запускали. Промис
 * ограничен таймаутом (по умолчанию 30 с), чтобы потребитель (карта проекта)
 * мог отложить сверку и не ждать вечно.
 */
export function whenInventoryReady(workdir: string, timeoutMs = 30_000): Promise<FileInventoryStatus | null> {
  const entry = _indexes.get(workdir)
  if (entry?.ready) return Promise.resolve(toInventoryStatus(entry))
  return new Promise(resolve => {
    let settled = false
    let timer: NodeJS.Timeout | null = null
    const waiter: InventoryWaiter = (status) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(status)
    }
    const detach = (): void => {
      const set = _waiters.get(workdir)
      if (!set) return
      set.delete(waiter)
      if (set.size === 0) _waiters.delete(workdir)
    }
    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        if (settled) return
        settled = true
        detach()
        resolve(null)
      }, timeoutMs)
      // Таймаут не должен держать event loop (main-процесс Electron / тесты).
      timer.unref?.()
    }
    let set = _waiters.get(workdir)
    if (!set) {
      set = new Set()
      _waiters.set(workdir, set)
    }
    set.add(waiter)
  })
}

/**
 * Колбэк-вариант `whenInventoryReady`: вызывается ОДИН раз при завершении
 * скана (или с null по таймауту/остановке). Возвращает отписку — она глушит
 * колбэк, но не отменяет уже взведённый таймаут.
 */
export function onInventoryComplete(
  workdir: string,
  cb: (status: FileInventoryStatus | null) => void,
  opts: { timeoutMs?: number } = {},
): () => void {
  let cancelled = false
  void whenInventoryReady(workdir, opts.timeoutMs ?? 30_000).then((status) => {
    if (cancelled) return
    try { cb(status) } catch (e) { console.warn('[fileIndexer] inventory callback error:', e) }
  })
  return () => { cancelled = true }
}

/**
 * Дождаться готовности первичного скана. Оставлен для обратной совместимости
 * (сигнатура и семантика прежние), внутри — `whenInventoryReady`, без polling.
 * Если индекс уже стартовал кем-то раньше (например, @mention в чате) —
 * `startIndexing` теперь ждёт тот же скан, а не отдаёт частичный кэш.
 * Новому коду лучше `whenInventoryReady`/`onInventoryComplete`: они отдают
 * полный статус (complete/authoritative/truncated).
 */
export async function waitForIndexReady(workdir: string, timeoutMs = 30_000): Promise<boolean> {
  const status = await whenInventoryReady(workdir, timeoutMs)
  return status?.ready === true
}

/** Возвращает все файлы индекса (без фильтрации). Для отладки/экспорта. */
export function getAllFiles(workdir: string): FileEntry[] {
  return _indexes.get(workdir)?.files ?? []
}

/** Поиск файлов по query. Возвращает отсортированный через filterMentions
 *  список MentionItem[]. limit — макс. кол-во результатов. */
export function searchFiles(workdir: string, query: string, limit = 30): MentionItem[] {
  const entry = _indexes.get(workdir)
  if (!entry || !entry.ready) return []
  const items: MentionItem[] = entry.files.map(f => ({
    id: `file:${f.path}`,
    type: f.type,
    label: f.name,
    description: f.relPath,
    path: f.path,
    relPath: f.relPath,
    mime: f.mime,
    size: f.size,
    mtime: f.mtime,
  }))
  return filterMentions(query, items, limit)
}

/** Последние изменённые файлы (для @ без query). */
export function getRecentFiles(workdir: string, limit = 20): MentionItem[] {
  const entry = _indexes.get(workdir)
  if (!entry || !entry.ready) return []
  return entry.files.slice(0, limit).map(f => ({
    id: `file:${f.path}`,
    type: f.type,
    label: f.name,
    description: f.relPath,
    path: f.path,
    relPath: f.relPath,
    mime: f.mime,
    size: f.size,
    mtime: f.mtime,
  }))
}
