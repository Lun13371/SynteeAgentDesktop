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
 *  - startIndexing(workdir) — запускает watcher + первичный scan
 *  - stopIndexing(workdir) — останавливает
 *  - searchFiles(workdir, query) — возвращает FileEntry[] отсортированный
 *    через filterMentions (fuzzy)
 *  - getRecentFiles(workdir, limit) — последние изменённые файлы (для @ без query)
 *
 * Лимиты: maxFiles=20000 на проект (защита от гигантских mono-repo),
 * maxDepth=10 — глубже обычного обхода для полноты.
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
  watcher: FSWatcher
  files: FileEntry[]
  ready: boolean
  /** Список файлов, которые видит git (уже с применённым .gitignore). null — не git-проект. */
  gitFiles: Set<string> | null
  gitignore: GitignorePatterns
}

const _indexes = new Map<string, IndexEntry>()

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

async function scanDir(
  workdir: string,
  gitignore: GitignorePatterns,
  gitFiles: Set<string> | null,
  gitDirs: Set<string> | null,
  onFile: (entry: FileEntry) => void,
  count: { n: number },
): Promise<void> {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: workdir, depth: 0 }]
  while (stack.length > 0 && count.n < MAX_FILES) {
    const { dir, depth } = stack.pop()!
    if (depth > MAX_DEPTH) continue
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of dirents) {
      if (count.n >= MAX_FILES) break
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
        } catch {
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
        count.n++
      }
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Запускает индексацию workdir. Idempotent — повторный вызов для того же
 *  workdir не создаёт второй watcher. Возвращает Promise<void> который
 *  резолвится когда первичный scan завершён. */
export async function startIndexing(workdir: string): Promise<void> {
  if (_indexes.has(workdir)) return
  const gitignore = parseGitignore(workdir)
  // Git — эталонный список файлов проекта (учитывает .gitignore целиком:
  // `**`, `!`, вложенные .gitignore). Без git работают эвристики.
  const gitFiles = await listGitFiles(workdir)
  const gitDirs = gitFiles ? buildDirSet(gitFiles) : null
  const entry: IndexEntry = {
    workdir,
    watcher: undefined as unknown as FSWatcher,
    files: [],
    ready: false,
    gitFiles,
    gitignore,
  }
  _indexes.set(workdir, entry)

  // Первичный scan (быстрее chokidar для нашего кэша)
  const count = { n: 0 }
  await scanDir(workdir, gitignore, gitFiles, gitDirs, (fe) => entry.files.push(fe), count)
  entry.files.sort((a, b) => b.mtime - a.mtime)
  entry.ready = true

  // Запускаем watcher для incremental-обновлений.
  // fs.watch(recursive) — Windows ReadDirectoryChangesW: один kernel-handle
  // на всё дерево, 0% CPU в простое (chokidar давал тысячи handles + stat).
  // ── Incremental update: только изменившиеся файлы, НЕ полный rescan. ──
  // Копим изменившиеся пути в Set и debounce'ом обрабатываем только их
  // (stat каждого + upsert/remove в entry.files + re-sort).
  let debounceTimer: NodeJS.Timeout | null = null
  const pendingPaths = new Set<string>()
  const flush = async (): Promise<void> => {
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
      if (isIgnored(relPath, name, gitignore)) {
        const idx = entry.files.findIndex(f => f.path === fullPath)
        if (idx >= 0) entry.files.splice(idx, 1)
        continue
      }
      let st
      try {
        st = await stat(fullPath)
      } catch {
        // файл удалён — событие всё равно нужно (потребитель уберёт его из графа)
        changedRel.push(relPath)
        const idx = entry.files.findIndex(f => f.path === fullPath)
        if (idx >= 0) entry.files.splice(idx, 1)
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
    emitFileChanges(workdir, changedRel)
  }
  const scheduleRescan = (fullPath: string): void => {
    pendingPaths.add(fullPath)
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(flush, SCAN_DEBOUNCE_MS)
  }
  try {
    const watcher = watch(workdir, { recursive: true, persistent: true }, (_event, filename) => {
      // filename может быть null (редкие случаи на Windows) — такие события
      // пропускаем; индекс перепроверит stat при следующем обращении через
      // @mention (файл не найдётся — не страшно).
      if (!filename) return
      // filename приходит с '\\' или '/' сепараторами — нормализуем.
      const fullPath = workdir + sep + filename.split('/').join(sep).split('\\').join(sep)
      scheduleRescan(fullPath)
    })
    entry.watcher = watcher
    watcher.on('error', (e) => console.warn(`[fileIndexer] error for ${workdir}:`, e))
  } catch (e) {
    console.warn(`[fileIndexer] watcher failed for ${workdir}:`, e)
  }
}

/** Останавливает индексацию workdir. */
export async function stopIndexing(workdir: string): Promise<void> {
  const entry = _indexes.get(workdir)
  if (!entry) return
  try {
    await entry.watcher?.close()
  } catch { /* ignore */ }
  _indexes.delete(workdir)
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
 * Дождаться готовности первичного скана. Если индекс уже стартовал кем-то
 * раньше (например, @mention в чате) — startIndexing вернётся мгновенно с
 * НЕДОСКАНИРОВАННЫМ кэшем, а getAllFiles отдаст только его часть. Потребители
 * полного списка (карта проекта) должны дожидаться ready.
 */
export async function waitForIndexReady(workdir: string, timeoutMs = 30_000): Promise<boolean> {
  const started = Date.now()
  while (!isIndexReady(workdir)) {
    if (Date.now() - started > timeoutMs) return false
    await new Promise(r => setTimeout(r, 200))
  }
  return true
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
