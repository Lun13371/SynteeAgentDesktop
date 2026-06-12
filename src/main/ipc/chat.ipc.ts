import { ipcMain, BrowserWindow } from 'electron'
import { Worker } from 'worker_threads'
import * as path from 'path'
import type Store from 'electron-store'
import {
  createChat, getAllChats, getMessages, saveMessage,
  deleteChat, renameChat, pinMessage, unpinMessage, initDB,
  archiveChat, pinChat, setChatColor, duplicateChat, exportChat
} from '../../core/db/database'
import { getAllMemoriesForContext, extractMemoriesFromConversation, saveMemory } from '../../core/memory/MemoryEngine'
import { AIClient } from '../../core/ai/AIClient'
import { IPC_EVENTS } from '../../shared/constants'
import { v4 as uuid } from 'uuid'
import type { Message, AgentSettings } from '../../shared/types'

const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  approvalMode: 'ask',
  maxSteps: 8,
  enableTools: true,
  toolOutputMode: 'normal',
  enableThinking: false,
}

// Текущий воркер — terminate() убивает мгновенно
let currentWorker: Worker | null = null

export function registerChatIPC(store: Store, mainWindow: { getWindow: () => BrowserWindow | null }): void {
  initDB()

  // Системный промпт
  const getSystemPrompt = (): string => {
    const userName = store.get('userName') as string || ''
    const memoryContext = getAllMemoriesForContext()
    return `Ты Syntee — персональный AI-ассистент для Windows. Умный, дружелюбный, с лёгким юмором.
${userName ? `Пользователя зовут ${userName}. Обращайся к нему по имени.` : ''}
Отвечай на том же языке, на котором говорит пользователь.
Отвечай по умолчанию в среднем объёме — не слишком коротко и не слишком длинно.
Дата и время: ${new Date().toLocaleString('ru')}.
${memoryContext ? '\n' + memoryContext : ''}

## Форматирование ответов

**Диаграммы (Mermaid)** — для схем, графов, архитектуры, flowchart, sequence используй:
\`\`\`mermaid
flowchart TD
  A[Начало] --> B[Шаг]
\`\`\`
Поддерживаются типы: flowchart, sequenceDiagram, classDiagram, gantt, pie, gitGraph, erDiagram.

**Цветные блоки (Admonitions)** — для выделения важной информации:
:::note Заголовок (опционально)
Текст заметки
:::
Варианты: :::note :::tip :::warning :::danger :::info

**Diff блок** — для показа изменений кода:
\`\`\`diff
- удалённая строка
+ добавленная строка
  строка без изменений
\`\`\`

**Таблицы** — markdown таблицы для структурированных данных.
**Математика** — LaTeX: inline \`$E=mc^2$\`, блочный \`$$\\frac{a}{b}$$\`.
**Код** — всегда указывай язык: \`\`\`python, \`\`\`typescript, \`\`\`bash и т.д.`
  }

  // Создать чат
  ipcMain.handle('chat:create', (_, isIncognito = false) => {
    return createChat(isIncognito)
  })

  ipcMain.handle('chat:getAll', () => getAllChats())
  ipcMain.handle('chat:getMessages', (_, chatId: string) => getMessages(chatId))
  ipcMain.handle('chat:delete', (_, chatId: string) => deleteChat(chatId))
  ipcMain.handle('chat:rename', (_, chatId: string, title: string) => renameChat(chatId, title))
  ipcMain.handle('chat:pinMsg', (_, messageId: string) => pinMessage(messageId))
  ipcMain.handle('chat:unpinMsg', (_, messageId: string) => unpinMessage(messageId))

  // ── Отправить сообщение — через Worker Thread ──────────────────────────────
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

    const history = params.incognito ? [] : getMessages(params.chatId)
    const assistantMsgId = uuid()

    // Убиваем предыдущий воркер если есть
    if (currentWorker) {
      currentWorker.terminate()
      currentWorker = null
    }

    // Сериализуем store для передачи в worker (store не клонируется через structured clone)
    const storeData: Record<string, unknown> = {}
    const storeKeys = [
      'apiKey', 'apiEndpoint', 'providers', 'modelAssignments',
      'temperature', 'maxTokens', 'agentSettings', 'integrations',
      'voiceId', 'embeddingModel',
    ]
    for (const k of storeKeys) {
      const v = store.get(k)
      if (v !== undefined) storeData[k] = v
    }

    // Путь к worker — в dist/main/ после сборки
    const workerPath = path.join(__dirname, 'ai-worker.js')

    const worker = new Worker(workerPath, {
      workerData: { storeData },
    })
    currentWorker = worker

    // Слушаем сообщения от worker
    worker.on('message', (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case 'token':
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_TOKEN, {
            chatId: msg.chatId,
            msgId: msg.msgId,
            token: msg.token,
          })
          break

        case 'thinking_token':
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_TOKEN, {
            chatId: msg.chatId,
            msgId: msg.msgId,
            thinkingToken: msg.token,
          })
          break

        case 'thinking_done':
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_TOKEN, {
            chatId: msg.chatId,
            msgId: msg.msgId,
            thinkingDone: true,
            thinkingMs: msg.thinkingMs,
          })
          break

        case 'step':
          win?.webContents.send('agent:step', {
            ...(msg.step as object),
            msgId: msg.msgId,
          })
          break

        case 'rate_limit':
          win?.webContents.send(IPC_EVENTS.RATE_LIMIT, { waitSec: msg.waitSec })
          break

        case 'done': {
          // Worker завершился штатно — сохраняем и шлём DONE
          currentWorker = null

          const fullText = (msg.fullText as string) || ''
          const thinkingText = (msg.thinkingText as string) || undefined
          const thinkingMs = msg.thinkingMs as number | undefined
          const collectedSteps = (msg.collectedSteps as unknown[]) || []
          const incognito = msg.incognito as boolean

          const assistantMsg: Message = {
            id: assistantMsgId,
            chatId: params.chatId,
            role: 'assistant',
            content: fullText,
            createdAt: Date.now(),
            isPinned: 0,
            model: (storeData.modelAssignments as Array<{ role: string; modelId: string }> | undefined)
              ?.find(a => a.role === 'main')?.modelId || 'claude-sonnet-4-6',
            toolSteps: collectedSteps.length > 0 ? collectedSteps as never : undefined,
            thinking: thinkingText,
            thinkingMs,
          }

          if (!incognito) saveMessage(assistantMsg)
          if (!incognito) {
            const facts = extractMemoriesFromConversation(params.content, fullText)
            facts.forEach(f => saveMemory(f))
          }
          if (history.length === 0 && !incognito) {
            autoNameChat(params.chatId, params.content, store, win)
          }

          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_DONE, {
            chatId: params.chatId,
            msgId: assistantMsgId,
            message: assistantMsg,
          })
          break
        }

        case 'error':
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_ERROR, {
            chatId: msg.chatId,
            error: msg.error,
          })
          break
      }
    })

    worker.on('error', (err) => {
      console.error('[Worker] error:', err)
      currentWorker = null
      win?.webContents.send(IPC_EVENTS.CHAT_STREAM_ERROR, {
        chatId: params.chatId,
        error: err.message,
      })
    })

    worker.on('exit', (code) => {
      if (code !== 0 && currentWorker === worker) {
        // Воркер убит terminate() — сохраняем пустое сообщение если нужно
        currentWorker = null
      }
    })

    // Запускаем задачу в worker
    worker.postMessage({
      chatId: params.chatId,
      msgId: assistantMsgId,
      content: params.content,
      history: history.map(m => ({ role: m.role, content: m.content })),
      systemPrompt: getSystemPrompt(),
      enableTools: agentSettings.enableTools,
      incognito: !!params.incognito,
      agentSettings,
    })

    return userMsg
  })

  // ── Мгновенная остановка — terminate() убивает поток и все соединения ──────
  ipcMain.handle('chat:stop', () => {
    if (currentWorker) {
      // Перед terminate — говорим worker прислать finalize если успеет
      // Но terminate() мгновенный — сохранение делаем здесь по last known state
      currentWorker.terminate()
      currentWorker = null
    }
  })

  ipcMain.handle('chat:reloadClient', () => { /* no-op, worker создаётся свежий на каждый запрос */ })

  ipcMain.handle('chat:archive', (_, chatId: string, archived: boolean) => {
    archiveChat(chatId, archived)
    return getAllChats()
  })

  ipcMain.handle('chat:pinChat', (_, chatId: string, pinned: boolean) => {
    pinChat(chatId, pinned)
    return getAllChats()
  })

  ipcMain.handle('chat:setColor', (_, chatId: string, color: string | null) => {
    setChatColor(chatId, color)
  })

  ipcMain.handle('chat:duplicate', (_, chatId: string) => duplicateChat(chatId))

  ipcMain.handle('chat:export', (_, chatId: string, format: 'txt' | 'md') => exportChat(chatId, format))
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
