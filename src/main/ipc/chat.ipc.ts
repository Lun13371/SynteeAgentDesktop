import { ipcMain, BrowserWindow } from 'electron'
import type Store from 'electron-store'
import { AIClient } from '../../core/ai/AIClient'
import { Agent } from '../../core/agent/Agent'
import {
  createChat, getAllChats, getMessages, saveMessage,
  deleteChat, renameChat, pinMessage, unpinMessage, initDB,
  archiveChat, pinChat, setChatColor, duplicateChat, exportChat
} from '../../core/db/database'
import { getAllMemoriesForContext, extractMemoriesFromConversation, saveMemory } from '../../core/memory/MemoryEngine'
import { IPC_EVENTS } from '../../shared/constants'
import { v4 as uuid } from 'uuid'
import type { Message } from '../../shared/types'
import type { AgentSettings } from '../../shared/types'

const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  approvalMode: 'ask',
  maxSteps: 8,
  enableTools: true,
  toolOutputMode: 'normal',
}

let aiClient: AIClient

export function registerChatIPC(store: Store, mainWindow: { getWindow: () => BrowserWindow | null }): void {
  initDB()
  aiClient = new AIClient(store)

  // Системный промпт Syntee
  const getSystemPrompt = (): string => {
    const userName = store.get('userName') as string || ''
    const memoryContext = getAllMemoriesForContext()
    return `Ты Syntee — персональный AI-ассистент для Windows. Умный, дружелюбный, с лёгким юмором.
${userName ? `Пользователя зовут ${userName}. Обращайся к нему по имени.` : ''}
Отвечай на том же языке, на котором говорит пользователь.
Отвечай по умолчанию в среднем объёме — не слишком коротко и не слишком длинно.
Форматируй ответы с использованием Markdown когда это уместно.
Дата и время: ${new Date().toLocaleString('ru')}.
${memoryContext ? '\n' + memoryContext : ''}`
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
  ipcMain.handle('chat:pinMsg', (_, messageId: string) => pinMessage(messageId))
  ipcMain.handle('chat:unpinMsg', (_, messageId: string) => unpinMessage(messageId))

  // Отправить сообщение + стриминг ответа
  ipcMain.handle('chat:send', async (_, params: {
    chatId: string
    content: string
    incognito?: boolean
  }) => {
    const win = mainWindow.getWindow()
    const agentSettings = store.get('agentSettings', DEFAULT_AGENT_SETTINGS) as AgentSettings

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

    const assistantMsgId = uuid()
    let fullText = ''
    const collectedSteps: import('../../shared/types').ToolStep[] = []

    const finalize = () => {
      const assistantMsg: Message = {
        id: assistantMsgId,
        chatId: params.chatId,
        role: 'assistant',
        content: fullText,
        createdAt: Date.now(),
        isPinned: 0,
        model: store.get('mainModel') as string || 'claude-sonnet-4-6',
        toolSteps: collectedSteps.length > 0 ? collectedSteps : undefined,
      }
      if (!params.incognito) saveMessage(assistantMsg)
      if (!params.incognito) {
        const facts = extractMemoriesFromConversation(params.content, fullText)
        facts.forEach(f => saveMemory(f))
      }
      if (history.length === 0 && !params.incognito) {
        autoNameChat(params.chatId, params.content, store, win)
      }
      win?.webContents.send(IPC_EVENTS.CHAT_STREAM_DONE, {
        chatId: params.chatId,
        msgId: assistantMsgId,
        message: assistantMsg,
      })
    }

    // Если tools включены — запускаем через Agent
    if (agentSettings.enableTools && !params.incognito) {
      const agent = new Agent(store)

      const historyContext = history.slice(-10).map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n')
      const messageWithContext = historyContext
        ? `[Контекст разговора]\n${historyContext}\n\n[Новый вопрос]\n${params.content}`
        : params.content

      agent.run(messageWithContext, {
        onStep: (step) => {
          if (step.type === 'tool_call' || step.type === 'tool_result') {
            // Шаги НЕ идут в стрим-токены — только в agent:step и collectedSteps
            const ts: import('../../shared/types').ToolStep = {
              id: `${Date.now()}-${Math.random()}`,
              type: step.type,
              toolName: step.toolName,
              toolArgs: step.toolArgs,
              content: step.content,
              success: step.success,
              timestamp: Date.now(),
            }
            collectedSteps.push(ts)
            // Шлём в UI для live ToolChain
            win?.webContents.send('agent:step', { ...step, msgId: assistantMsgId })
          } else if (step.type === 'answer') {
            fullText = step.content
            win?.webContents.send(IPC_EVENTS.CHAT_STREAM_TOKEN, {
              chatId: params.chatId,
              msgId: assistantMsgId,
              token: step.content,
            })
          }
        },
        onDone: () => finalize(),
        onError: (err) => {
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_ERROR, {
            chatId: params.chatId,
            error: err.message,
          })
        },
        approvalMode: agentSettings.approvalMode,
        onConfirm: (toolName, args) => new Promise<boolean>((resolve) => {
          if (!win) return resolve(true)
          const reqId = `${Date.now()}-${Math.random()}`
          win.webContents.send('agent:confirm', { reqId, toolName, args })
          ipcMain.once(`agent:confirm:response:${reqId}`, (_, approved: boolean) => {
            resolve(approved)
          })
          setTimeout(() => resolve(false), 60_000)
        }),
      }, agentSettings.maxSteps)

      return { started: true }
    }

    // Обычный режим без tools — streamChat
    const contextMessages = history.slice(-20).map(m => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
    }))
    contextMessages.push({ role: 'user', content: params.content })

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
          // Используем локально накопленный текст — надёжнее чем text из onDone
          // (некоторые провайдеры возвращают пустую строку в финальном чанке)
          if (text && text.length > fullText.length) fullText = text
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

          // Автоэкстракция фактов из разговора
          if (!params.incognito) {
            const facts = extractMemoriesFromConversation(params.content, fullText)
            facts.forEach(f => saveMemory(f))
          }

          // Автоназвание чата после первого обмена
          if (history.length === 0 && !params.incognito) {
            autoNameChat(params.chatId, params.content, store, win)
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

  // Архивировать/разархивировать чат
  ipcMain.handle('chat:archive', (_, chatId: string, archived: boolean) => {
    archiveChat(chatId, archived)
    return getAllChats()
  })

  // Закрепить/открепить чат
  ipcMain.handle('chat:pinChat', (_, chatId: string, pinned: boolean) => {
    pinChat(chatId, pinned)
    return getAllChats()
  })

  // Цветная метка
  ipcMain.handle('chat:setColor', (_, chatId: string, color: string | null) => {
    setChatColor(chatId, color)
  })

  // Дублировать чат
  ipcMain.handle('chat:duplicate', (_, chatId: string) => {
    return duplicateChat(chatId)
  })

  // Экспорт чата
  ipcMain.handle('chat:export', (_, chatId: string, format: 'txt' | 'md') => {
    return exportChat(chatId, format)
  })

  // Слушаем chat:renamed чтобы фронт мог обновить список
  // (уже шлётся из autoNameChat напрямую в win)
}

// Авто-название чата через быструю модель
async function autoNameChat(chatId: string, firstMessage: string, store: Store, win?: BrowserWindow | null): Promise<void> {
  try {
    const client = new AIClient(store)
    const title = await client.complete(
      [{ role: 'user', content: `Придумай короткое название (3-5 слов) для чата, который начинается с этого сообщения: "${firstMessage.slice(0, 200)}". Ответь только названием без кавычек и лишних слов.` }],
      'fast'
    )
    const clean = title.trim().slice(0, 60)
    if (clean) {
      renameChat(chatId, clean)
      win?.webContents.send('chat:renamed', { chatId, title: clean })
    }
  } catch {
    // не критично
  }
}
