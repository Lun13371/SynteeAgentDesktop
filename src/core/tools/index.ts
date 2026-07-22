import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { readFile as fsReadFile, writeFile as fsWriteFile, readdir as fsReaddir, stat as fsStat, mkdir as fsMkdir, open as fsOpen } from 'fs/promises'
import { tmpdir, homedir } from 'os'
import { join, dirname, resolve as pathResolve } from 'path'
import OpenAI from 'openai'
import type Store from 'electron-store'
import type { Provider } from '../../shared/types'
import * as Diff from 'diff'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

// ── Общие хелперы (дедуплицированы из多处) ───────────────────────────────

// Единый список игнорируемых директорий для list_directory/find_files/search_code/analyze_project
const DEFAULT_IGNORE_DIRS = ['node_modules', 'dist', 'out', '.git', '__pycache__', '.venv', 'build', '.next', 'coverage']

// Нормализация CRLF→LF (используется в edit_file/applySearchReplacePatch)
function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, '\n')
}

// Создаёт родительскую директорию для файла, если её нет
async function ensureDirFor(filePath: string): Promise<void> {
  const dir = dirname(filePath)
  if (!existsSync(dir)) await fsMkdir(dir, { recursive: true })
}

// Подсчёт изменённых строк в unified diff
function countChangedLines(diff: string): number {
  return diff.split('\n').filter((l: string) => l.startsWith('+') || l.startsWith('-')).length
}

// Детекция бинарного файла: проверяем первые 8KB на наличие null-байтов.
// Если есть — файл бинарный, текстовое чтение бессмысленно.
// Используем FileHandle API правильно: fsOpen возвращает FileHandle,
// у которого есть методы .read() и .close() — а не fsPromises.close(fd),
// которого в некоторых версиях Node нет (отсюда "promises.close is not a function").
async function isBinaryFile(filePath: string): Promise<boolean> {
  let handle: { read: (buf: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>; close: () => Promise<void> } | undefined
  try {
    handle = await fsOpen(filePath, 'r') as unknown as { read: (buf: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>; close: () => Promise<void> }
    const buf = Buffer.alloc(8192)
    const { bytesRead } = await handle.read(buf, 0, 8192, 0)
    return buf.slice(0, bytesRead).includes(0)
  } catch {
    return false  // если не можем открыть — пусть чтение выдаст свою ошибку
  } finally {
    if (handle) await handle.close()
  }
}

// Единая резолюция путей: относительные пути резолвятся через workdir
// (если задан) или process.cwd() (для обратной совместимости — старые чаты
// без workdir, Work-режим, вызовы вне контекста чата), абсолютные остаются как есть.
// Применяется во всех файловых тулах для единообразия.
function resolveToolPath(p: string, workdir?: string): string {
  return pathResolve(workdir ?? process.cwd(), p)
}

export interface ToolResult {
  success: boolean
  output: string
  error?: string
  diff?: string
  hidden?: boolean  // скрытые тулы (think, update_working_memory) — не показываются в UI
  originalContent?: string | null  // §1.8 — для undo/rollback: содержимое до записи; null = файл был создан
}

export async function runCommand(cmd: string, cwd?: string, shell?: string, timeout?: number): Promise<ToolResult> {
  try {
    const isWin = process.platform === 'win32'
    const timeoutMs = (timeout || 60) * 1000
    const maxBuffer = 10 * 1024 * 1024  // 10MB — иначе Node падает с ERR_CHILD_PROCESS_STDOUT_MAXBUFFER до smartTrimOutput

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
          maxBuffer,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        }
      } else {
        // PowerShell: используем -EncodedCommand (base64 UTF-16LE) вместо
        // встраивания команды в двойные кавычки. Это полностью устраняет
        // проблему экранирования (", $(), backtick и т.д.) — команда передаётся
        // как данные, а не как часть shell-строки.
        const psScript = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${cmd}`
        const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
        execCmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
        execOpts = {
          cwd: cwd || homedir(),
          timeout: timeoutMs,
          encoding: 'utf8',
          maxBuffer,
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
        maxBuffer,
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

// ── get_diagnostics — tsc --noEmit (оба проекта) + eslint --format json ──
interface DiagnosticEntry {
  file: string
  line: number
  col?: number
  severity: 'error' | 'warning'
  message: string
  source: 'tsc' | 'eslint'
}

// Формат tsc: "C:\path\file.ts(12,5): error TS2322: Type 'X' is not assignable..."
const TSC_LINE_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.+)$/

function parseTscOutput(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const line of stdout.split('\n')) {
    const m = line.match(TSC_LINE_RE)
    if (!m) continue
    const [, file, lineNum, col, severity, code, message] = m
    entries.push({
      file: file.trim(),
      line: Number(lineNum),
      col: Number(col),
      severity: severity as 'error' | 'warning',
      message: `${code}: ${message.trim()}`,
      source: 'tsc',
    })
  }
  return entries
}

interface EslintJsonMessage {
  line: number
  column: number
  severity: 1 | 2
  message: string
  ruleId?: string | null
}
interface EslintJsonFile {
  filePath: string
  messages: EslintJsonMessage[]
}

function parseEslintOutput(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  let parsed: EslintJsonFile[]
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return entries
  }
  for (const file of parsed) {
    for (const msg of file.messages) {
      entries.push({
        file: file.filePath,
        line: msg.line,
        col: msg.column,
        severity: msg.severity === 2 ? 'error' : 'warning',
        message: msg.ruleId ? `${msg.ruleId}: ${msg.message}` : msg.message,
        source: 'eslint',
      })
    }
  }
  return entries
}

async function runDiagnosticCommand(cmd: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
      encoding: 'utf8',
    })
    return { stdout: stdout as string, stderr: stderr as string }
  } catch (e: any) {
    // tsc/eslint возвращают ненулевой exit code когда находят ошибки —
    // это не сбой выполнения команды, а нормальный результат.
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

export async function getDiagnostics(cwd?: string): Promise<ToolResult> {
  const dir = cwd || process.cwd()
  if (!existsSync(dir)) return { success: false, output: '', error: 'Директория не найдена: ' + dir }

  const allEntries: DiagnosticEntry[] = []
  const notes: string[] = []

  const nodeTsconfig = join(dir, 'tsconfig.node.json')
  const webTsconfig = join(dir, 'tsconfig.web.json')
  const rootTsconfig = join(dir, 'tsconfig.json')

  if (existsSync(nodeTsconfig) && existsSync(webTsconfig)) {
    const [nodeRes, webRes] = await Promise.all([
      runDiagnosticCommand('npx tsc -p tsconfig.node.json --noEmit', dir),
      runDiagnosticCommand('npx tsc -p tsconfig.web.json --noEmit', dir),
    ])
    allEntries.push(...parseTscOutput(nodeRes.stdout + '\n' + nodeRes.stderr))
    allEntries.push(...parseTscOutput(webRes.stdout + '\n' + webRes.stderr))
  } else if (existsSync(rootTsconfig)) {
    const res = await runDiagnosticCommand('npx tsc -p tsconfig.json --noEmit', dir)
    allEntries.push(...parseTscOutput(res.stdout + '\n' + res.stderr))
  } else {
    notes.push('tsconfig не найден — TypeScript проверка пропущена')
  }

  const eslintConfigCandidates = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts']
  if (eslintConfigCandidates.some(f => existsSync(join(dir, f)))) {
    const res = await runDiagnosticCommand('npx eslint . --format json', dir)
    allEntries.push(...parseEslintOutput(res.stdout))
  } else {
    notes.push('eslint.config не найден — линт пропущен')
  }

  allEntries.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)

  const errorCount = allEntries.filter(e => e.severity === 'error').length
  const warningCount = allEntries.filter(e => e.severity === 'warning').length

  if (allEntries.length === 0) {
    const okMsg = notes.length ? `Ошибок не найдено.\n${notes.join('\n')}` : 'Ошибок не найдено. Проект компилируется и линтится чисто.'
    return { success: true, output: okMsg }
  }

  const lines = allEntries.map(e => `[${e.source}] ${e.severity === 'error' ? 'ERROR' : 'WARN'} ${e.file}:${e.line}${e.col ? ':' + e.col : ''} — ${e.message}`)
  const header = `Найдено ${errorCount} ошибок, ${warningCount} предупреждений:`
  const body = smartTrimOutput([header, ...notes, ...lines].join('\n'), 8000)
  return { success: errorCount === 0, output: body }
}

// Умная обрезка вывода команды — показываем начало (контекст) и конец (результат/ошибки)
export function smartTrimOutput(text: string, maxChars = 4000): string {
  if (!text || text.length <= maxChars) return text
  const head = 800   // начало — контекст команды
  const tail = 2000  // конец — результат и ошибки (самое важное)
  const removed = text.length - head - tail
  return `${text.slice(0, head)}\n\n...[обрезано ${removed} символов, показано начало и конец]...\n\n${text.slice(-tail)}`
}

const MAX_READ_FILE_SIZE = 20 * 1024 * 1024  // 20MB — больше не читаем целиком

export async function readFile(path: string, offset?: number, limit?: number, outlineOnly?: boolean, workdir?: string): Promise<ToolResult> {
  try {
    path = resolveToolPath(path, workdir)
    if (!existsSync(path)) return { success: false, output: '', error: 'Файл не найден: ' + path }
    // Проверяем размер — не читаем огромные файлы целиком в память
    const fileStat = await fsStat(path)
    if (fileStat.size > MAX_READ_FILE_SIZE) {
      return { success: false, output: '', error: `Файл слишком большой (${formatSize(fileStat.size)}). Используйте offset/limit для чтения по частям или run_command для просмотра.` }
    }
    if (await isBinaryFile(path)) return { success: false, output: '', error: 'Файл выглядит как бинарный, текстовое чтение не поддерживается: ' + path }
    const content = await fsReadFile(path, 'utf-8')
    const lines = content.split('\n')
    const totalLines = lines.length

    // outline_only — возвращаем только структуру файла
    if (outlineOnly) {
      const outlineResult = await getFileOutline(path)
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
        const outlineResult = await getFileOutline(path)
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

export async function writeFile(path: string, content: string, opts?: { dryRun?: boolean; workdir?: string }): Promise<ToolResult> {
  try {
    path = resolveToolPath(path, opts?.workdir)
    await ensureDirFor(path)
    // Читаем оригинал для diff (если файл существует). originalContent = null
    // сигнализирует снапшот-системе что файл был СОЗДАН (→ unlink при rewind),
    // а не перезаписан пустым содержимым.
    let original = ''
    let originalContent: string | null = null
    const fileExists = existsSync(path)
    if (fileExists) {
      try { original = await fsReadFile(path, 'utf-8'); originalContent = original } catch { /* ok */ }
    }
    // dryRun — не записываем, только возвращаем diff-превью
    if (opts?.dryRun) {
      const diff = makeDiff(original, content, path)
      const action = fileExists ? 'ПЕРЕЗАПИСЬ существующего файла' : 'СОЗДАНИЕ нового файла'
      return { success: true, output: `[DRY RUN] ${action}: ${path}\n${diff}`.slice(0, 4000), diff }
    }
    await fsWriteFile(path, content, 'utf-8')
    const lines = content.split('\n').length
    // Генерируем diff как у edit_file
    const diff = makeDiff(original, content, path)
    const changedLines = countChangedLines(diff)
    return { success: true, output: `Файл записан: ${path} (${lines} строк, ${changedLines} строк изменено)`, diff, originalContent }
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

// §3.2 — Парсер search/replace patch формата (Codex-style).
// Формат: один или несколько блоков, разделённых маркерами:
//   <<<<<<< SEARCH
//   <точный текст для поиска>
//   =======
//   <новый текст>
//   >>>>>>> REPLACE
// Каждый блок заменяет ровно одно вхождение. Если SEARCH не найден — ошибка.
function applySearchReplacePatch(original: string, patch: string): string {
  const SEARCH_START = '<<<<<<< SEARCH'
  const SEPARATOR = '======='
  const REPLACE_END = '>>>>>>> REPLACE'

  const lines = patch.split('\n')
  let result = original
  let i = 0
  const errors: string[] = []

  while (i < lines.length) {
    // Ищем начало блока SEARCH
    const searchStartIdx = lines.indexOf(SEARCH_START, i)
    if (searchStartIdx === -1) break

    const sepIdx = lines.indexOf(SEPARATOR, searchStartIdx + 1)
    if (sepIdx === -1) {
      errors.push('Найден SEARCH без ======= сепаратора')
      break
    }

    const replaceEndIdx = lines.indexOf(REPLACE_END, sepIdx + 1)
    if (replaceEndIdx === -1) {
      errors.push('Найден SEARCH/SEPARATOR без >>>>>>> REPLACE')
      break
    }

    const searchText = lines.slice(searchStartIdx + 1, sepIdx).join('\n')
    const replaceText = lines.slice(sepIdx + 1, replaceEndIdx).join('\n')

    if (!searchText) {
      errors.push(`Пустой SEARCH в блоке ${searchStartIdx + 1}`)
      i = replaceEndIdx + 1
      continue
    }

    // Нормализуем CRLF → LF для сравнения
    const normResult = normalizeLineEndings(result)
    const normSearch = normalizeLineEndings(searchText)

    if (!normResult.includes(normSearch)) {
      errors.push(`SEARCH не найден (строки ${searchStartIdx + 2}-${sepIdx}): "${searchText.slice(0, 80)}..."`)
      i = replaceEndIdx + 1
      continue
    }

    // Заменяем только первое вхождение
    result = normResult.replace(normSearch, replaceText)
    i = replaceEndIdx + 1
  }

  if (errors.length > 0) {
    throw new Error(`apply_patch ошибки (${errors.length}):\n${errors.join('\n')}`)
  }

  return result
}

export async function editFile(params: {
  path: string
  mode: 'replace' | 'insert' | 'overwrite' | 'apply_patch'
  old_str?: string
  new_str?: string
  after_line?: number
  content?: string
  create_if_not_exists?: boolean
  dryRun?: boolean
  patch?: string
  workdir?: string
}): Promise<EditResult> {
  try {
    params.path = resolveToolPath(params.path, params.workdir)
    const fileExists = existsSync(params.path)

    // create_if_not_exists — создать файл если не существует (только overwrite/insert)
    if (!fileExists) {
      if (params.create_if_not_exists) {
        if (params.dryRun) {
          const initial = params.content ?? params.new_str ?? ''
          return { success: true, output: `[DRY RUN] СОЗДАНИЕ нового файла: ${params.path}\n${initial.split('\n').map(l => '+' + l).join('\n')}`.slice(0, 4000), diff: `+++ ${params.path}\n${initial.split('\n').map(l => '+' + l).join('\n')}` }
        }
        await ensureDirFor(params.path)
        const initial = params.content ?? params.new_str ?? ''
        await fsWriteFile(params.path, initial, 'utf-8')
        return { success: true, output: `Файл создан: ${params.path}`, diff: `+++ ${params.path}\n${initial.split('\n').map(l => '+' + l).join('\n')}` }
      }
      return { success: false, output: '', error: 'Файл не найден: ' + params.path }
    }

    const original = await fsReadFile(params.path, 'utf-8')
    let updated = original

    if (params.mode === 'apply_patch') {
      // §3.2 — Codex-style apply_patch: надёжная замена по точным ханкам.
      // patch содержит серию "*** [file]" / "--- old" / "+++ new" блоков или
      // просто пары old_str→new_str разделённые маркерами.
      // Поддерживаем упрощённый формат: блоки вида:
      //   <<<<<<< SEARCH
      //   точный текст для поиска
      //   =======
      //   новый текст
      //   >>>>>>> REPLACE
      if (!params.patch) return { success: false, output: '', error: 'edit_file apply_patch: нужен patch' }
      updated = applySearchReplacePatch(original, params.patch)
    } else if (params.mode === 'replace') {
      if (!params.old_str) return { success: false, output: '', error: 'edit_file replace: нужен old_str' }
      // Нормализуем CRLF → LF для сравнения
      const normOrig = normalizeLineEndings(original)
      const normOld = normalizeLineEndings(params.old_str)
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

    const diff = makeDiff(original, updated, params.path)
    // dryRun — не записываем, только diff-превью
    if (params.dryRun) {
      const changedLines = countChangedLines(diff)
      return { success: true, output: `[DRY RUN] Правка ${params.mode} для: ${params.path} (${changedLines} строк изменено)\n${diff}`.slice(0, 4000), diff }
    }
    await fsWriteFile(params.path, updated, 'utf-8')
    const changedLines2 = countChangedLines(diff)
    return { success: true, output: `Файл обновлён: ${params.path} (${changedLines2} строк изменено)`, diff, originalContent: original }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}

export async function multiEditFile(params: {
  path: string
  edits: Array<{ old_str: string; new_str: string }>
  dryRun?: boolean
  workdir?: string
}): Promise<EditResult> {
  try {
    params.path = resolveToolPath(params.path, params.workdir)
    if (!existsSync(params.path)) return { success: false, output: '', error: 'Файл не найден: ' + params.path }
    const original = await fsReadFile(params.path, 'utf-8')
    let updated = original
    const failed: string[] = []

    for (const edit of params.edits) {
      if (updated.includes(edit.old_str)) {
        updated = updated.replace(edit.old_str, edit.new_str)
      } else {
        failed.push(edit.old_str.slice(0, 60) + '…')
      }
    }

    const diff = makeDiff(original, updated, params.path)
    const changedLines = countChangedLines(diff)
    const warn = failed.length ? `\nНе найдено ${failed.length} фрагментов: ${failed.join('; ')}` : ''
    // dryRun — не записываем
    if (params.dryRun) {
      return { success: true, output: `[DRY RUN] Мульти-правка для: ${params.path} (${changedLines} строк изменено)${warn}\n${diff}`.slice(0, 4000), diff }
    }
    await fsWriteFile(params.path, updated, 'utf-8')
    return { success: true, output: `Файл обновлён: ${params.path} (${changedLines} строк изменено)${warn}`, diff, originalContent: original }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}

export async function listDirectory(path: string, opts?: { recursive?: boolean; depth?: number; ignore?: string[]; workdir?: string }): Promise<ToolResult> {
  try {
    path = resolveToolPath(path, opts?.workdir)
    if (!existsSync(path)) return { success: false, output: '', error: 'Папка не найдена: ' + path }
    const maxDepth = opts?.depth ?? (opts?.recursive ? 3 : 0)
    const ignore = [...DEFAULT_IGNORE_DIRS, ...(opts?.ignore ?? [])]
    const lines: string[] = []

    const walk = async (dir: string, level: number, prefix: string): Promise<void> => {
      if (level > maxDepth) return
      let entries: string[]
      try { entries = await fsReaddir(dir) } catch { return }
      // Сортировка: директории первыми
      const entryInfos = await Promise.all(entries.map(async (name) => {
        let isDir = false, size = 0
        try { const s = await fsStat(join(dir, name)); isDir = s.isDirectory(); size = s.size } catch { /* skip */ }
        return { name, isDir, size }
      }))
      entryInfos.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      for (let i = 0; i < entryInfos.length; i++) {
        const { name, isDir, size } = entryInfos[i]
        if (ignore.includes(name)) continue
        const full = join(dir, name)
        const isLast = i === entryInfos.length - 1 || entryInfos.slice(i + 1).every(n => ignore.includes(n.name))
        const connector = isLast ? '└── ' : '├── '
        const sizeStr = isDir ? '' : ` (${formatSize(size)})`
        lines.push(`${prefix}${connector}${name}${isDir ? '/' : sizeStr}`)
        if (isDir && level < maxDepth) {
          await walk(full, level + 1, prefix + (isLast ? '    ' : '│   '))
        }
      }
    }

    lines.push(path + '/')
    await walk(path, 0, '')
    if (lines.length > 300) {
      return { success: true, output: lines.slice(0, 300).join('\n') + `\n...[обрезано, показано 300 из ${lines.length} записей]` }
    }
    return { success: true, output: lines.join('\n') }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}

// ── find_files — поиск файлов по имени/паттерну ───────────────────────────
export async function findFiles(pattern: string, searchPath: string, opts?: { maxResults?: number; workdir?: string }): Promise<ToolResult> {
  const maxResults = opts?.maxResults ?? 50
  searchPath = resolveToolPath(searchPath, opts?.workdir)
  const results: string[] = []
  const rx = (() => {
    try { return new RegExp(pattern, 'i') } catch {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
      return new RegExp(escaped, 'i')
    }
  })()
  const walk = async (dir: string): Promise<void> => {
    if (results.length >= maxResults) return
    let entries: string[]
    try { entries = await fsReaddir(dir) } catch { return }
    for (const name of entries) {
      if (DEFAULT_IGNORE_DIRS.includes(name)) continue
      const full = join(dir, name)
      let stat; try { stat = await fsStat(full) } catch { continue }
      if (stat.isDirectory()) await walk(full)
      else if (rx.test(name)) { results.push(full); if (results.length >= maxResults) return }
    }
  }
  if (!existsSync(searchPath)) return { success: false, output: '', error: 'Путь не найден: ' + searchPath }
  await walk(searchPath)
  if (results.length === 0) return { success: true, output: 'Файлов не найдено' }
  return { success: true, output: results.join('\n') + (results.length >= maxResults ? `\n...[показано ${maxResults}, есть ещё]` : `\n[Найдено: ${results.length}]`) }
}

// ── get_file_outline — структура файла (функции/классы/экспорты) ──────────
export async function getFileOutline(filePath: string): Promise<ToolResult> {
  if (!existsSync(filePath)) return { success: false, output: '', error: 'Файл не найден: ' + filePath }
  try {
    const content = await fsReadFile(filePath, 'utf-8')
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

export async function searchWeb(query: string, apiKey?: string): Promise<ToolResult> {
  if (!apiKey) return { success: false, output: '', error: 'Нет Tavily API ключа. Добавьте в Настройки → Интеграции' }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)  // 15с таймаут
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, max_results: 5, search_depth: 'basic' }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    const data = await res.json() as { results: Array<{ title: string; url: string; content: string }> }
    const formatted = data.results.map((r, i) =>
      '[' + (i+1) + '] ' + r.title + '\nURL: ' + r.url + '\n' + r.content.slice(0, 300) + '...'
    ).join('\n\n')
    return { success: true, output: formatted }
  } catch (e: any) {
    if (e.name === 'AbortError') {
      return { success: false, output: '', error: 'Веб-поиск превысил таймаут (15с). Попробуйте позже или уточните запрос.' }
    }
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

// ── http_request — прямой HTTP-клиент без shell ──────────────────────────
export async function httpRequest(params: {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  timeout?: number
}): Promise<ToolResult> {
  const { url: urlStr, method = 'GET', headers = {}, body, timeout = 30 } = params

  if (!urlStr) return { success: false, output: '', error: 'url is required' }

  let url: URL
  try {
    url = new URL(urlStr)
  } catch {
    return { success: false, output: '', error: `Invalid URL: ${urlStr}` }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { success: false, output: '', error: `Only http/https supported, got: ${url.protocol}` }
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout * 1000)

    const fetchOpts: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    }
    if (body && method !== 'GET' && method !== 'HEAD') {
      fetchOpts.body = body
    }

    const res = await fetch(urlStr, fetchOpts)
    clearTimeout(timer)

    const status = res.status
    const resHeaders: Record<string, string> = {}
    res.headers.forEach((v, k) => { resHeaders[k] = v })

    let resBody: string
    const rawText = await res.text()

    // Обрезаем очень длинные ответы
    const maxChars = 8000
    if (rawText.length > maxChars) {
      resBody = rawText.slice(0, maxChars) + `\n\n...[обрезано ${rawText.length - maxChars} символов]`
    } else {
      resBody = rawText
    }

    const headerStr = Object.entries(resHeaders)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join('\n')

    const output = [
      `[HTTP ${method} ${urlStr}]`,
      `Status: ${status} ${res.statusText}`,
      `Headers:`,
      headerStr,
      ``,
      `Body:`,
      resBody,
    ].join('\n')

    return { success: true, output }
  } catch (e: any) {
    if (e.name === 'AbortError') {
      return { success: false, output: '', error: `Request timed out after ${timeout}s` }
    }
    return { success: false, output: '', error: e.message }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + 'B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB'
  return (bytes / 1024 / 1024).toFixed(1) + 'MB'
}

// ── read_files — читать несколько файлов за раз ──────────────────────────
export async function readFiles(paths: string[], workdir?: string): Promise<ToolResult> {
  const results: string[] = []
  for (const p of paths.slice(0, 10)) {
    const rp = resolveToolPath(p, workdir)
    if (!existsSync(rp)) {
      results.push(`=== ${p} ===\n[Файл не найден]`)
      continue
    }
    try {
      if (await isBinaryFile(rp)) {
        results.push(`=== ${p} ===\n[Бинарный файл, текстовое чтение не поддерживается]`)
        continue
      }
      const content = await fsReadFile(rp, 'utf-8')
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
  opts?: { fileGlob?: string; ignoreCase?: boolean; maxResults?: number; context?: number; maxChars?: number; workdir?: string }
): Promise<ToolResult> {
  const maxResults = opts?.maxResults ?? 50
  const contextLines = opts?.context ?? 2
  const maxChars = opts?.maxChars ?? 12000

  // Нормализуем путь — относительный → абсолютный (через workdir чата если задан)
  const absPath = pathResolve(opts?.workdir ?? process.cwd(), searchPath)

  const ignoreGlobs = [...DEFAULT_IGNORE_DIRS, '*.min.js', '*.map']
  const caseFlag = opts?.ignoreCase ? '-i' : '-s'

  const rg = await findRg()

  if (rg) {
    // Используем execFile с массивом аргументов вместо exec со строкой —
    // это полностью исключает command injection (pattern передаётся как
    // отдельный аргумент, shell не вызывается, метасимволы не интерпретируются).
    const args = ['--line-number', '--no-heading', caseFlag]
    if (opts?.fileGlob) args.push('--glob', opts.fileGlob)
    for (const g of ignoreGlobs) args.push('--glob', `!${g}`)
    args.push('-C', String(contextLines), '-m', String(maxResults), pattern, absPath)
    try {
      const { stdout } = await execFileAsync(rg, args, { timeout: 15000, maxBuffer: 10 * 1024 * 1024 })
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
  const psGlob = opts?.fileGlob ?? '*.*'
  const psCase = opts?.ignoreCase ? '' : '-CaseSensitive'
  const context = opts?.context ?? 2
  // Строим regex игнор-директорий из единого списка
  const ignoreRegex = DEFAULT_IGNORE_DIRS.map(d => d.replace(/\./g, '\\.')).join('|')

  // Используем -EncodedCommand (base64 UTF-16LE) — команда передаётся как данные,
  // что полностью устраняет проблему экранирования (кавычки, $(), backtick и т.д.)
  const psScript = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ` +
    `$r = Get-ChildItem -Path '${absPath}' -Recurse -Filter '${psGlob}' -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.FullName -notmatch '${ignoreRegex}' } | ` +
    `Select-String ${psCase} -Pattern '${pattern}' -Context ${context},${context} -ErrorAction SilentlyContinue | ` +
    `Select-Object -First ${maxResults}; ` +
    `if ($r) { $r | ForEach-Object { $_.Filename + ':' + $_.LineNumber + ': ' + $_.Line.Trim() } } else { 'Совпадений не найдено' }`
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
  const psCmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
  try {
    const { stdout } = await execAsync(psCmd, { timeout: 25000, maxBuffer: 10 * 1024 * 1024 })
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
    // rg выводит: путь:номер_строки:содержимое
    // Non-greedy (.+?) с backtracking-ом корректно парсит как Unix (/path/file.ts:42:...)
    // так и Windows (C:\path\file.ts:42:...) пути — \d+ требует цифры после двоеточия,
    // поэтому движок пропускает двоеточия внутри пути и находит :номер:содержимое.
    const m = line.match(/^(.+?):(\d+)[:-](.*)$/)
    if (m) {
      const [, file, lineNum, content] = m
      if (!files.has(file)) files.set(file, [])
      files.get(file)!.push(`  ${lineNum}: ${content}`)
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
export async function analyzeProject(projectPath: string, workdir?: string): Promise<ToolResult> {
  projectPath = resolveToolPath(projectPath, workdir)
  if (!existsSync(projectPath)) {
    return { success: false, output: '', error: 'Папка не найдена: ' + projectPath }
  }

  const sections: string[] = []

  // 1. Базовая информация
  sections.push(`# Проект: ${projectPath}`)

  // 2. Дерево файлов (2 уровня, без node_modules/dist/etc)
  try {
    const ignoreRegex = DEFAULT_IGNORE_DIRS.map(d => d.replace(/\./g, '\\.')).join('|')
    const treeCmd = process.platform === 'win32'
      ? `powershell -Command "Get-ChildItem -Path '${projectPath}' -Recurse -Depth 2 | Where-Object { $_.FullName -notmatch '${ignoreRegex}' } | ForEach-Object { $_.FullName.Replace('${projectPath}', '') }"`
      : `find "${projectPath}" -maxdepth 3 ${DEFAULT_IGNORE_DIRS.map(d => `-not -path "*/${d}/*"`).join(' ')}`
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
      const pkg = JSON.parse(await fsReadFile(pkgPath, 'utf-8'))
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
        const content = (await fsReadFile(fp, 'utf-8')).slice(0, 1500)
        sections.push(`## ${f}\n\`\`\`\n${content}\n\`\`\``)
      } catch { /* ignore */ }
    }
  }

  // 5. README
  for (const f of ['README.md', 'README.txt', 'readme.md']) {
    const fp = join(projectPath, f)
    if (existsSync(fp)) {
      try {
        const content = (await fsReadFile(fp, 'utf-8')).slice(0, 2000)
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
    const countFiles = async (dir: string, depth = 0): Promise<void> => {
      if (depth > 4) return
      let entries: string[]
      try { entries = await fsReaddir(dir) } catch { return }
      for (const name of entries) {
        if (DEFAULT_IGNORE_DIRS.includes(name)) continue
        const full = join(dir, name)
        try {
          const s = await fsStat(full)
          if (s.isDirectory()) await countFiles(full, depth + 1)
          else {
            const ext = name.includes('.') ? '.' + name.split('.').pop()! : 'other'
            extCount[ext] = (extCount[ext] || 0) + 1
          }
        } catch { /* ignore */ }
      }
    }
    await countFiles(projectPath)
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
      const imgPath = join(imgDir, `img_${Date.now()}.png`)
      await ensureDirFor(imgPath)
      await fsWriteFile(imgPath, Buffer.from(b64, 'base64'))
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

    const img = response.data?.[0]
    if (!img) return { success: false, output: '', error: 'Провайдер не вернул изображение' }
    const url = img.url || ''
    const revised = img.revised_prompt ? `\nRevised prompt: ${img.revised_prompt}` : ''
    return { success: true, output: `![Generated Image](${url})${revised}\n\nURL: ${url}` }
  } catch (e: unknown) {
    return { success: false, output: '', error: e instanceof Error ? e.message : String(e) }
  }
}

// ── save_plan — только в режиме планирования ─────────────────────────────────
export async function savePlan(params: { title: string; content: string; summary: string }): Promise<ToolResult> {
  try {
    const os = require('os')
    const path = require('path')
    const plansDir = path.join(os.homedir(), 'Documents', 'Syntee', 'Plans')
    // Санитизируем имя файла
    const safeName = params.title
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/\s+/g, '_')
      .slice(0, 80) || 'plan'
    const filePath = path.join(plansDir, `plan_${safeName}.md`)
    await ensureDirFor(filePath)
    const fullContent = `# ${params.title}\n\n> ${params.summary}\n\n${params.content}`
    await fsWriteFile(filePath, fullContent, 'utf-8')
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
      description: 'Редактировать файл. replace — заменить фрагмент (с fuzzy по отступам), insert — вставить после строки, overwrite — перезаписать, apply_patch — надёжная замена по search/replace блокам (Codex-style, для множественных правок). create_if_not_exists=true создаёт файл и директории. Возвращает diff.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь к файлу' },
          mode: { type: 'string', enum: ['replace', 'insert', 'overwrite', 'apply_patch'], description: 'Режим редактирования' },
          old_str: { type: 'string', description: '[replace] Уникальный фрагмент для замены. Включай 2-3 строки контекста.' },
          new_str: { type: 'string', description: '[replace] Новый фрагмент (пустая строка = удалить)' },
          after_line: { type: 'number', description: '[insert] Вставить после этой строки (1-indexed)' },
          content: { type: 'string', description: '[insert/overwrite] Контент для вставки или перезаписи' },
          patch: { type: 'string', description: '[apply_patch] Search/replace патч. Формат: блоки <<<<<<< SEARCH / ======= / >>>>>>> REPLACE. Каждый блок заменяет одно точное вхождение. Надёжнее чем replace для множественных правок.' },
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
      name: 'get_diagnostics',
      description: 'Проверить проект на ошибки TypeScript-компиляции и линтинга (tsc --noEmit + eslint). Вызывай после серии правок кода, чтобы убедиться, что изменения не поломали типы или стиль. Возвращает список ошибок с file:line.',
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Директория проекта (по умолч. рабочая директория чата)' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Читает файл. Без offset — первые 100 строк + авто-outline структуры если файл > 100 строк. С offset/limit — точный диапазон строк. outline_only=true — только структура (функции, классы, экспорты) без содержимого — быстро сориентироваться в большом файле. Всегда показывает [total_lines] и подсказку если файл обрезан.',
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
      name: 'search_web',
      description: 'Поиск в интернете через Tavily API. Используй для актуальной информации — новости, документация, ответы на вопросы.',
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
      name: 'http_request',
      description: 'Прямой HTTP-запрос к API или веб-странице. GET/POST/PUT/DELETE/PATCH с заголовками и телом. Возвращает status, headers, body. Быстрее и надёжнее чем curl через run_command — нет проблем с экранированием. Используй для: API-вызовы, вебхуки, скачивание JSON/XML, проверка эндпоинтов. ВАЖНО: success=true означает что запрос выполнился, а не что HTTP-статус успешный — всегда проверяй Status в выводе (404/500 тоже success=true).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Полный URL (http:// или https://)' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'], description: 'HTTP-метод (по умолч. GET)' },
          headers: { type: 'object', description: 'Заголовки запроса. Например: {"Authorization": "Bearer ...", "Content-Type": "application/json"}', additionalProperties: { type: 'string' } },
          body: { type: 'string', description: 'Тело запроса (для POST/PUT/PATCH). JSON-строка, XML, plain text — что угодно.' },
          timeout: { type: 'number', description: 'Таймаут в секундах (по умолч. 30)' },
        },
        required: ['url'],
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
      description: 'Запустить суб-агента для выполнения подзадачи. Агент выполняется последовательно — вызов блокируется до завершения суб-агента и возвращает его итог. Используй когда задачу можно делегировать: независимая подзадача, требующая отдельного контекста.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Подробное описание задачи для суб-агента' },
          approval_mode: { type: 'string', enum: ['auto', 'ask', 'full'], description: 'Режим подтверждения суб-агента (по умолч. наследуется от родителя). full — без подтверждений, ask — на каждый тул, auto — умная детекция' },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_agent_status',
      description: 'Проверить статус суб-агента — активен ли, что сейчас делает, сколько шагов выполнил. Используй редко — spawn_agent сам ждёт завершения. Полезен только для UI или если нужно узнать прогресс уже завершённого агента.',
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
    type: 'function' as const,
    function: {
      name: 'revert_last_change',
      description: 'Откатить последние изменения файлов (undo/rollback). Восстанавливает оригинальное содержимое. Используй когда понял, что сделал неправильную правку.',
      parameters: {
        type: 'object',
        properties: {
          steps: { type: 'number', description: 'Сколько последних изменений откатить (по умолч. 1)' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_todo',
      description: 'Обновить чек-лист задачи (todo list). Используй для многошаговых задач — пользователь видит прогресс в чате. Вызывай в начале (с планом) и после каждого завершённого шага.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'Список шагов. Каждый шаг: { text, status }.',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'Описание шага' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'skipped'], description: 'Статус шага' },
              },
              required: ['text', 'status'],
            },
          },
        },
        required: ['items'],
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
    .filter((schema): schema is NonNullable<typeof schema> => schema !== undefined)
}

export function getToolSchemas(options: {
  planningMode?: boolean
  webMode?: boolean
  imageMode?: boolean
  multiAgentMode?: boolean
  mode?: 'code' | 'work'  // deprecated — игнорируется; work-режим удалён
} = {}) {
  const {
    planningMode = false,
    webMode = false,
    imageMode = false,
    multiAgentMode = false,
  } = options

  // Work-режим удалён — всегда полный Code-набор инструментов.
  const names: string[] = [
    'read_file',
    'read_files',
    'find_files',
    'search_code',
    'list_directory',
    'edit_file',
    'multi_edit_file',
    'write_file',
    'run_command',
    'get_diagnostics',
    'think',
    'update_working_memory',
    'revert_last_change',
    'update_todo',
    // Веб-поиск, HTTP и суб-агенты — всегда доступны агенту, модель сама решает
    // когда их использовать.
    'search_web',
    'http_request',
    'spawn_agent',
    'get_agent_status',
  ]

  if (!planningMode) names.push('analyze_project')
  if (imageMode) names.push('generate_image')
  // multiAgentMode/webMode больше не нужны для включения — оставлены как
  // параметры функции для совместимости с вызывающим кодом.
  void webMode
  void multiAgentMode

  const schemas = pickTools(names)
  if (planningMode) schemas.push(PLAN_TOOL_SCHEMA as any)
  return schemas
}

// ── Side-chat-only tool ────────────────────────────────────────────────
// Этот тул доступен ТОЛЬКО в параллельном доп-чате (side chat). Он не
// включён в TOOL_SCHEMAS и не выдаётся обычным чатам через getToolSchemas.
// Позволяет side-агенту запросить сообщения основного чата по мере нужды
// (вместо передачи всей истории в контекст — экономия токенов).
export const GET_MAIN_CHAT_MESSAGES_SCHEMA = {
  type: 'function',
  function: {
    name: 'get_main_chat_messages',
    description: 'Получить сообщения из основного чата (параллельного этому доп-чату). Возвращает текст сообщений с указанием роли. Используй для поиска информации в истории основного чата.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Количество недавних сообщений (по умолчанию 15, максимум 50).',
        },
        search: {
          type: 'string',
          description: 'Подстрока для фильтрации сообщений (case-insensitive). Если задано, возвращаются только сообщения, содержащие эту подстроку.',
        },
      },
    },
  },
} as const
