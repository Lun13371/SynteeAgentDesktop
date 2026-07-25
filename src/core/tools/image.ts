import { tmpdir } from 'os'
import { join } from 'path'
import { writeFile as fsWriteFile } from 'fs/promises'
import OpenAI from 'openai'
import type Store from 'electron-store'
import type { Provider } from '../../shared/types'
import { ensureDirFor, type ToolResult } from './_shared'

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
