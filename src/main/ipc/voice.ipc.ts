import { ipcMain, BrowserWindow } from 'electron'
import type Store from 'electron-store'
import { AIClient } from '../../core/ai/AIClient'

export function registerVoiceIPC(
  store: Store,
  getMainWin: () => BrowserWindow | null
): void {

  // Текст → речь через OpenAI TTS endpoint
  ipcMain.handle('voice:tts', async (_, text: string) => {
    const client = new AIClient(store)
    const audioBase64 = await client.textToSpeech(text)
    return audioBase64 // base64 mp3
  })

  // Отправить голосовой запрос в чат (после STT в renderer)
  ipcMain.handle('voice:sendQuery', async (_, text: string) => {
    const mainWin = getMainWin()
    if (!mainWin) return

    // Создаём новый чат если нужно и отправляем запрос
    mainWin.webContents.send('voice:query', { text })
  })
}
