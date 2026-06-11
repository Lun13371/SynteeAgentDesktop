import { ipcMain, BrowserWindow } from 'electron'
import { v4 as uuid } from 'uuid'
import type Store from 'electron-store/ts'
import { AIClient } from '../../core/ai/AIClient'
import {
  createChat, getAllChats, getMessages, addMessage,
  renameChat, deleteChat, pinMessage, getAllMemory,
  clearMemory, upsertMemory
} from '../../core/db/database'
import { IPC_EVENTS } from '../../shared/constants'
import type { MainWindow } from '../windows/MainWindow'

let aiClient: AIClient

export function registerChatIPC(store: Store, mainWindow: MainWindow): void {
  aiClient = new AIClient(store)

  // Пересоздавать клиент при смене API ключа
  ipcMain.handle('settings:set', async (_, key: string, value: unknown) => {
    store.set(key, value)
    if (key === 'apiKey' || key === 'apiEndpoint') {
      aiClient.reload()
    }
  })

  // Создать чат
  ipcMain.handle('chat:create', (_, incognito = false) => {
    const id = uuid()
    if (!incognito) createChat(id, false)
    return id
  })

  // Получить все чаты
  ipcMain.handle('chat:getAll', () => getAllChats())

  // Получить сообщения
  ipcMain.handle('chat:getMessages', (_, chatId: string) => getMessages(chatId))

  // Удалить чат
  ipcMain.handle('chat:delete', (_, chatId: string) => deleteChat(chatId))

  // Переименовать чат
  ipcMain.handle('chat:rename', (_, chatId: string, title: string) => renameChat(chatId, title))

  // Закрепить сообщение
  ipcMain.handle('chat:pinMessage', (_, id: string, pinned: boolean) => pinMessage(id, pinned))

  // Отправить сообщение + стриминг ответа
  ipcMain.handle('chat:send', async (event, params: {
    chatId: string
    content: string
    history: Array<{ role: 'user' | 'assistant'; content: string }>
    incognito?: boolean
    model?: string
  }) => {
    const win = mainWindow.getWindow()
    const sender = BrowserWindow.fromWebContents(event.sender)
    if (!win && !sender) return

    const notify = (channel: string, data: unknown) => {
      try {
        event.sender.send(channel, data)
      } catch { /* окно закрылось */ }
    }

    const mainModel = (store.get('mainModel') as string) || 'claude-sonnet-4-6'
    const memModel = (store.get('memoryModel') as string) || 'claude-haiku-4-5'
    const model = params.model || mainModel

    // Сохраняем сообщение пользователя
    const userMsgId = uuid()
    if (!params.incognito) {
      addMessage({ id: userMsgId, chatId: params.chatId, role: 'user', content: params.content })
    }

    // Строим системный промпт с памятью
    const memories = getAllMemory() as Array<{ key: string; value: string; category: string }>
    let systemPrompt = `Ты Syntee — персональный AI-ассистент пользователя. Ты дружелюбна, с юмором, общаешься на вы. Отвечаешь на русском языке. Комментируешь свои действия.`

    if (memories.length > 0) {
      systemPrompt += '\n\nЧто ты знаешь о пользователе:\n'
      systemPrompt += memories.map(m => `- [${m.category}] ${m.key}: ${m.value}`).join('\n')
    }

    const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...params.history.slice(-20), // последние 20 сообщений контекст
      { role: 'user', content: params.content }
    ]

    // Стриминг
    const assistantMsgId = uuid()
    let fullContent = ''

    try {
      for await (const token of aiClient.streamChat({
        model,
        messages,
        onRateLimit: (sec) => {
          notify(IPC_EVENTS.RATE_LIMIT, { seconds: sec })
        }
      })) {
        fullContent += token
        notify(IPC_EVENTS.CHAT_STREAM_TOKEN, { id: assistantMsgId, token })
      }

      notify(IPC_EVENTS.CHAT_STREAM_DONE, { id: assistantMsgId, content: fullContent })

      // Сохраняем ответ
      if (!params.incognito) {
        addMessage({ id: assistantMsgId, chatId: params.chatId, role: 'assistant', content: fullContent, model })
      }

      // Авто-заголовок чата (если первое сообщение)
      if (!params.incognito && params.history.length === 0) {
        const title = await aiClient.generateChatTitle(params.content, memModel)
        renameChat(params.chatId, title)
        notify('chat:titled', { chatId: params.chatId, title })
      }

      // Извлечение факта о пользователе
      const fact = await aiClient.extractFact(params.content, memModel)
      if (fact) {
        upsertMemory(uuid(), fact.category, fact.key, fact.value)
        notify(IPC_EVENTS.MEMORY_MEMORIZED, { key: fact.key, value: fact.value })
      }

    } catch (err: unknown) {
      const msg = (err as Error)?.message || 'Неизвестная ошибка'
      notify(IPC_EVENTS.CHAT_STREAM_ERROR, { id: assistantMsgId, error: msg })
    }

    return assistantMsgId
  })

  // Память
  ipcMain.handle('memory:getAll', () => getAllMemory())
  ipcMain.handle('memory:clear', () => clearMemory())
}
