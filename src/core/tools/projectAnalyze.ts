import { existsSync } from 'fs'
import { readdir as fsReaddir, stat as fsStat, readFile as fsReadFile } from 'fs/promises'
import { join } from 'path'
import { execAsync, DEFAULT_IGNORE_DIRS, resolveToolPath, type ToolResult } from './_shared'

// ── analyze_project — полный анализ проекта ──────────────────────────────
export async function analyzeProject(projectPath: string, workdir?: string): Promise<ToolResult> {
  projectPath = resolveToolPath(projectPath, workdir)
  if (!existsSync(projectPath)) {
    return { success: false, output: '', error: 'Directory not found: ' + projectPath }
  }

  const sections: string[] = []

  // 1. Basic info
  sections.push(`# Project: ${projectPath}`)

  // 2. File tree (2 levels, without node_modules/dist/etc)
  try {
    const ignoreRegex = DEFAULT_IGNORE_DIRS.map(d => d.replace(/\./g, '\\.')).join('|')
    const treeCmd = process.platform === 'win32'
      ? `powershell -Command "Get-ChildItem -Path '${projectPath}' -Recurse -Depth 2 | Where-Object { $_.FullName -notmatch '${ignoreRegex}' } | ForEach-Object { $_.FullName.Replace('${projectPath}', '') }"`
      : `find "${projectPath}" -maxdepth 3 ${DEFAULT_IGNORE_DIRS.map(d => `-not -path "*/${d}/*"`).join(' ')}`
    const { stdout: tree } = await execAsync(treeCmd, { timeout: 10000 })
    const lines = tree.trim().split('\n').slice(0, 80)
    sections.push(`## File structure\n${lines.join('\n')}${lines.length >= 80 ? '\n...[truncated]' : ''}`)
  } catch (e: any) {
    sections.push(`## File structure\n[Error: ${e.message}]`)
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
    sections.push(`## Git\nBranch: ${gitBranch.trim()}\n\nRecent commits:\n${gitLog.trim()}\n\nChanges:\n${gitStatus.trim() || 'No changes'}`)
  } catch { /* ignore — not a git repo */ }

  // 7. Code statistics
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
    sections.push(`## File statistics\n${sorted.map(([ext, n]) => `${ext}: ${n} file(s)`).join('\n')}`)
  } catch { /* ignore */ }

  return { success: true, output: sections.join('\n\n') }
}
