import { ipcMain, desktopCapturer, screen, BrowserWindow, clipboard } from 'electron'
import { join } from 'path'
import { app } from 'electron'
import type Store from 'electron-store'
import { AIClient } from '../../core/ai/AIClient'
import { IPC_EVENTS } from '../../shared/constants'

export function registerOverlayIPC(
  store: Store,
  overlayWindow: { getWindow: () => BrowserWindow | null; show: () => void; hide: () => void }
): void {

  // Захват всего экрана (все мониторы)
  ipcMain.handle('overlay:captureScreen', async () => {
    const displays = screen.getAllDisplays()
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    })

    // Возвращаем base64 скриншоты для каждого дисплея
    return sources.map((src, i) => ({
      id: src.id,
      displayId: displays[i]?.id,
      bounds: displays[i]?.bounds,
      thumbnail: src.thumbnail.toDataURL().split(',')[1], // base64
    }))
  })

  // Анализ выделенной области через Vision AI
  ipcMain.handle('overlay:analyze', async (_, params: {
    imageBase64: string
    prompt: string
    action: 'analyze' | 'translate' | 'summarize' | 'read'
  }) => {
    const win = overlayWindow.getWindow()
    const client = new AIClient(store)

    const prompts: Record<string, string> = {
      analyze: params.prompt || 'Что изображено на этом скриншоте? Опиши подробно и отвечай на русском.',
      translate: 'Переведи весь текст на этом изображении на русский язык. Только перевод, без пояснений.',
      summarize: 'Кратко изложи содержимое этого изображения. Отвечай на русском.',
      read: 'Прочитай и верни весь текст с этого изображения (OCR). Сохраняй форматирование.',
    }

    const finalPrompt = prompts[params.action] || params.prompt

    await client.analyzeImage(
      params.imageBase64,
      finalPrompt,
      {
        onToken: (token) => {
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_TOKEN, { token, source: 'overlay' })
        },
        onDone: (text) => {
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_DONE, { text, source: 'overlay' })
        },
        onError: (err) => {
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_ERROR, { error: err.message, source: 'overlay' })
        },
        onRateLimit: (waitSec) => {
          win?.webContents.send(IPC_EVENTS.RATE_LIMIT, { waitSec })
        },
      }
    )
  })

  // Сохранить скриншот в файл
  ipcMain.handle('overlay:saveScreenshot', async (_, base64: string) => {
    const { writeFileSync } = await import('fs')
    const { mkdirSync } = await import('fs')
    const dir = join(app.getPath('userData'), 'screenshots')
    mkdirSync(dir, { recursive: true })
    const filename = `screenshot-${Date.now()}.png`
    const path = join(dir, filename)
    const buf = Buffer.from(base64, 'base64')
    writeFileSync(path, buf)
    return path
  })
}
