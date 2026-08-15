import { existsSync } from 'fs'
import { readFile as fsReadFile, stat as fsStat } from 'fs/promises'
import { resolveToolPath, isBinaryFile, formatSize, type ToolResult } from './_shared'
import { extractSymbolsFromSource, type SymbolDef } from '../context/fastContext'

const MAX_READ_FILE_SIZE = 20 * 1024 * 1024  // 20MB — больше не читаем целиком в память

export async function readFile(path: string, offset?: number, limit?: number, workdir?: string, full?: boolean): Promise<ToolResult> {
  try {
    path = resolveToolPath(path, workdir)
    if (!existsSync(path)) return { success: false, output: '', error: 'File not found: ' + path }
    // Check size — do not read huge files into memory entirely
    const fileStat = await fsStat(path)
    if (fileStat.size > MAX_READ_FILE_SIZE) {
      return { success: false, output: '', error: `File too large (${formatSize(fileStat.size)}). Use offset/limit to read in parts or run_command to view.` }
    }
    if (await isBinaryFile(path)) return { success: false, output: '', error: 'File appears to be binary, text reading is not supported: ' + path }
    const content = await fsReadFile(path, 'utf-8')
    const lines = content.split('\n')
    const totalLines = lines.length

    // full=true — чанками по ~5000 символов. Сигментация по символам, не по
    // строкам: одна длинная строка (minified JS) не съест весь чанк. Каждый
    // чанк начинается с начала строки, нумерация строк сохраняется.
    // При offset — продолжаем с указанной строки (используется auto-advance).
    if (full === true) {
      const MAX_CHARS = 5000
      const startLine = Math.max(0, (offset ?? 1) - 1)
      let charCount = 0
      let endLine = startLine
      for (let i = startLine; i < totalLines; i++) {
        const lineLen = lines[i].length + 1
        if (charCount + lineLen > MAX_CHARS && i > startLine) { endLine = i; break }
        charCount += lineLen
        endLine = i + 1
      }
      const slice = lines.slice(startLine, endLine)
      const numbered = slice.map((l, i) => `${startLine + i + 1}|${l}`).join('\n')
      const hasMore = endLine < totalLines
      const suffix = hasMore
        ? `\n...[full mode: shown lines ${startLine + 1}-${endLine} (~${charCount} chars of ${content.length}) | call read_file again with full=true to continue from line ${endLine + 1}]`
        : ''
      return {
        success: true,
        output: `[File: ${path} | Lines ${startLine + 1}-${endLine} of ${totalLines} | full mode]${suffix}\n${numbered}`,
      }
    }

    if (offset !== undefined || limit !== undefined) {
      const from = Math.max(0, (offset ?? 1) - 1)  // offset 1-indexed
      const count = limit ?? 400
      const slice = lines.slice(from, from + count)
      const numbered = slice.map((l, i) => `${from + i + 1}|${l}`).join('\n')
      const hasMore = from + count < totalLines
      const truncatedInfo = hasMore
        ? `\n...[shown ${slice.length} of ${totalLines} lines | ${totalLines - from - count} more lines | use offset=${from + count + 1} to continue]`
        : ''
      return {
        success: true,
        output: `[File: ${path} | Lines ${from + 1}-${from + slice.length} of ${totalLines}]${truncatedInfo}\n${numbered}`,
      }
    }

    // Без offset — читаем первые 400 строк, если файл больше — добавляем авто-outline.
    // Дефолт 400 (а не 200) снижает round-trips на больших файлах: классы по
    // 400-800 строк читаются за 1-2 вызова вместо 3-5. Контекст-лимит read_file
    // всё ещё контролируется сверху (но в Agent.ts truncateToolResult для
    // read_file отключён — своя обрезка по строкам уже даёт правильную
    // подсказку с готовым offset для продолжения).
    const DEFAULT_LINES = 400
    const truncated = totalLines > DEFAULT_LINES
    const slice = lines.slice(0, DEFAULT_LINES)
    const numbered = slice.map((l, i) => `${i + 1}|${l}`).join('\n')

    let suffix = ''
    if (truncated) {
      suffix = `\n...[shown ${DEFAULT_LINES} of ${totalLines} lines | use offset=${DEFAULT_LINES + 1} to continue or offset/limit to read in parts]`
    }
    return {
      success: true,
      output: `[File: ${path} | ${totalLines} lines]${suffix}\n${numbered}`,
    }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}

// ── get_file_outline — структура файла (функции/классы/экспорты) ──────────
// Использует tree-sitter (через fastContext.extractSymbolsFromSource) для
// точной навигации: функции/методы/классы/интерфейсы/imports с номерами
// строк. Покрывает 20+ языков (js/ts/tsx/py/rs/go/c/cpp/java/cs/rb/php/
// swift/kt/scala/lua/bash/dart/elixir). Для неподдерживаемых языков —
// regex-fallback (улучшенный: plain-методы класса, React-компоненты).
export async function getFileOutline(filePath: string, alreadyReadContent?: string): Promise<ToolResult> {
  if (!existsSync(filePath)) return { success: false, output: '', error: 'File not found: ' + filePath }
  try {
    const content = alreadyReadContent ?? await fsReadFile(filePath, 'utf-8')
    const lines = content.split('\n')
    const totalLines = lines.length

    // 1. tree-sitter (точный AST-обход) — покрывает 20+ языков
    const symbols = await extractSymbolsFromSource(filePath, content)
    if (symbols && (symbols.definitions.length || symbols.imports.length)) {
      return renderOutlineFromSymbols(filePath, totalLines, symbols.definitions, symbols.imports)
    }

    // 2. Regex-fallback — для языков без tree-sitter грамматики (.vue/.svelte/.css/.md/.sql/.yml/...)
    const regexOutline = renderOutlineRegex(filePath, lines)
    if (regexOutline) {
      return { success: true, output: regexOutline }
    }

    // 3. Found nothing — honest stub with an action hint
    const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
    return {
      success: true,
      output: `[Outline: ${filePath} | ${totalLines} lines]\n  Structure not defined for .${ext}. Use offset/limit to read in parts.`,
    }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}

function renderOutlineFromSymbols(filePath: string, totalLines: number, definitions: SymbolDef[], imports: string[]): ToolResult {
  const outline: string[] = [`[Outline: ${filePath} | ${totalLines} lines]`]
  if (imports.length) {
    outline.push(`  imports(${imports.length}): ${imports.slice(0, 5).join(', ')}${imports.length > 5 ? ` +${imports.length - 5}` : ''}`)
  }
  // Сортируем по строке начала (методы класса идут после класса, но с parentName)
  const sorted = [...definitions].sort((a, b) => a.lineStart - b.lineStart)
  for (const d of sorted) {
    const parent = d.parentName ? `${d.parentName} → ` : ''
    outline.push(`  ${d.lineStart}: [${d.kind}] ${parent}${d.name}  — ${d.signature}`)
  }
  return { success: true, output: outline.join('\n') }
}

// Regex-fallback для языков без tree-sitter грамматики.
// Возвращает строку outline или null если ничего не найдено.
function renderOutlineRegex(filePath: string, lines: string[]): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  // Расширенные TS/JS-паттерны (дополняют tree-sitter если он не сработал):
  // теперь ловим plain-методы класса (methodName() {) — самый частый кейс,
  // который старый regex пропускал.
  const tsPatterns: Array<{ re: RegExp; label: string }> = [
    { re: /^export\s+default\s+(async\s+)?(function|class)\s*(\w*)/, label: 'export default' },
    { re: /^export\s+(async\s+)?function\s+(\w+)/, label: 'export fn' },
    { re: /^export\s+(const|let)\s+(\w+)\s*[:=].*(?:=>|\bfunction\b)/, label: 'export const fn' },
    { re: /^export\s+(?:abstract\s+)?class\s+(\w+)/, label: 'class' },
    { re: /^export\s+(?:interface|type|enum)\s+(\w+)/, label: 'type' },
    // Plain-метод класса: отступ 2+ пробела, имя(...), после ) — : или { или =>
    // (раньше требовался public/private/... — теряли большинство методов).
    { re: /^ {2,}(\w+)\s*\([^)]*\)\s*[:{]/, label: 'method' },
    { re: /^ {2,}(?:public|private|protected|static|async|\bget\b|\bset\b)\s+(?:async\s+)?(\w+)\s*[(<]/, label: 'method' },
    { re: /^(?:async\s+)?function\s+(\w+)/, label: 'fn' },
    { re: /^(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/, label: 'fn' },
    { re: /^(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/, label: 'fn' },
    { re: /^import\s+.*\s+from\s+['"](.+)['"]/, label: 'import' },
  ]
  const pyPatterns: Array<{ re: RegExp; label: string }> = [
    { re: /^(?:async\s+)?def\s+(\w+)/, label: 'def' },
    { re: /^class\s+(\w+)/, label: 'class' },
    { re: /^(?:from\s+\S+\s+)?import\s+(\S+)/, label: 'import' },
  ]
  // Базовые паттерны для остальных языков (css/html/markdown/config)
  const genericPatterns: Array<{ re: RegExp; label: string }> = [
    { re: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/, label: 'fn' },
    { re: /^\s*(?:export\s+)?class\s+(\w+)/, label: 'class' },
  ]
  const activePatterns = ext === 'py' ? pyPatterns
    : ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte'].includes(ext) ? tsPatterns
    : genericPatterns
  const outline: string[] = [`[Outline: ${filePath} | ${lines.length} lines]`]
  const imports: string[] = []
  let pastImports = false
  let foundAny = false
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
      foundAny = true
      return
    }
    if (!pastImports && line.trim() && !line.startsWith('//') && !line.startsWith(' *') && !line.startsWith('*')) pastImports = true
  })
  if (!pastImports && imports.length) outline.push(`  imports(${imports.length}): ${imports.slice(0, 5).join(', ')}`)
  return foundAny || imports.length ? outline.join('\n') : null
}

// ── read_files — read several files at once ──────────────────────────
export async function readFiles(paths: string[], workdir?: string): Promise<ToolResult> {
  const results: string[] = []
  let foundCount = 0
  for (const p of paths.slice(0, 10)) {
    const rp = resolveToolPath(p, workdir)
    if (!existsSync(rp)) {
      results.push(`=== ${p} ===\n[File not found]`)
      continue
    }
    try {
      if (await isBinaryFile(rp)) {
        results.push(`=== ${p} ===\n[Binary file, text reading is not supported]`)
        continue
      }
      const content = await fsReadFile(rp, 'utf-8')
      const lines = content.split('\n')
      const MAX_LINES = 250
      const truncated = lines.length > MAX_LINES
      const slice = lines.slice(0, MAX_LINES).map((l, i) => `${i + 1}|${l}`).join('\n')
      const info = truncated
        ? `\n...[shown ${MAX_LINES} of ${lines.length} lines | use read_file with offset to continue]`
        : ''
      results.push(`=== ${p} | ${lines.length} lines ===\n${slice}${info}`)
      foundCount++
    } catch (e: any) {
      results.push(`=== ${p} ===\n[Read error: ${e.message}]`)
    }
  }
  // Explicit overall result: if none of the files were found/read, signal failure.
  if (paths.length > 0 && foundCount === 0) {
    return { success: false, output: results.join('\n\n'), error: `No files found (0 of ${paths.length}). Check the paths.` }
  }
  return { success: true, output: results.join('\n\n') }
}
