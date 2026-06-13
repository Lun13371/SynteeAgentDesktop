import { exec } from 'child_process'
import { promisify } from 'util'
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
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
}

export async function runCommand(cmd: string, cwd?: string, shell?: string, timeout?: number): Promise<ToolResult> {
  try {
    const isWin = process.platform === 'win32'
    const timeoutMs = (timeout || 30) * 1000

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
    const out = (stdout || '') + (stderr ? `\n[stderr]: ${stderr}` : '')
    return { success: true, output: `[exit: 0]\n${out.trim() || '(нет вывода)'}` }
  } catch (e: any) {
    const out = [e.stdout, e.stderr].filter(Boolean).join('\n')
    const exitCode = typeof e.code === 'number' ? e.code : 1
    return {
      success: false,
      output: out.trim() ? `[exit: ${exitCode}]\n${out.trim()}` : `[exit: ${exitCode}]`,
      error: e.message?.replace(/Command failed:.+\n?/, '').trim() || 'Команда завершилась с ошибкой',
    }
  }
}

export function readFile(path: string): ToolResult {
  try {
    if (!existsSync(path)) return { success: false, output: '', error: 'Файл не найден: ' + path }
    const content = readFileSync(path, 'utf-8')
    return { success: true, output: content.slice(0, 8000) + (content.length > 8000 ? '\n...[обрезано]' : '') }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}

export function writeFile(path: string, content: string): ToolResult {
  try {
    writeFileSync(path, content, 'utf-8')
    return { success: true, output: 'Файл записан: ' + path }
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
}): EditResult {
  try {
    if (!existsSync(params.path)) return { success: false, output: '', error: 'Файл не найден: ' + params.path }
    const original = readFileSync(params.path, 'utf-8')
    let updated = original

    if (params.mode === 'replace') {
      if (!params.old_str) return { success: false, output: '', error: 'edit_file replace: нужен old_str' }
      const normStr = (s: string) => s.split(String.fromCharCode(13)).join('')
      const normOrig = normStr(original)
      const normOld = normStr(params.old_str)
      if (!normOrig.includes(normOld))
        return { success: false, output: '', error: 'edit_file replace: old_str не найден в файле' }
      updated = normOrig.replace(normOld, params.new_str ?? '')

    } else if (params.mode === 'insert') {
      const lines = original.split('\n')
      const at = Math.min(params.after_line ?? lines.length, lines.length)
      lines.splice(at, 0, ...(params.content ?? '').split('\n'))
      updated = lines.join('\n')

    } else if (params.mode === 'overwrite') {
      if (!params.content) return { success: false, output: '', error: 'edit_file overwrite: нужен content' }
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

export function listDirectory(path: string): ToolResult {
  try {
    if (!existsSync(path)) return { success: false, output: '', error: 'Папка не найдена: ' + path }
    const items = readdirSync(path).map(name => {
      const full = join(path, name)
      const stat = statSync(full)
      return (stat.isDirectory() ? '📁' : '📄') + ' ' + name + (stat.isDirectory() ? '/' : ' (' + formatSize(stat.size) + ')')
    })
    return { success: true, output: items.join('\n') }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}

export function getClipboard(): ToolResult {
  const text = clipboard.readText()
  return { success: true, output: text || '(буфер обмена пуст)' }
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

// ── search_code — поиск по коду (ripgrep/grep) ───────────────────────────
export async function searchCode(
  pattern: string,
  path: string,
  opts?: { fileGlob?: string; ignoreCase?: boolean; maxResults?: number }
): Promise<ToolResult> {
  const maxResults = opts?.maxResults ?? 50
  const caseFlag = opts?.ignoreCase ? '-i' : ''
  const globFlag = opts?.fileGlob ? `--glob "${opts.fileGlob}"` : ''

  // Пробуем ripgrep (rg), fallback на grep
  const rgCmd = `rg --line-number --no-heading ${caseFlag} ${globFlag} -m ${maxResults} "${pattern.replace(/"/g, '\\"')}" "${path}"`
  const grepCmd = `grep -rn ${caseFlag} -m ${maxResults} "${pattern.replace(/"/g, '\\"')}" "${path}" ${opts?.fileGlob ? `--include="${opts.fileGlob}"` : ''}`

  try {
    const { stdout } = await execAsync(rgCmd, { timeout: 15000 })
    const lines = stdout.trim().split('\n').slice(0, maxResults)
    return { success: true, output: lines.join('\n') || 'Совпадений не найдено' }
  } catch {
    try {
      const { stdout } = await execAsync(grepCmd, { timeout: 15000 })
      const lines = stdout.trim().split('\n').slice(0, maxResults)
      return { success: true, output: lines.join('\n') || 'Совпадений не найдено' }
    } catch (e: any) {
      if (e.code === 1) return { success: true, output: 'Совпадений не найдено' }
      return { success: false, output: '', error: e.message }
    }
  }
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

export const TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'edit_file',
      description: 'Редактировать файл. Три режима: replace — заменить уникальный фрагмент (предпочтительно), insert — вставить строки после указанной, overwrite — перезаписать файл целиком. Всегда возвращает diff изменений.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь к файлу' },
          mode: { type: 'string', enum: ['replace', 'insert', 'overwrite'], description: 'Режим редактирования' },
          old_str: { type: 'string', description: '[replace] Уникальный фрагмент который нужно заменить. Включай 2-3 строки контекста для уникальности.' },
          new_str: { type: 'string', description: '[replace] Новый фрагмент (пустая строка = удалить)' },
          after_line: { type: 'number', description: '[insert] Вставить после этой строки (1-indexed)' },
          content: { type: 'string', description: '[insert/overwrite] Контент для вставки или перезаписи' },
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
          timeout: { type: 'number', description: 'Таймаут в секундах (по умолч. 30)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Прочитать содержимое файла.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Абсолютный путь к файлу' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Записать текст в файл.',
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
      description: 'Показать содержимое папки.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Путь к папке' } },
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
      description: 'Поиск по коду проекта — найти где используется функция, класс, переменная, паттерн. Использует ripgrep (rg) с fallback на grep.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex или текст для поиска. Например: "useState", "handleClick", "import.*axios"' },
          path: { type: 'string', description: 'Директория или файл для поиска' },
          file_glob: { type: 'string', description: 'Фильтр по расширению. Например: "*.ts", "*.tsx", "*.py"' },
          ignore_case: { type: 'boolean', description: 'Игнорировать регистр (по умолчанию false)' },
          max_results: { type: 'number', description: 'Максимум результатов (по умолчанию 50)' },
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
]
