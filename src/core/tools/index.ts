import { exec } from 'child_process'
import { promisify } from 'util'
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs'
import { clipboard } from 'electron'
import { join } from 'path'
import { app } from 'electron'
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
      return {
        success: true,
        output: `data:image/png;base64,${b64}`,
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
          prompt: {
            type: 'string',
            description: 'Детальное описание изображения на английском языке для лучшего качества',
          },
          model: {
            type: 'string',
            description: 'Модель генерации (опционально, по умолчанию из настроек). Например: dall-e-3, dall-e-2, gpt-image-1',
          },
          size: {
            type: 'string',
            description: 'Размер изображения (опционально). Например: 1024x1024, 1792x1024, 1024x1792',
          },
          quality: {
            type: 'string',
            description: 'Качество изображения (опционально): standard, hd (для dall-e-3) или low, medium, high (для gpt-image-1)',
          },
          style: {
            type: 'string',
            description: 'Стиль (опционально, только для dall-e-3): vivid (яркий, реалистичный) или natural (естественный)',
          },
        },
        required: ['prompt'],
      },
    },
  },
]
