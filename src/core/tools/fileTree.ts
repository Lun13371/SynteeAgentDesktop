import { existsSync } from 'fs'
import { readdir as fsReaddir, stat as fsStat } from 'fs/promises'
import { join } from 'path'
import { DEFAULT_IGNORE_DIRS, resolveToolPath, formatSize, type ToolResult } from './_shared'

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
