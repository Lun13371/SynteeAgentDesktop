import { existsSync } from 'fs'
import { readFile as fsReadFile, stat as fsStat } from 'fs/promises'
import { resolveToolPath, isBinaryFile, formatSize, type ToolResult } from './_shared'

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
      { re: /^ {2}(?:public|private|protected|static|async|\bget\b|\bset\b)\s+(?:async\s+)?(\w+)\s*[(<]/, label: 'method' },
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
