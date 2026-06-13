import { exec } from 'child_process'
import { promisify } from 'util'
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { clipboard } from 'electron'
import OpenAI from 'openai'
import type Store from 'electron-store'
import type { Provider } from '../../shared/types'

const execAsync = promisify(exec)

export interface ToolResult {
  success: boolean
  output: string
  error?: string
}

export async function runCommand(cmd: string, cwd?: string): Promise<ToolResult> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: cwd || homedir(),
      timeout: 30000,
    })
    return { success: true, output: stdout || stderr }
  } catch (e: any) {
    return { success: false, output: e.stdout || '', error: e.message }
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
      name: 'run_command',
      description: 'Выполнить команду в терминале Windows. Используй для системных задач.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Команда для выполнения' },
          cwd: { type: 'string', description: 'Рабочая директория (опционально)' },
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
]
