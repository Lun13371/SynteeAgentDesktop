import { ipcMain, BrowserWindow } from 'electron'
import type Store from 'electron-store'
import { AIClient } from '../../core/ai/AIClient'
import {
  createChat, getAllChats, getMessages, saveMessage,
  deleteChat, renameChat, pinMessage, unpinMessage, initDB
} from '../../core/db/database'
import { IPC_EVENTS } from '../../shared/constants'
import { v4 as uuid } from 'uuid'
import type { Message } from '../../shared/types'

let aiClient: AIClient

export function registerChatIPC(store: Store, mainWindow: { getWindow: () => BrowserWindow | null }): void {
  initDB()
  aiClient = new AIClient(store)

  // Системный промпт Syntee
  const getSystemPrompt = (): string => {
    const userName = store.get('userName') as string || ''
    return `Ты Syntee — персональный AI-ассистент для Windows. Умный, дружелюбный, с лёгким юмором.
${userName ? `Пользователя зовут ${userName}. Обращайся к нему по имени.` : ''}
Отвечай на том же языке, на котором говорит пользователь.
Отвечай по умолчанию в среднем объёме — не слишком коротко и не слишком длинно.
Форматируй ответы с использованием Markdown когда это уместно.
Дата и время: ${new Date().toLocaleString('ru')}.`
  }

  // Создать чат
  ipcMain.handle('chat:create', (_, isIncognito = false) => {
    return createChat(isIncognito)
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
  ipcMain.handle('chat:pin', (_, messageId: string) => pinMessage(messageId))
  ipcMain.handle('chat:unpin', (_, messageId: string) => unpinMessage(messageId))

  // Отправить сообщение + стриминг ответа
  ipcMain.handle('chat:send', async (_, params: {
    chatId: string
    content: string
    incognito?: boolean
  }) => {
    const win = mainWindow.getWindow()

    // Сохраняем сообщение пользователя
    const userMsg: Message = {
      id: uuid(),
      chatId: params.chatId,
      role: 'user',
      content: params.content,
      createdAt: Date.now(),
      isPinned: 0,
    }
    if (!params.incognito) saveMessage(userMsg)

    // Получаем историю для контекста
    const history = params.incognito ? [] : getMessages(params.chatId)
    const contextMessages = history.slice(-20).map(m => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
    }))
    contextMessages.push({ role: 'user', content: params.content })

    const assistantMsgId = uuid()
    let fullText = ''

    await aiClient.streamChat(
      contextMessages,
      {
        onToken: (token) => {
          fullText += token
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_TOKEN, {
            chatId: params.chatId,
            msgId: assistantMsgId,
            token,
          })
        },
        onDone: (text) => {
          fullText = text
          const assistantMsg: Message = {
            id: assistantMsgId,
            chatId: params.chatId,
            role: 'assistant',
            content: fullText,
            createdAt: Date.now(),
            isPinned: 0,
            model: store.get('mainModel') as string || 'claude-sonnet-4-6',
          }
          if (!params.incognito) saveMessage(assistantMsg)

          // Автоназвание чата после первого обмена
          if (history.length === 0 && !params.incognito) {
            autoNameChat(params.chatId, params.content, store)
          }

          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_DONE, {
            chatId: params.chatId,
            msgId: assistantMsgId,
            message: assistantMsg,
          })
        },
        onError: (err) => {
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_ERROR, {
            chatId: params.chatId,
            error: err.message,
          })
        },
        onRateLimit: (waitSec) => {
          win?.webContents.send(IPC_EVENTS.RATE_LIMIT, { waitSec })
        },
      },
      'main',
      getSystemPrompt()
    )

    return userMsg
  })

  // Обновить клиент при смене настроек
  ipcMain.handle('chat:reloadClient', () => {
    aiClient.reload()
  })
}

// Авто-название чата через быструю модель
async function autoNameChat(chatId: string, firstMessage: string, store: Store): Promise<void> {
  try {
    const client = new AIClient(store)
    const title = await client.complete(
      [{ role: 'user', content: `Придумай короткое название (3-5 слов) для чата, который начинается с этого сообщения: "${firstMessage.slice(0, 200)}". Ответь только названием без кавычек.` }],
      'fast'
    )
    if (title.trim()) renameChat(chatId, title.trim().slice(0, 60))
  } catch {
    // не критично
  }
}
