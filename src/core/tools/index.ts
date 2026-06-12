import { exec } from 'child_process'
import { promisify } from 'util'
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs'
import { clipboard } from 'electron'
import { join } from 'path'
import { app } from 'electron'

const execAsync = promisify(exec)

export interface ToolResult {
  success: boolean
  output: string
  error?: string
}

export async function runCommand(cmd: string, cwd?: string): Promise<ToolResult> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: cwd || app.getPath('home'),
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
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + 'KB'
  return (bytes/1024/1024).toFixed(1) + 'MB'
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
]
