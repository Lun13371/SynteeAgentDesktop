import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join, resolve as pathResolve } from 'path'
import { clipboard } from 'electron'
import OpenAI from 'openai'
import type Store from 'electron-store'
import type { Provider } from '../../shared/types'
import * as Diff from 'diff'

const execAsync = promisify(exec)

export interface ToolResult {
  success: boolean
  output: string
  error?: string
  diff?: string
  hidden?: boolean  // скрытые тулы (think, update_working_memory) — не показываются в UI
}

export async function runCommand(cmd: string, cwd?: string, shell?: string, timeout?: number): Promise<ToolResult> {
  try {
    const isWin = process.platform === 'win32'
    const timeoutMs = (timeout || 60) * 1000

    let execCmd: string
    let execOpts: Parameters<typeof execAsync>[1]

    if (isWin) {
      // Windows: PowerShell по умолчанию — понимает ls/cat/rm/mkdir/grep и т.д.
      // cmd только если явно указан shell: 'cmd'
      if (shell === 'cmd') {
        execCmd = cmd
        execOpts = {
          cwd: cwd || homedir(),
          timeout: timeoutMs,
          shell: 'cmd.exe',
          encoding: 'utf8',
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        }
      } else {
        // PowerShell: utf-8 output, понимает большинство unix-команд
        const escaped = cmd.replace(/"/g, '\\"')
        execCmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${escaped}"`
        execOpts = {
          cwd: cwd || homedir(),
          timeout: timeoutMs,
          encoding: 'utf8',
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        }
      }
    } else {
      // Linux/Mac — bash напрямую
      execCmd = cmd
      execOpts = {
        cwd: cwd || homedir(),
        timeout: timeoutMs,
        shell: '/bin/bash',
        encoding: 'utf8',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      }
    }

    const { stdout, stderr } = await execAsync(execCmd, execOpts)
    const stdoutClean = (stdout as string)?.trim() || ''
    const stderrClean = (stderr as string)?.trim() || ''
    let out = smartTrimOutput(stdoutClean) || '(нет вывода)'
    if (stderrClean) out += `\n[stderr]:\n${smartTrimOutput(stderrClean)}`
    return { success: true, output: `[exit: 0]\n${out}` }
  } catch (e: any) {
    const stdoutPart = smartTrimOutput(e.stdout?.trim() || '')
    const stderrPart = smartTrimOutput(e.stderr?.trim() || '')
    const exitCode = typeof e.code === 'number' ? e.code : 1
    let out = `[exit: ${exitCode}]`
    if (stdoutPart) out += `\n[stdout]:\n${stdoutPart}`
    if (stderrPart) out += `\n[stderr]:\n${stderrPart}`
    return {
      success: false,
      output: out,
      error: stderrPart || e.message?.replace(/Command failed:.+\n?/, '').trim() || 'Команда завершилась с ошибкой',
    }
  }
}

// Умная обрезка вывода команды — показываем начало (контекст) и конец (результат/ошибки)
function smartTrimOutput(text: string, maxChars = 4000): string {
  if (!text || text.length <= maxChars) return text
  const head = 800   // начало — контекст команды
  const tail = 2000  // конец — результат и ошибки (самое важное)
  const removed = text.length - head - tail
  return `${text.slice(0, head)}\n\n...[обрезано ${removed} символов, показано начало и конец]...\n\n${text.slice(-tail)}`
}

export function readFile(path: string, offset?: number, limit?: number, outlineOnly?: boolean): ToolResult {
  try {
    if (!existsSync(path)) return { success: false, output: '', error: 'Файл не найден: ' + path }
    const content = readFileSync(path, 'utf-8')
    const lines = content.split('\n')
    const totalLines = lines.length

    // outline_only — возвращаем только структуру файла
    if (outlineOnly) {
      const outlineResult = getFileOutline(path)
      return outlineResult
    }

    if (offset !== undefined || limit !== undefined) {
      const from = Math.max(0, (offset ?? 1) - 1)  // offset 1-indexed
      const count = limit ?? 200
      const slice = lines.slice(from, from + count)
      const numbered = slice.map((l, i) => `${from + i + 1}|${l}`).join('\n')
      const hasMore = from + count < totalLines
      const truncatedInfo = hasMore
        ? `\n...[показано ${slice.length} из ${totalLines} строк | ещё ${totalLines - from - count} строк | используй offset=${from + count + 1} для продолжения]`
        : ''
      return {
        success: true,
        output: `[Файл: ${path} | Строки ${from + 1}-${from + slice.length} из ${totalLines}]${truncatedInfo}\n${numbered}`,
      }
    }

    // Без offset — читаем первые 100 строк, если файл большой — добавляем авто-outline
    const DEFAULT_LINES = 100
    const truncated = totalLines > DEFAULT_LINES
    const slice = lines.slice(0, DEFAULT_LINES)
    const numbered = slice.map((l, i) => `${i + 1}|${l}`).join('\n')

    let suffix = ''
    if (truncated) {
      suffix = `\n...[показано ${DEFAULT_LINES} из ${totalLines} строк | используй offset/limit для чтения по частям]`
      // Авто-outline для больших файлов — агент сразу видит структуру
      const ext = path.split('.').pop()?.toLowerCase()
      if (['ts', 'tsx', 'js', 'jsx', 'py'].includes(ext ?? '')) {
        const outlineResult = getFileOutline(path)
        if (outlineResult.success) suffix += `\n\n${outlineResult.output}`
      }
    }
    return {
      success: true,
      output: `[Файл: ${path} | ${totalLines} строк]${suffix}\n${numbered}`,
    }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}

export function writeFile(path: string, content: string): ToolResult {
  try {
    const dir = join(path, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    // Читаем оригинал для diff (если файл существует)
    let original = ''
    try { original = existsSync(path) ? readFileSync(path, 'utf-8') : '' } catch { /* ok */ }
    writeFileSync(path, content, 'utf-8')
    const lines = content.split('\n').length
    // Генерируем diff как у edit_file
    const diff = makeDiff(original, content, path)
    const changedLines = diff.split('\n').filter((l: string) => l.startsWith('+') || l.startsWith('-')).length
    return { success: true, output: `Файл записан: ${path} (${lines} строк, ${changedLines} строк изменено)`, diff }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}

// Генерирует unified diff через npm diff (LCS-based, как git)
function makeDiff(oldContent: string, newContent: string, filePath: string): string {
  const patch = Diff.createPatch(filePath, oldContent, newContent, '', '', { context: 3 })
  // Убираем заголовок "Index: ...\n======\n" — оставляем только с --- строки
  const lines = patch.split('\n')
  const start = lines.findIndex(l => l.startsWith('---'))
  return start >= 0 ? lines.slice(start).join('\n') : patch
}

export interface EditResult extends ToolResult {
  diff?: string
}

export function editFile(params: {
  path: string
  mode: 'replace' | 'insert' | 'overwrite'
  old_str?: string
  new_str?: string
  after_line?: number
  content?: string
  create_if_not_exists?: boolean
}): EditResult {
  try {
    const fileExists = existsSync(params.path)

    // create_if_not_exists — создать файл если не существует (только overwrite/insert)
    if (!fileExists) {
      if (params.create_if_not_exists) {
        const dir = join(params.path, '..')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        const initial = params.content ?? params.new_str ?? ''
        writeFileSync(params.path, initial, 'utf-8')
        return { success: true, output: `Файл создан: ${params.path}`, diff: `+++ ${params.path}\n${initial.split('\n').map(l => '+' + l).join('\n')}` }
      }
      return { success: false, output: '', error: 'Файл не найден: ' + params.path }
    }

    const original = readFileSync(params.path, 'utf-8')
    let updated = original

    if (params.mode === 'replace') {
      if (!params.old_str) return { success: false, output: '', error: 'edit_file replace: нужен old_str' }
      // Нормализуем CRLF → LF для сравнения
      const normStr = (s: string) => s.split('\r\n').join('\n').split('\r').join('\n')
      const normOrig = normStr(original)
      const normOld = normStr(params.old_str)
      if (!normOrig.includes(normOld)) {
        // Попытка fuzzy: игнорируем ведущие пробелы строк
        const stripIndent = (s: string) => s.split('\n').map(l => l.trimStart()).join('\n')
        if (stripIndent(normOrig).includes(stripIndent(normOld))) {
          // Найдено с другим отступом — ищем реальное место в оригинале
          const oldLines = normOld.split('\n').map(l => l.trimStart())
          const origLines = normOrig.split('\n')
          const matchIdx = origLines.findIndex((_, i) =>
            oldLines.every((ol, j) => (origLines[i + j] ?? '').trimStart() === ol)
          )
          if (matchIdx >= 0) {
            const realOld = origLines.slice(matchIdx, matchIdx + oldLines.length).join('\n')
            updated = normOrig.replace(realOld, params.new_str ?? '')
          } else {
            return { success: false, output: '', error: 'edit_file replace: old_str не найден (fuzzy тоже не помог). Проверь отступы и точность фрагмента.' }
          }
        } else {
          return { success: false, output: '', error: 'edit_file replace: old_str не найден в файле. Используй read_file чтобы уточнить контент.' }
        }
      } else {
        updated = normOrig.replace(normOld, params.new_str ?? '')
      }

    } else if (params.mode === 'insert') {
      const lines = original.split('\n')
      const at = Math.min(params.after_line ?? lines.length, lines.length)
      lines.splice(at, 0, ...(params.content ?? '').split('\n'))
      updated = lines.join('\n')

    } else if (params.mode === 'overwrite') {
      if (params.content === undefined) return { success: false, output: '', error: 'edit_file overwrite: нужен content' }
      updated = params.content
    }

    writeFileSync(params.path, updated, 'utf-8')
    const diff = makeDiff(original, updated, params.path)
    const changedLines = diff.split('\n').filter(l => l.startsWith('+') || l.startsWith('-')).length
    return { success: true, output: `Файл обновлён: ${params.path} (${changedLines} строк изменено)`, diff }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}

export function multiEditFile(params: {
  path: string
  edits: Array<{ old_str: string; new_str: string }>
}): EditResult {
  try {
    if (!existsSync(params.path)) return { success: false, output: '', error: 'Файл не найден: ' + params.path }
    const original = readFileSync(params.path, 'utf-8')
    let updated = original
    const failed: string[] = []

    for (const edit of params.edits) {
      if (updated.includes(edit.old_str)) {
        updated = updated.replace(edit.old_str, edit.new_str)
      } else {
        failed.push(edit.old_str.slice(0, 60) + '…')
      }
    }

    writeFileSync(params.path, updated, 'utf-8')
    const diff = makeDiff(original, updated, params.path)
    const changedLines = diff.split('\n').filter(l => l.startsWith('+') || l.startsWith('-')).length
    const warn = failed.length ? `\nНе найдено ${failed.length} фрагментов: ${failed.join('; ')}` : ''
    return { success: true, output: `Файл обновлён: ${params.path} (${changedLines} строк изменено)${warn}`, diff }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}

export function listDirectory(path: string, opts?: { recursive?: boolean; depth?: number; ignore?: string[] }): ToolResult {
  try {
    if (!existsSync(path)) return { success: false, output: '', error: 'Папка не найдена: ' + path }
    const maxDepth = opts?.depth ?? (opts?.recursive ? 3 : 0)
    const defaultIgnore = ['node_modules', 'dist', 'out', '.git', '__pycache__', '.venv', 'build', '.next', 'coverage']
    const ignore = [...defaultIgnore, ...(opts?.ignore ?? [])]
    const lines: string[] = []

    const walk = (dir: string, level: number, prefix: string) => {
      if (level > maxDepth) return
      let entries: string[]
      try { entries = readdirSync(dir) } catch { return }
      entries.sort((a, b) => {
        const aIsDir = statSync(join(dir, a)).isDirectory()
        const bIsDir = statSync(join(dir, b)).isDirectory()
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1
        return a.localeCompare(b)
      })
      entries.forEach((name, i) => {
        if (ignore.includes(name)) return
        const full = join(dir, name)
        const isLast = i === entries.length - 1 || entries.slice(i + 1).every(n => ignore.includes(n))
        const stat = statSync(full)
        const isDir = stat.isDirectory()
        const connector = isLast ? '└── ' : '├── '
        const size = isDir ? '' : ` (${formatSize(stat.size)})`
        lines.push(`${prefix}${connector}${name}${isDir ? '/' : size}`)
        if (isDir && level < maxDepth) {
          walk(full, level + 1, prefix + (isLast ? '    ' : '│   '))
        }
      })
    }

    lines.push(path + '/')
    walk(path, 0, '')
    if (lines.length > 300) {
      return { success: true, output: lines.slice(0, 300).join('\n') + `\n...[обрезано, показано 300 из ${lines.length} записей]` }
    }
    return { success: true, output: lines.join('\n') }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}

export function getClipboard(): ToolResult {
  const text = clipboard.readText()
  return { success: true, output: text || '(буфер обмена пуст)' }
}

// ── find_files — поиск файлов по имени/паттерну ───────────────────────────
export function findFiles(pattern: string, searchPath: string, opts?: { maxResults?: number }): ToolResult {
  const maxResults = opts?.maxResults ?? 50
  const defaultIgnore = ['node_modules', 'dist', 'out', '.git', '__pycache__', '.venv', 'build', '.next', 'coverage']
  const results: string[] = []
  const rx = (() => {
    try { return new RegExp(pattern, 'i') } catch {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
      return new RegExp(escaped, 'i')
    }
  })()
  const walk = (dir: string) => {
    if (results.length >= maxResults) return
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      if (defaultIgnore.includes(name)) continue
      const full = join(dir, name)
      let stat; try { stat = statSync(full) } catch { continue }
      if (stat.isDirectory()) walk(full)
      else if (rx.test(name)) { results.push(full); if (results.length >= maxResults) return }
    }
  }
  if (!existsSync(searchPath)) return { success: false, output: '', error: 'Путь не найден: ' + searchPath }
  walk(searchPath)
  if (results.length === 0) return { success: true, output: 'Файлов не найдено' }
  return { success: true, output: results.join('\n') + (results.length >= maxResults ? `\n...[показано ${maxResults}, есть ещё]` : `\n[Найдено: ${results.length}]`) }
}

// ── get_file_outline — структура файла (функции/классы/экспорты) ──────────
export function getFileOutline(filePath: string): ToolResult {
  if (!existsSync(filePath)) return { success: false, output: '', error: 'Файл не найден: ' + filePath }
  try {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')
    const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
    const outline: string[] = [`[Outline: ${filePath} | ${lines.length} строк]`]
    const tsPatterns: Array<{ re: RegExp; label: string }> = [
      { re: /^export\s+default\s+(async\s+)?(function|class)\s*(\w*)/, label: 'export default' },
      { re: /^export\s+(async\s+)?function\s+(\w+)/, label: 'export fn' },
      { re: /^export\s+(const|let)\s+(\w+)\s*[:=].*(?:=>|\bfunction\b)/, label: 'export const fn' },
      { re: /^export\s+(?:abstract\s+)?class\s+(\w+)/, label: 'class' },
      { re: /^export\s+(?:interface|type|enum)\s+(\w+)/, label: 'type' },
      { re: /^  (?:public|private|protected|static|async|\bget\b|\bset\b)\s+(?:async\s+)?(\w+)\s*[(<]/, label: 'method' },
      { re: /^(?:async\s+)?function\s+(\w+)/, label: 'fn' },
      { re: /^(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/, label: 'fn' },
      { re: /^import\s+.*\s+from\s+['"](.+)['"]/, label: 'import' },
    ]
    const pyPatterns: Array<{ re: RegExp; label: string }> = [
      { re: /^(?:async\s+)?def\s+(\w+)/, label: 'def' },
      { re: /^class\s+(\w+)/, label: 'class' },
      { re: /^(?:from\s+\S+\s+)?import\s+(\S+)/, label: 'import' },
    ]
    const activePatterns = ['py'].includes(ext) ? pyPatterns : tsPatterns
    const imports: string[] = []
    let pastImports = false
    lines.forEach((line, i) => {
      for (const { re, label } of activePatterns) {
        const m = line.match(re)
        if (!m) continue
        const name = (m[3] || m[2] || m[1] || '').trim() || line.slice(0, 50)
        if (label === 'import') { if (!pastImports) imports.push(name); return }
        if (!pastImports) {
          if (imports.length) outline.push(`  imports(${imports.length}): ${imports.slice(0, 5).join(', ')}${imports.length > 5 ? ` +${imports.length - 5}` : ''}`)
          pastImports = true
        }
        outline.push(`  ${i + 1}: [${label}] ${name}`)
        return
      }
      if (!pastImports && line.trim() && !line.startsWith('//') && !line.startsWith(' *') && !line.startsWith('*')) pastImports = true
    })
    if (!pastImports && imports.length) outline.push(`  imports(${imports.length}): ${imports.slice(0, 5).join(', ')}`)
    return { success: true, output: outline.join('\n') }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}

export function setClipboard(text: string): ToolResult {
  clipboard.writeText(text)
  return { success: true, output: 'Скопировано в буфер обмена' }
}

export async function searchWeb(query: string, apiKey?: string): Promise<ToolResult> {
  if (!apiKey) return { success: false, output: '', error: 'Нет Tavily API ключа. Добавьте в Настройки → Интеграции' }
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, max_results: 5, search_depth: 'basic' }),
    })
    const data = await res.json() as { results: Array<{ title: string; url: string; content: string }> }
    const formatted = data.results.map((r, i) =>
      '[' + (i+1) + '] ' + r.title + '\nURL: ' + r.url + '\n' + r.content.slice(0, 300) + '...'
    ).join('\n\n')
    return { success: true, output: formatted }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}

export function getSystemInfo(): ToolResult {
  const os = process.platform
  const arch = process.arch
  const mem = process.memoryUsage()
  const info = [
    'OS: ' + os + ' ' + arch,
    'Node: ' + process.version,
    'Memory: ' + Math.round(mem.heapUsed/1024/1024) + 'MB / ' + Math.round(mem.heapTotal/1024/1024) + 'MB',
    'Uptime: ' + Math.round(process.uptime()) + 's',
  ].join('\n')
  return { success: true, output: info }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + 'B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB'
  return (bytes / 1024 / 1024).toFixed(1) + 'MB'
}

// ── read_files — читать несколько файлов за раз ──────────────────────────
export function readFiles(paths: string[]): ToolResult {
  const results: string[] = []
  for (const p of paths.slice(0, 10)) {
    if (!existsSync(p)) {
      results.push(`=== ${p} ===\n[Файл не найден]`)
      continue
    }
    try {
      const content = readFileSync(p, 'utf-8')
      const truncated = content.length > 6000
      results.push(`=== ${p} ===\n${content.slice(0, 6000)}${truncated ? '\n...[обрезано]' : ''}`)
    } catch (e: any) {
      results.push(`=== ${p} ===\n[Ошибка чтения: ${e.message}]`)
    }
  }
  return { success: true, output: results.join('\n\n') }
}

// ── search_code — поиск по коду (ripgrep/grep/Select-String) ─────────────

// Кэшируем путь к rg один раз
let rgBin: string | null | undefined = undefined
async function findRg(): Promise<string | null> {
  if (rgBin !== undefined) return rgBin
  try {
    const cmd = process.platform === 'win32' ? 'where rg' : 'which rg'
    const { stdout } = await execAsync(cmd, { timeout: 3000 })
    rgBin = stdout.trim().split('\n')[0].trim() || null
  } catch { rgBin = null }
  return rgBin
}

export async function searchCode(
  pattern: string,
  searchPath: string,
  opts?: { fileGlob?: string; ignoreCase?: boolean; maxResults?: number; context?: number; maxChars?: number }
): Promise<ToolResult> {
  const maxResults = opts?.maxResults ?? 50
  const contextLines = opts?.context ?? 2
  const maxChars = opts?.maxChars ?? 12000

  // Нормализуем путь — относительный → абсолютный
  const absPath = pathResolve(process.cwd(), searchPath)

  const ignoreGlobs = ['!node_modules', '!dist', '!out', '!.git', '!__pycache__', '!.venv', '!build', '!*.min.js', '!*.map']
  const ignoreFlag = ignoreGlobs.map(g => `--glob "${g}"`).join(' ')
  const caseFlag = opts?.ignoreCase ? '-i' : '-s'
  const globFlag = opts?.fileGlob ? `--glob "${opts.fileGlob}"` : ''

  const rg = await findRg()

  if (rg) {
    // Используем spawn-стиль через --json для надёжного парсинга на Windows
    // Но execAsync с правильным экранированием проще — используем одинарные кавычки внутри
    const escaped = pattern.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const cmd = `"${rg}" --line-number --no-heading ${caseFlag} ${globFlag} ${ignoreFlag} -C ${contextLines} -m ${maxResults} "${escaped}" "${absPath}"`
    try {
      const { stdout } = await execAsync(cmd, { timeout: 15000 })
      const out = formatRgOutput(stdout.trim(), maxResults)
      if (out) {
        const truncated = out.length > maxChars
        return { success: true, output: truncated ? out.slice(0, maxChars) + `\n...[обрезано, показано ${maxChars} из ${out.length} символов]` : out }
      }
      return { success: true, output: 'Совпадений не найдено' }
    } catch (e: any) {
      // rg exit code 1 = нет совпадений (не ошибка)
      if (e.code === 1) return { success: true, output: 'Совпадений не найдено' }
      // Реальная ошибка — логируем и идём дальше
      const rgErr = `[rg error: ${e.message?.slice(0, 100)}]`

      // Fallback PowerShell с пометкой
      const psResult = await searchCodePowerShell(pattern, absPath, opts)
      if (psResult.success) {
        return { success: true, output: `${rgErr}\n${psResult.output}` }
      }
      return psResult
    }
  }

  // rg не найден — сразу PowerShell
  return searchCodePowerShell(pattern, absPath, opts)
}

async function searchCodePowerShell(
  pattern: string,
  absPath: string,
  opts?: { fileGlob?: string; ignoreCase?: boolean; maxResults?: number; context?: number }
): Promise<ToolResult> {
  const maxResults = opts?.maxResults ?? 50
  const psPattern = pattern.replace(/'/g, "''").replace(/\\/g, '\\')
  const psGlob = opts?.fileGlob ?? '*.*'
  const psCase = opts?.ignoreCase ? '' : '-CaseSensitive'
  const context = opts?.context ?? 2

  const psCmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "` +
    `$r = Get-ChildItem -Path '${absPath}' -Recurse -Filter '${psGlob}' -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.FullName -notmatch 'node_modules|dist|out|\\.git|__pycache__|\\.venv|build' } | ` +
    `Select-String ${psCase} -Pattern '${psPattern}' -Context ${context},${context} -ErrorAction SilentlyContinue | ` +
    `Select-Object -First ${maxResults}; ` +
    `if ($r) { $r | ForEach-Object { $_.Filename + ':' + $_.LineNumber + ': ' + $_.Line.Trim() } } else { 'Совпадений не найдено' }"`
  try {
    const { stdout } = await execAsync(psCmd, { timeout: 25000 })
    return { success: true, output: stdout.trim() || 'Совпадений не найдено' }
  } catch (e: any) {
    return { success: false, output: '', error: 'search_code: ' + e.message }
  }
}

// Группирует вывод rg по файлам (поддерживает Windows пути C:\...)
function formatRgOutput(raw: string, max: number): string {
  if (!raw) return ''
  const lines = raw.split('\n').slice(0, max * 8)
  const files = new Map<string, string[]>()
  for (const line of lines) {
    if (line === '--') continue  // разделитель контекста
    // Windows: C:\path\file.ts:42:content — берём всё до последнего :digit:
    const m = line.match(/^(.+?):(\d+)[:-](.*)$/)
    if (m) {
      const [, file, lineNum, content] = m
      // Фикс Windows путей: если file = "C" и следующий символ был ":", восстанавливаем
      const realFile = file.length === 1 && /^[a-zA-Z]$/.test(file)
        ? line.match(/^([a-zA-Z]:[^:]+):(\d+)[:-](.*)$/)?.[1] ?? file
        : file
      if (!files.has(realFile)) files.set(realFile, [])
      files.get(realFile)!.push(`  ${lineNum}: ${content}`)
    } else if (line.trim()) {
      const last = Array.from(files.keys()).pop()
      if (last) files.get(last)!.push(`  ${line}`)
    }
  }
  const out: string[] = []
  files.forEach((fileLines, file) => {
    out.push(`\n● ${file}`)
    out.push(...fileLines.slice(0, 30))
    if (fileLines.length > 30) out.push(`  ... ещё ${fileLines.length - 30} строк`)
  })
  return out.join('\n').trim()
}

// ── analyze_project — полный анализ проекта ──────────────────────────────
export async function analyzeProject(projectPath: string): Promise<ToolResult> {
  if (!existsSync(projectPath)) {
    return { success: false, output: '', error: 'Папка не найдена: ' + projectPath }
  }

  const sections: string[] = []

  // 1. Базовая информация
  sections.push(`# Проект: ${projectPath}`)

  // 2. Дерево файлов (2 уровня, без node_modules/dist/etc)
  try {
    const treeCmd = process.platform === 'win32'
      ? `powershell -Command "Get-ChildItem -Path '${projectPath}' -Recurse -Depth 2 | Where-Object { $_.FullName -notmatch 'node_modules|dist|out|\\.git|\\.next|__pycache__|\\.venv' } | ForEach-Object { $_.FullName.Replace('${projectPath}', '') }"`
      : `find "${projectPath}" -maxdepth 3 -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/out/*" -not -path "*/__pycache__/*"`
    const { stdout: tree } = await execAsync(treeCmd, { timeout: 10000 })
    const lines = tree.trim().split('\n').slice(0, 80)
    sections.push(`## Структура файлов\n${lines.join('\n')}${lines.length >= 80 ? '\n...[обрезано]' : ''}`)
  } catch (e: any) {
    sections.push(`## Структура файлов\n[Ошибка: ${e.message}]`)
  }

  // 3. package.json если есть
  const pkgPath = join(projectPath, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      const info = {
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        scripts: Object.keys(pkg.scripts || {}),
        deps: Object.keys(pkg.dependencies || {}),
        devDeps: Object.keys(pkg.devDependencies || {}),
      }
      sections.push(`## package.json\n\`\`\`json\n${JSON.stringify(info, null, 2)}\n\`\`\``)
    } catch { /* ignore */ }
  }

  // 4. requirements.txt / pyproject.toml
  for (const f of ['requirements.txt', 'pyproject.toml', 'Cargo.toml', 'go.mod']) {
    const fp = join(projectPath, f)
    if (existsSync(fp)) {
      try {
        const content = readFileSync(fp, 'utf-8').slice(0, 1500)
        sections.push(`## ${f}\n\`\`\`\n${content}\n\`\`\``)
      } catch { /* ignore */ }
    }
  }

  // 5. README
  for (const f of ['README.md', 'README.txt', 'readme.md']) {
    const fp = join(projectPath, f)
    if (existsSync(fp)) {
      try {
        const content = readFileSync(fp, 'utf-8').slice(0, 2000)
        sections.push(`## README\n${content}`)
      } catch { /* ignore */ }
      break
    }
  }

  // 6. Git статус
  try {
    const { stdout: gitLog } = await execAsync(
      `git -C "${projectPath}" log --oneline -5 2>&1`,
      { timeout: 5000 }
    )
    const { stdout: gitStatus } = await execAsync(
      `git -C "${projectPath}" status --short 2>&1`,
      { timeout: 5000 }
    )
    const { stdout: gitBranch } = await execAsync(
      `git -C "${projectPath}" branch --show-current 2>&1`,
      { timeout: 5000 }
    )
    sections.push(`## Git\nВетка: ${gitBranch.trim()}\n\nПоследние коммиты:\n${gitLog.trim()}\n\nИзменения:\n${gitStatus.trim() || 'Нет изменений'}`)
  } catch { /* ignore — не git репо */ }

  // 7. Статистика кода
  try {
    const extCount: Record<string, number> = {}
    const countFiles = (dir: string, depth = 0) => {
      if (depth > 4) return
      for (const name of readdirSync(dir)) {
        if (['node_modules', 'dist', 'out', '.git', '__pycache__', '.venv', 'build'].includes(name)) continue
        const full = join(dir, name)
        try {
          const s = statSync(full)
          if (s.isDirectory()) countFiles(full, depth + 1)
          else {
            const ext = name.includes('.') ? '.' + name.split('.').pop()! : 'other'
            extCount[ext] = (extCount[ext] || 0) + 1
          }
        } catch { /* ignore */ }
      }
    }
    countFiles(projectPath)
    const sorted = Object.entries(extCount).sort((a, b) => b[1] - a[1]).slice(0, 12)
    sections.push(`## Статистика файлов\n${sorted.map(([ext, n]) => `${ext}: ${n} файл(ов)`).join('\n')}`)
  } catch { /* ignore */ }

  return { success: true, output: sections.join('\n\n') }
}

export async function generateImage(
  args: {
    prompt: string
    model?: string
    size?: string
    quality?: string
    style?: string
  },
  store: Store
): Promise<ToolResult> {
  const providers = store.get('providers', []) as Provider[]
  const imageProviderId = store.get('imageProviderId', '') as string
  const imageModelId = store.get('imageModelId', '') as string

  console.log('[generateImage] imageProviderId=', imageProviderId, 'imageModelId=', imageModelId, 'providers count=', (providers as unknown[]).length)
  console.log('[generateImage] known provider ids=', (providers as Provider[]).map(p => p.id))

  let provider: Provider | undefined

  if (imageProviderId) {
    // Сначала точное совпадение по id
    provider = providers.find(p => p.id === imageProviderId)
    // Если не нашли — ищем по частичному совпадению (кастомные провайдеры могут иметь суффикс)
    if (!provider) {
      provider = providers.find(p => p.id.includes(imageProviderId) || imageProviderId.includes(p.id))
    }
    console.log('[generateImage] found provider:', provider?.id ?? 'NOT FOUND')
  }

  if (!provider) {
    // Последний шанс — первый enabled с ключом
    provider = providers.find(p => p.enabled && (p.apiKey || (p.apiKeys && p.apiKeys.length > 0)))
    if (provider) {
      console.log('[generateImage] fallback to first enabled provider:', provider.id)
    }
  }

  if (!provider) {
    return {
      success: false, output: '',
      error: 'Не настроена модель генерации изображений. Зайдите в Настройки → AI → Модели → Генерация изображений и выберите модель.'
    }
  }

  const apiKey = provider.apiKeys?.find(k => k.trim()) || provider.apiKey || ''
  if (!apiKey) return { success: false, output: '', error: 'API ключ провайдера не задан' }

  // OnlySQ ImaGen — отдельный нестандартный API (не OpenAI совместимый)
  if (provider.id === 'onlysq') {
    try {
      // Конвертируем size (1024x1024) → ratio (1:1) или берём напрямую если уже ratio
      const sizeRaw = args.size as string | undefined
      let ratio = '1:1'
      if (sizeRaw) {
        if (sizeRaw.includes(':')) {
          ratio = sizeRaw // уже в формате ratio
        } else {
          // конвертация из WxH
          const sizeMap: Record<string, string> = {
            '1024x1024': '1:1', '1792x1024': '16:9', '1024x1792': '9:16',
            '1216x832': '3:2',  '832x1216': '2:3',   '1344x768': '16:9',
            '768x1344': '9:16', '1152x896': '4:3',   '896x1152': '3:4',
          }
          ratio = sizeMap[sizeRaw] || '1:1'
        }
      }

      const resp = await fetch('https://api.onlysq.ru/ai/imagen', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: imageModelId || 'flux', prompt: args.prompt, ratio }),
      })

      if (!resp.ok) {
        const text = await resp.text()
        return { success: false, output: '', error: `OnlySQ ImaGen error ${resp.status}: ${text}` }
      }

      const data = await resp.json() as { files?: string[]; id?: string }
      if (!data.files || data.files.length === 0) {
        return { success: false, output: '', error: 'OnlySQ вернул пустой ответ без изображений' }
      }

      const b64 = data.files[0]
      // Сохраняем в temp файл — не кидаем base64 в контекст AI
      const imgDir = join(tmpdir(), 'syntee-generated')
      if (!existsSync(imgDir)) mkdirSync(imgDir, { recursive: true })
      const imgPath = join(imgDir, `img_${Date.now()}.png`)
      writeFileSync(imgPath, Buffer.from(b64, 'base64'))
      return {
        success: true,
        output: `[IMAGE:${imgPath}]`,
        error: undefined,
      }
    } catch (e: unknown) {
      return { success: false, output: '', error: e instanceof Error ? e.message : String(e) }
    }
  }

  // Стандартный OpenAI-совместимый путь для остальных провайдеров
  try {
    const client = new OpenAI({ apiKey, baseURL: provider.baseUrl })
    const model = args.model || imageModelId
    const size = (args.size || store.get('imageDefaultSize', '1024x1024') as string) as Parameters<typeof client.images.generate>[0]['size']
    const quality = (args.quality || store.get('imageDefaultQuality', 'standard') as string) as Parameters<typeof client.images.generate>[0]['quality']
    const style = args.style as Parameters<typeof client.images.generate>[0]['style']

    const response = await client.images.generate({
      model, prompt: args.prompt, n: 1, size, quality, style,
      response_format: 'url',
    })

    const img = response.data[0]
    const url = img.url || ''
    const revised = img.revised_prompt ? `\nRevised prompt: ${img.revised_prompt}` : ''
    return { success: true, output: `![Generated Image](${url})${revised}\n\nURL: ${url}` }
  } catch (e: unknown) {
    return { success: false, output: '', error: e instanceof Error ? e.message : String(e) }
  }
}

// ── save_plan — только в режиме планирования ─────────────────────────────────
export function savePlan(params: { title: string; content: string; summary: string }): ToolResult {
  try {
    const os = require('os')
    const fs = require('fs')
    const path = require('path')
    const plansDir = path.join(os.homedir(), 'Documents', 'Syntee', 'Plans')
    fs.mkdirSync(plansDir, { recursive: true })
    // Санитизируем имя файла
    const safeName = params.title
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/\s+/g, '_')
      .slice(0, 80) || 'plan'
    const filePath = path.join(plansDir, `plan_${safeName}.md`)
    const fullContent = `# ${params.title}\n\n> ${params.summary}\n\n${params.content}`
    fs.writeFileSync(filePath, fullContent, 'utf-8')
    return { success: true, output: filePath }
  } catch (e: unknown) {
    return { success: false, output: '', error: String(e) }
  }
}

const PLAN_TOOL_SCHEMA = {
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

export const TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'edit_file',
      description: 'Редактировать файл. replace — заменить фрагмент (с fuzzy по отступам), insert — вставить после строки, overwrite — перезаписать. create_if_not_exists=true создаёт файл и директории. Возвращает diff.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь к файлу' },
          mode: { type: 'string', enum: ['replace', 'insert', 'overwrite'], description: 'Режим редактирования' },
          old_str: { type: 'string', description: '[replace] Уникальный фрагмент для замены. Включай 2-3 строки контекста.' },
          new_str: { type: 'string', description: '[replace] Новый фрагмент (пустая строка = удалить)' },
          after_line: { type: 'number', description: '[insert] Вставить после этой строки (1-indexed)' },
          content: { type: 'string', description: '[insert/overwrite] Контент для вставки или перезаписи' },
          create_if_not_exists: { type: 'boolean', description: 'Создать файл (и директории) если не существует' },
        },
        required: ['path', 'mode'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'multi_edit_file',
      description: 'Несколько замен в одном файле за один вызов. Используй когда нужно изменить 2+ независимых места в файле.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь к файлу' },
          edits: {
            type: 'array',
            description: 'Список замен — применяются последовательно',
            items: {
              type: 'object',
              properties: {
                old_str: { type: 'string', description: 'Уникальный фрагмент для замены' },
                new_str: { type: 'string', description: 'Новый фрагмент' },
              },
              required: ['old_str', 'new_str'],
            },
          },
        },
        required: ['path', 'edits'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description: 'Выполнить команду в терминале. Windows: PowerShell по умолчанию (ls/cat/rm/Get-Process/$env:PATH и т.д.), cmd — через shell:"cmd". Linux/Mac: bash. Указывай cwd для проектов, timeout для долгих операций.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Команда' },
          cwd: { type: 'string', description: 'Рабочая директория' },
          shell: { type: 'string', enum: ['powershell', 'cmd'], description: 'Шелл (только Windows, по умолч. powershell)' },
          timeout: { type: 'number', description: 'Таймаут в секундах (по умолч. 60)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Читает файл. Без offset — первые 100 строк + авто-outline структуры если файл > 100 строк. С offset/limit — точный диапазон строк. Всегда показывает [total_lines] и подсказку если файл обрезан.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Абсолютный путь к файлу' },
          offset: { type: 'number', description: 'Начальная строка (1-indexed). Для чтения по частям.' },
          limit: { type: 'number', description: 'Кол-во строк (по умолч. 200). Увеличь до 500 если нужно больше.' },
          outline_only: { type: 'boolean', description: 'true — вернуть только структуру файла (функции, классы, экспорты) без содержимого. Удобно чтобы сориентироваться в большом файле.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'ПОЛНАЯ ПЕРЕЗАПИСЬ файла целиком. Для изменений в существующем файле используй edit_file (mode=replace или overwrite) — он безопаснее и возвращает diff. write_file только для создания нового файла с нуля или полного замены содержимого. Возвращает diff.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь к файлу' },
          content: { type: 'string', description: 'Содержимое файла' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_directory',
      description: 'Показать содержимое папки в виде дерева. recursive=true обходит вложенные папки (depth по умолч. 3). Игнорирует node_modules/dist/.git.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь к папке' },
          recursive: { type: 'boolean', description: 'Рекурсивный обход (по умолч. false)' },
          depth: { type: 'number', description: 'Глубина рекурсии (по умолч. 3)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_clipboard',
      description: 'Получить текст из буфера обмена.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_clipboard',
      description: 'Скопировать текст в буфер обмена.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Текст для копирования' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_web',
      description: 'Поиск в интернете. Используй для актуальной информации.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Поисковый запрос' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_system_info',
      description: 'Получить информацию о системе (OS, память, uptime).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'generate_image',
      description: 'Сгенерировать изображение по текстовому описанию. Используй когда пользователь просит нарисовать, создать или сгенерировать изображение/картинку.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Детальное описание изображения на английском языке для лучшего качества' },
          model: { type: 'string', description: 'Модель генерации (опционально). Например: dall-e-3, dall-e-2, gpt-image-1' },
          size: { type: 'string', description: 'Размер изображения (опционально). Например: 1024x1024, 1792x1024, 1024x1792' },
          quality: { type: 'string', description: 'Качество: standard, hd (dall-e-3) или low, medium, high (gpt-image-1)' },
          style: { type: 'string', description: 'Стиль (только dall-e-3): vivid или natural' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_files',
      description: 'Прочитать несколько файлов за один раз. Используй вместо read_file когда нужно посмотреть сразу несколько файлов проекта.',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Список абсолютных путей к файлам (до 10 штук)',
          },
        },
        required: ['paths'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_code',
      description: 'Поиск по коду: regex или текст в файлах. Использует ripgrep (быстро) или PowerShell. Игнорирует node_modules/dist/.git. Возвращает файлы + номера строк + контекст. ВАЖНО: path должен быть абсолютным (C:\\Projects\\... или /c/Projects/...).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex или строка. Пример: "useState", "import.*axios", "class\\s+User"' },
          path: { type: 'string', description: 'Директория или файл для поиска' },
          file_glob: { type: 'string', description: 'Фильтр файлов: "*.ts", "*.py", "*.{ts,tsx}"' },
          ignore_case: { type: 'boolean', description: 'Без учёта регистра (по умолч. false)' },
          max_results: { type: 'number', description: 'Макс. совпадений (по умолч. 50)' },
          context: { type: 'number', description: 'Строк контекста вокруг совпадения (по умолч. 2)' },
        },
        required: ['pattern', 'path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'analyze_project',
      description: 'Полный анализ проекта — структура файлов, зависимости, git статус, статистика. Вызывай в начале работы с незнакомым проектом.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Абсолютный путь к корню проекта' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'find_files',
      description: 'Найти файлы по имени или regex-паттерну. Используй когда нужно найти файл по имени: "где ChatPage.tsx?", "найди все *.config.ts". Игнорирует node_modules/dist/.git.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Имя файла, glob (*.tsx) или regex. Пример: "ChatPage.tsx", "*.config.ts", "index\\.(ts|tsx)"' },
          path: { type: 'string', description: 'Директория для поиска' },
          max_results: { type: 'number', description: 'Макс. результатов (по умолч. 50)' },
        },
        required: ['pattern', 'path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'spawn_agent',
      description: 'Запустить суб-агента для выполнения подзадачи. Используй когда задачу лучше делегировать — параллельно или последовательно.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Подробное описание задачи для суб-агента' },
          parallel: { type: 'boolean', description: 'true — запустить параллельно (не ждать результата), false — ждать завершения и получить итог' },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_agent_status',
      description: 'Проверить статус суб-агента — активен ли, что сейчас делает, сколько шагов выполнил. Используй когда запустил агента параллельно и хочешь узнать прогресс.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'ID суб-агента из [AGENT:id] маркера' },
        },
        required: ['agent_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'think',
      description: 'Внутренний монолог — используй ПЕРЕД сложными действиями. Напиши план: что нужно сделать, в каком порядке, какие файлы прочитать, какие риски. Результат не виден пользователю — только тебе. Не тратит его токены.',
      parameters: {
        type: 'object',
        properties: {
          thought: {
            type: 'string',
            description: 'Твои рассуждения, план действий, анализ ситуации.',
          },
        },
        required: ['thought'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_working_memory',
      description: 'Обновляет рабочую память чата — заметки о проекте, сделанных изменениях, текущем состоянии. Вызывай в конце сессии чтобы запомнить важное для следующих сообщений. Максимум ~2000 токенов.',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'Новое содержимое рабочей памяти. Полностью заменяет старое. Пиши компактно: что сделано, текущее состояние, важные факты о проекте.',
          },
          mode: {
            type: 'string',
            enum: ['replace', 'append'],
            description: 'replace — полная замена (по умолчанию), append — добавить к существующему.',
          },
        },
        required: ['content'],
      },
    },
  },
]

// Динамический набор тулов — добавляем по режиму
const TOOL_BY_NAME = new Map(
  TOOL_SCHEMAS.map(schema => [schema.function.name, schema]),
)

function pickTools(names: string[]) {
  return names
    .map(name => TOOL_BY_NAME.get(name))
    .filter(Boolean)
}

export function getToolSchemas(options: {
  planningMode?: boolean
  webMode?: boolean
  imageMode?: boolean
  multiAgentMode?: boolean
} = {}) {
  const {
    planningMode = false,
    webMode = false,
    imageMode = false,
    multiAgentMode = false,
  } = options

  const names = [
    'read_file',
    'read_files',
    'find_files',
    'search_code',
    'list_directory',
    'get_file_outline',
    'edit_file',
    'multi_edit_file',
    'write_file',
    'run_command',
    'think',
    'update_working_memory',
  ]

  if (!planningMode) names.push('analyze_project')
  if (webMode) names.push('search_web')
  if (imageMode) names.push('generate_image')
  if (multiAgentMode) names.push('spawn_agent', 'get_agent_status')

  const schemas = pickTools(names)
  if (planningMode) schemas.push(PLAN_TOOL_SCHEMA as any)
  return schemas
}
