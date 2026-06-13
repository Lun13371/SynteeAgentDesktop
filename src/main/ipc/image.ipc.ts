import { ipcMain, BrowserWindow } from 'electron'
import OpenAI from 'openai'
import type Store from 'electron-store'
import type { Provider } from '../../shared/types'

export interface ImageGenParams {
  prompt: string
  model?: string
  size?: string
  quality?: string
  style?: string
  n?: number
}

export interface ImageGenResult {
  url?: string
  b64?: string
  revisedPrompt?: string
  error?: string
}

export function registerImageIPC(store: Store, mainWindow: { getWindow: () => BrowserWindow | null }): void {

  ipcMain.handle('image:generate', async (_, params: ImageGenParams): Promise<ImageGenResult> => {
    const providers = store.get('providers', []) as Provider[]
    const imageProviderId = store.get('imageProviderId', '') as string
    const imageModelId = store.get('imageModelId', 'dall-e-3') as string

    const modelId = params.model || imageModelId

    // Найдём нужный провайдер
    const provider = imageProviderId
      ? providers.find(p => p.id === imageProviderId)
      : providers.find(p => p.enabled && (p.apiKey || (p.apiKeys && p.apiKeys.length > 0)))

    if (!provider) {
      return { error: 'Нет настроенного провайдера для генерации изображений' }
    }

    const apiKey = provider.apiKeys?.find(k => k.trim()) || provider.apiKey || ''
    if (!apiKey) {
      return { error: 'API ключ провайдера не задан' }
    }

    try {
      const client = new OpenAI({
        apiKey,
        baseURL: provider.baseUrl,
      })

      const size = (params.size || '1024x1024') as Parameters<typeof client.images.generate>[0]['size']

      const response = await client.images.generate({
        model: modelId,
        prompt: params.prompt,
        n: params.n || 1,
        size,
        quality: params.quality as Parameters<typeof client.images.generate>[0]['quality'],
        style: params.style as Parameters<typeof client.images.generate>[0]['style'],
        response_format: 'url',
      })

      const img = response.data[0]
      return {
        url: img.url ?? undefined,
        b64: img.b64_json ?? undefined,
        revisedPrompt: img.revised_prompt ?? undefined,
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { error: msg }
    }
  })

  // Получить текущие настройки image generation
  ipcMain.handle('image:getSettings', () => {
    return {
      providerId: store.get('imageProviderId', '') as string,
      modelId: store.get('imageModelId', 'dall-e-3') as string,
      defaultSize: store.get('imageDefaultSize', '1024x1024') as string,
      defaultQuality: store.get('imageDefaultQuality', 'standard') as string,
    }
  })

  ipcMain.handle('image:setSettings', (_, settings: {
    providerId?: string
    modelId?: string
    defaultSize?: string
    defaultQuality?: string
  }) => {
    if (settings.providerId !== undefined) store.set('imageProviderId', settings.providerId)
    if (settings.modelId !== undefined) store.set('imageModelId', settings.modelId)
    if (settings.defaultSize !== undefined) store.set('imageDefaultSize', settings.defaultSize)
    if (settings.defaultQuality !== undefined) store.set('imageDefaultQuality', settings.defaultQuality)
  })
}
