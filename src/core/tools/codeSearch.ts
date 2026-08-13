import { resolve as pathResolve } from 'path'
import { existsSync } from 'fs'
import { execAsync, execFileAsync, DEFAULT_IGNORE_DIRS, type ToolResult } from './_shared'

// ── search_code — поиск по коду (ripgrep --json / PowerShell fallback) ────
//
// Ключевые решения (почему старая версия «не находила» и путала модель):
//  1. Парсинг вывода rg регэкспом слева ломался на именах с дефисами-цифрами
//     (stage-01-foundation.md, 1783920889254-swift-forest.md) — файлом
//     становился «stage», строкой «01», контент мусорился. Теперь берём
//     rg --json: путь/номер/тип строки приходят структурированно — регэкспов
//     на путях больше нет, баг невозможен.
//  2. Принудительный case-sensitive (-s) убит → smart-case (-S): lowercase-
//     паттерн находит CamelCase (getfastcontext → getFastContext). Главный
//     класс «не находит».
//  3. path стал опциональным (дефолт — корень проекта); несуществующий путь
//     даёт явную ошибку вместо молчаливого «No matches».
//  4. Битый regex (foo[) автоматически ретраится как literal (--fixed-strings)
//     с пометкой — вместо молчаливого падения в PS-fallback.
//  5. Two-pass: pass 1 --count-matches → точные per-file тоталы («shown 10 of
//     247»); pass 2 --json -m cap → контент. Честные счётчики, не слепая обрезка.
//  6. Маркеры: `>` совпадение, `-` контекст, `...` пропуск между блоками —
//     совпадение больше не сливается с контекстом в «сплошной код».
//  7. Бандленный @vscode/ripgrep — rg есть из коробки (без системной установки).

interface SearchOpts {
  fileGlob?: string
  ignoreCase?: boolean
  maxResults?: number
  context?: number
  maxChars?: number
  literal?: boolean
  workdir?: string
  filesOnly?: boolean
}

interface Limits {
  totalMax: number
  perFileDisplayCap: number
  contextLines: number
  maxChars: number
}

// Дополнительные glob-исключения: секреты и артефакты, которые не стоит тащить
// в контекст модели. .git исключаем отдельно при --hidden (иначе rg честно
// пройдётся по всей истории репозитория — очень медленно).
const SEARCH_EXTRA_IGNORE = ['.git', '.env', '.env.*', '*.pem', '*.key', '*.min.js', '*.map']

let rgBin: string | null | undefined = undefined

async function findRg(): Promise<string | null> {
  if (rgBin !== undefined) return rgBin
  // 1) Бандленный @vscode/ripgrep — работает из коробки, без системного rg.
  //    Платформенный бинарь лежит в @vscode/ripgrep-<platform>/bin (не в самом
  //    @vscode/ripgrep). В asar-сборке путь внутри app.asar — бинарь оттуда не
  //    исполняется, поэтому asarUnpack (см. electron-builder.yml) и замена
  //    app.asar → app.asar.unpacked.
  try {
    const rgPath = require('@vscode/ripgrep').rgPath as string
    if (rgPath) {
      const unpacked = rgPath.replace(/\bapp\.asar\b/, 'app.asar.unpacked')
      if (existsSync(unpacked)) { rgBin = unpacked; return rgBin }
      if (existsSync(rgPath)) { rgBin = rgPath; return rgBin }
    }
  } catch { /* dep не установлен (dev без install) — идём к системному rg */ }
  // 2) Системный rg. На win32 — where.exe (в PowerShell `where` = Where-Object).
  try {
    const cmd = process.platform === 'win32' ? 'where.exe rg' : 'which rg'
    const { stdout } = await execAsync(cmd, { timeout: 3000 })
    rgBin = stdout.trim().split('\n')[0].trim() || null
  } catch { rgBin = null }
  return rgBin
}

function buildGlobArgs(opts?: SearchOpts): string[] {
  const args: string[] = []
  if (opts?.fileGlob) args.push('--glob', opts.fileGlob)
  for (const g of SEARCH_EXTRA_IGNORE) args.push('--glob', `!${g}`)
  return args
}

/** Запускает rg один раз, НЕ бросается — возвращает {code, stdout, stderr}.
 *  rg exit 1 = нет совпадений (не ошибка); 2 = реальная ошибка; 0 = ок.
 *  maxBuffer (теоретически возможен только без -m) трактуем как code 2. */
async function runRgOnce(rg: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(rg, args, { timeout: 15000, maxBuffer: 10 * 1024 * 1024 })
    return { stdout, stderr, code: 0 }
  } catch (e: any) {
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return { stdout: (e.stdout ?? '').toString(), stderr: 'maxbuffer exceeded', code: 2 }
    }
    const code = typeof e.code === 'number' ? e.code : 1
    return { stdout: (e.stdout ?? '').toString(), stderr: (e.stderr ?? '').toString(), code }
  }
}

/** Парсит `rg --count-matches --with-filename` → per-file тоталы.
 *  Формат строки `path:N`. Путь может содержать двоеточие диска (C:), поэтому
 *  режем по LAST двоеточию (счёт всегда в конце, путь двоеточий справа не имеет). */
function parseCounts(stdout: string): { counts: Map<string, number>; grandTotal: number } {
  const counts = new Map<string, number>()
  let grandTotal = 0
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const idx = line.lastIndexOf(':')
    if (idx > 0) {
      const file = line.slice(0, idx)
      const n = parseInt(line.slice(idx + 1), 10) || 0
      counts.set(file, n)
      grandTotal += n
    }
  }
  return { counts, grandTotal }
}

interface MatchRow { line: number; text: string; isMatch: boolean }
interface FileEntry { rows: MatchRow[]; matchCount: number }

/** Парсит `rg --json` (NDJSON) → файлы со строками.
 *  События: begin (path), match (line_number, lines.text, submatches),
 *  context (line_number, lines.text), end, summary. Тип строки (match/context)
 *  берётся из `type` — больше никакой эвристики по `:`/`-` после номера.
 *  Разрыв между блоками (line_number > lastLine+1) → строка-разделитель. */
function parseJsonContent(stdout: string): Map<string, FileEntry> {
  const files = new Map<string, FileEntry>()
  let currentFile: string | null = null
  let lastLine = -1
  for (const raw of stdout.split('\n')) {
    if (!raw.trim()) continue
    let evt: any
    try { evt = JSON.parse(raw) } catch { continue }
    const t = evt?.type
    if (t === 'begin') {
      currentFile = evt.data?.path?.text ?? null
      if (currentFile && !files.has(currentFile)) files.set(currentFile, { rows: [], matchCount: 0 })
      lastLine = -1
    } else if (t === 'match' || t === 'context') {
      const file = evt.data?.path?.text ?? currentFile
      if (!file) continue
      let entry = files.get(file)
      if (!entry) { entry = { rows: [], matchCount: 0 }; files.set(file, entry) }
      const lineNum = evt.data?.line_number ?? 0
      const rawText = evt.data?.lines?.text
      // CRLF-хвост подрезаем, отступы НЕ трогаем (раньше .Trim() убивал контекст).
      const text = typeof rawText === 'string' ? rawText.replace(/\r$/, '') : '[binary/invalid utf-8]'
      const isMatch = t === 'match'
      if (lastLine >= 0 && lineNum > lastLine + 1) {
        entry.rows.push({ line: -1, text: '', isMatch: false }) // разделитель `...`
      }
      entry.rows.push({ line: lineNum, text, isMatch })
      if (isMatch) entry.matchCount++
      lastLine = lineNum
    }
  }
  return files
}

/** Относительный путь от workdir (экономия токенов + читаемость).
 *  Вне workdir — абсолютный (нормализованный в /). */
function relPath(file: string, workdir: string): string {
  const f = file.replace(/\\/g, '/')
  let w = workdir.replace(/\\/g, '/')
  if (w.endsWith('/')) w = w.slice(0, -1)
  if (f.startsWith(w + '/')) return f.slice(w.length + 1)
  return f
}

function truncateLine(text: string): string {
  return text.length > 500 ? text.slice(0, 500) + `… [+${text.length - 500} chars]` : text
}

function formatOutput(
  files: Map<string, FileEntry>,
  counts: Map<string, number>,
  grandTotal: number,
  opts: SearchOpts | undefined,
  workdir: string,
  literalMode: boolean,
  lim: Limits
): string {
  // Сортировка по убыванию match count (из pass 1) — самый «жирный» файл первым.
  const sorted = [...files.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))
  const out: string[] = []
  let shownMatches = 0
  let shownFiles = 0
  for (const file of sorted) {
    if (shownMatches >= lim.totalMax) break
    const entry = files.get(file)!
    const total = counts.get(file) ?? entry.matchCount
    shownFiles++
    shownMatches += entry.matchCount
    const more = total > entry.matchCount ? ` (${total} matches, showing ${entry.matchCount})` : ''
    out.push(`\n● ${relPath(file, workdir)}${more}`)
    for (const row of entry.rows) {
      if (row.line < 0) { out.push('  ...'); continue }
      const mark = row.isMatch ? '>' : '-'
      out.push(`  ${mark} ${row.line}: ${truncateLine(row.text)}`)
    }
  }
  const hiddenFiles = counts.size - shownFiles
  const modeTag = literalMode ? 'literal' : 'regex'
  const caseTag = opts?.ignoreCase ? 'case-insensitive' : 'smart-case'
  const showPart = shownMatches < grandTotal ? ` — showing ${shownMatches} in ${shownFiles} files` : ''
  const header = `[search_code: ${grandTotal} matches in ${counts.size} files${showPart} (${modeTag}, ${caseTag})]`
  let suffix = ''
  if (literalMode && !opts?.literal) suffix += '\n[note: pattern was invalid regex — searched literally]'
  if (hiddenFiles > 0) suffix += `\n... [${hiddenFiles} more files with matches not shown — narrow path/file_glob or raise max_results]`
  const body = out.join('\n')
  return header + suffix + (body ? '\n' + body : '')
}

function formatFilesOnly(counts: Map<string, number>, workdir: string, grandTotal: number): string {
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const out = [`[search_code: ${grandTotal} matches in ${counts.size} files (files_only)]`]
  for (const [file, n] of sorted) out.push(`  ${relPath(file, workdir)} — ${n}`)
  return out.join('\n')
}

/** Подсказка при пустом результате — направляет к альтернативам вместо слепых
 *  ретраев (которые раньше загоняли модель в loop-guard). */
function buildEmptyHint(pattern: string, opts: SearchOpts | undefined, literalMode: boolean): string {
  const hints = ['No matches found.']
  // #8: Специфичный hint для | (alternation) — самый частый кейс путаницы
  if (!literalMode && pattern.includes('|')) {
    hints.push('Pattern contains | (alternation). If you meant literal |, use literal=true. If you meant alternation, check each alternative separately — one may have a typo.')
  } else if (!literalMode && /[.[\]()*+?{}\\$^|]/.test(pattern)) {
    hints.push('Pattern has regex metachars — retry with literal=true if you meant them as text.')
  }
  if (!opts?.fileGlob) hints.push('Narrow file_glob (e.g. "*.ts") or path to a subfolder.')
  hints.push('Do NOT loop over pattern variants — switch tool: find_files (file names) / get_fast_context (concepts / "where is X") / read_file outline (browse a file).')
  return hints.join(' ')
}

/** Обрезает вывод по границе файла (маркер `● `), чтобы не оставлять «висячих»
 *  номеров строк без заголовка файла. */
function sliceOnFileBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const window = text.slice(0, maxChars)
  const lastMarker = window.lastIndexOf('\n● ')
  if (lastMarker > maxChars * 0.5) return text.slice(0, lastMarker)
  return text.slice(0, maxChars)
}

export async function searchCode(
  pattern: string,
  searchPath: string | undefined,
  opts?: SearchOpts
): Promise<ToolResult> {
  const totalMax = opts?.maxResults ?? 100
  // perFileDisplayCap — потолок совпадений на один файл в выводе (pass 2 -m).
  // totalMax — потолок ВСЕГО показанных совпадений (широтный режим: больше
  // файлов, меньше на каждое). perFileCap = ~10, чтобы один «жирный» файл не
  // вытеснил остальные.
  const perFileDisplayCap = Math.max(1, Math.min(10, Math.ceil(totalMax / 10)))
  const contextLines = opts?.context ?? 3
  const maxChars = opts?.maxChars ?? 20000
  const workdir = opts?.workdir ?? process.cwd()
  const rel = searchPath && searchPath.trim() ? searchPath : '.'
  const absPath = pathResolve(workdir, rel)

  if (!pattern || !pattern.trim()) {
    return { success: false, output: '', error: 'search_code: pattern is empty.' }
  }
  // Валидация пути — вместо молчаливого «No matches» при опечатке в path.
  if (!existsSync(absPath)) {
    return {
      success: false,
      output: '',
      error: `search_code: path does not exist: "${absPath}" (resolved from "${searchPath ?? '.'}", workdir: "${workdir}"). Omit path to search the whole project, or fix the path.`,
    }
  }

  const rg = await findRg()
  if (rg) {
    return searchWithRg(rg, pattern, absPath, workdir, opts, { totalMax, perFileDisplayCap, contextLines, maxChars })
  }
  // rg не найден — PowerShell (медленнее, но работает без rg).
  return searchCodePowerShell(pattern, absPath, opts)
}

async function searchWithRg(
  rg: string, pattern: string, absPath: string, workdir: string,
  opts: SearchOpts | undefined, lim: Limits
): Promise<ToolResult> {
  const globArgs = buildGlobArgs(opts)
  const caseFlag = opts?.ignoreCase ? '-i' : '-S' // smart-case по умолчанию
  let literalMode = !!opts?.literal
  const litArgs = (): string[] => literalMode ? ['--fixed-strings'] : []

  // ── Pass 1: per-file counts (быстро, маленький вывод) ──
  let countRes = await runRgOnce(rg, ['--count-matches', '--with-filename', '--hidden', caseFlag, ...litArgs(), ...globArgs, pattern, absPath])
  // Битый regex → авто-retry как literal (один раз).
  if (countRes.code === 2 && !literalMode && /parse error|regex|unrecognized|invalid/i.test(countRes.stderr)) {
    literalMode = true
    countRes = await runRgOnce(rg, ['--count-matches', '--with-filename', '--hidden', caseFlag, '--fixed-strings', ...globArgs, pattern, absPath])
  }
  if (countRes.code === 2) {
    // Реальная ошибка rg (не regex) — fallback в PowerShell.
    const ps = await searchCodePowerShell(pattern, absPath, opts)
    if (ps.success) return { success: true, output: `[rg error: ${countRes.stderr.slice(0, 100)}]\n${ps.output}` }
    return ps
  }

  const { counts, grandTotal } = parseCounts(countRes.stdout)

  if (grandTotal === 0) {
    // #8: Если паттерн содержит | (alternation) и не literal — пробуем literal
    // (| может быть валидным regex, но не находить совпадений, а как literal — находить)
    if (!literalMode && pattern.includes('|')) {
      const litCountRes = await runRgOnce(rg, ['--count-matches', '--with-filename', '--hidden', caseFlag, '--fixed-strings', ...globArgs, pattern, absPath])
      const { grandTotal: litTotal } = parseCounts(litCountRes.stdout)
      if (litTotal > 0) {
        // Literal нашёл — перезапускаем pass 2 в literal mode
        literalMode = true
        const litContentRes = await runRgOnce(rg, ['--json', '--hidden', caseFlag, '--fixed-strings', ...globArgs, '-C', String(lim.contextLines), '-m', String(lim.perFileDisplayCap), pattern, absPath])
        const files = parseJsonContent(litContentRes.stdout)
        const formatted = formatOutput(files, parseCounts(litCountRes.stdout).counts, litTotal, opts, workdir, true, lim)
        if (formatted.length <= lim.maxChars) return { success: true, output: formatted }
        const sliced = sliceOnFileBoundary(formatted, lim.maxChars)
        return { success: true, output: sliced + `\n...[truncated, ${sliced.length} of ${formatted.length} chars — narrow file_glob/path or raise max_chars]` }
      }
    }
    return { success: true, output: buildEmptyHint(pattern, opts, literalMode) }
  }

  // files_only — дешёвый broad-обзор: только список файлов со счётчиками.
  if (opts?.filesOnly) {
    return { success: true, output: formatFilesOnly(counts, workdir, grandTotal) }
  }

  // ── Pass 2: контент (--json, ограничен -m per file) ──
  let contentRes = await runRgOnce(rg, ['--json', '--hidden', caseFlag, ...litArgs(), ...globArgs, '-C', String(lim.contextLines), '-m', String(lim.perFileDisplayCap), pattern, absPath])
  if (contentRes.code === 2 && !literalMode && /parse error|regex|unrecognized|invalid/i.test(contentRes.stderr)) {
    literalMode = true
    contentRes = await runRgOnce(rg, ['--json', '--hidden', caseFlag, '--fixed-strings', ...globArgs, '-C', String(lim.contextLines), '-m', String(lim.perFileDisplayCap), pattern, absPath])
  }
  if (contentRes.code === 2) {
    const ps = await searchCodePowerShell(pattern, absPath, opts)
    if (ps.success) return { success: true, output: `[rg error: ${contentRes.stderr.slice(0, 100)}]\n${ps.output}` }
    return ps
  }

  const files = parseJsonContent(contentRes.stdout)
  const formatted = formatOutput(files, counts, grandTotal, opts, workdir, literalMode, lim)
  if (formatted.length <= lim.maxChars) return { success: true, output: formatted }
  const sliced = sliceOnFileBoundary(formatted, lim.maxChars)
  return {
    success: true,
    output: sliced + `\n...[truncated, ${sliced.length} of ${formatted.length} chars — narrow file_glob/path or raise max_chars]`,
  }
}

/** Разбирает file_glob в список расширений для PS-фильтра (brace-expansion):
 *  "*.ts" → [".ts"], "*.{ts,tsx}" → [".ts",".tsx"], "*.config.ts" → [".ts"].
 *  PS -Filter не поддерживает {a,b} — поэтому фильтруем через Where-Object. */
function parseGlobExts(glob?: string): string[] | null {
  if (!glob) return null
  const brace = glob.match(/^\*\.\{(.+)\}$/)
  if (brace) return brace[1].split(',').map(e => (e.startsWith('.') ? e : '.' + e))
  const simple = glob.match(/^\*(\.[\w.]+)$/)
  if (simple) return [simple[1]]
  return null
}

async function searchCodePowerShell(
  pattern: string,
  absPath: string,
  opts?: SearchOpts
): Promise<ToolResult> {
  const maxResults = opts?.maxResults ?? 100
  const context = opts?.context ?? 3
  // Экранирование одинарной кавычки для PS-строки: ' → ''
  const sq = (s: string) => s.replace(/'/g, "''")
  // Smart-case эмуляция: lowercase-паттерн → case-insensitive (parity с rg -S).
  const hasUpper = /[A-Z]/.test(pattern)
  const caseInsensitive = !!opts?.ignoreCase || (!hasUpper && !opts?.literal)
  const strFlags = opts?.literal ? '-SimpleMatch' : (caseInsensitive ? '' : '-CaseSensitive')
  // Раскрываем brace-glob в фильтр по расширениям (PS -Filter {a,b} не умеет).
  const exts = parseGlobExts(opts?.fileGlob)
  const extFilter = exts && exts.length
    ? `Where-Object { ${exts.map(e => `$_.Extension -eq '${sq(e)}'`).join(' -or ')} }`
    : ''
  const ignoreParts = [...DEFAULT_IGNORE_DIRS, '.env', '\\.env\\..*', '\\.pem$', '\\.key$', '.git']
    .map(d => d.replace(/\./g, '\\.').replace(/\*/g, '.*'))
  const ignoreRegex = ignoreParts.join('|')

  // -File (вместо -not $_.PSIsContainer) — чище и быстрее.
  // .Line БЕЗ .Trim() — отступы контекста важны (раньше терялись).
  const psScript = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ` +
    `$r = Get-ChildItem -Path '${sq(absPath)}' -Recurse -Force -File -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.FullName -notmatch '${ignoreRegex}' }` +
    (extFilter ? ` ${extFilter}` : '') + ` | ` +
    `Select-String ${strFlags} -Pattern '${sq(pattern)}' -Context ${context},${context} -ErrorAction SilentlyContinue | ` +
    `Select-Object -First ${maxResults}; ` +
    `if ($r) { $r | ForEach-Object { $_.Path + ':' + $_.LineNumber + ': ' + $_.Line } } else { 'No matches found' }`
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
  const psCmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
  try {
    const { stdout } = await execAsync(psCmd, { timeout: 25000, maxBuffer: 10 * 1024 * 1024 })
    const trimmed = stdout.trim()
    if (!trimmed || trimmed === 'No matches found') {
      return { success: true, output: buildEmptyHint(pattern, opts, !!opts?.literal) }
    }
    const lines = trimmed.split('\n').filter(l => l.trim())
    // Считаем файлы для шапки (regex по `path:NUM:` — Windows-путь с двоеточием
    // диска не мешает: первое `:digit:` после пути).
    const fileSet = new Set<string>()
    for (const l of lines) {
      const m = l.match(/^(.+?):(\d+):/)
      if (m) fileSet.add(m[1])
    }
    return {
      success: true,
      output: `[search_code: ${lines.length} matches in ${fileSet.size} files (PowerShell fallback)]\n${trimmed}`,
    }
  } catch (e: any) {
    return { success: false, output: '', error: 'search_code: ' + e.message }
  }
}
