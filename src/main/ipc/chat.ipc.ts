import { ipcMain, BrowserWindow } from 'electron'
import { Worker } from 'worker_threads'
import * as path from 'path'
import type Store from 'electron-store'
import { agentManager } from '../AgentManager'
import {
  createChat, getAllChats, getMessages, saveMessage,
  deleteChat, renameChat, pinMessage, unpinMessage, initDB,
  archiveChat, pinChat, setChatColor, duplicateChat, exportChat
} from '../../core/db/database'
import { getAllMemoriesForContext, extractMemoriesFromConversation, saveMemory } from '../../core/memory/MemoryEngine'
import { buildSystemPrompt } from '../../core/prompts/buildSystemPrompt'
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

  let currentChatIdForStop: string | null = null  // запоминаем chatId текущего запроса для stop

  // Системный промпт
  const getSystemPrompt = (): string => {
    const userName = store.get('userName') as string || ''
    let memoryContext = ''
    try { memoryContext = getAllMemoriesForContext() } catch { /* ok */ }
    return buildSystemPrompt({ userName, memoryContext })
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
    displayContent?: string
    slashCommand?: { name: string; args: string }
    incognito?: boolean
  }) => {
    const win = mainWindow.getWindow()
    currentChatIdForStop = params.chatId
    const agentSettings = store.get('agentSettings', DEFAULT_AGENT_SETTINGS) as AgentSettings

    // Сохраняем сообщение пользователя
    // displayContent — что видит пользователь (команда), content — что уходит в AI
    const userMsg: Message = {
      id: uuid(),
      chatId: params.chatId,
      role: 'user',
      content: params.displayContent ?? params.content,
      createdAt: Date.now(),
      isPinned: 0,
      slashCommand: params.slashCommand,
    }
    if (!params.incognito) saveMessage(userMsg)

    const history = params.incognito ? [] : getMessages(params.chatId)
    const assistantMsgId = uuid()

    // Убиваем предыдущий воркер если есть
    if (currentWorker) {
      currentWorker.terminate()
      currentWorker = null
    }

    // Сериализуем store для передачи в worker
    const storeData: Record<string, unknown> = {}
    const storeKeys = [
      'apiKey', 'apiEndpoint', 'providers', 'modelAssignments',
      'temperature', 'maxTokens', 'agentSettings', 'integrations',
      'voiceId', 'embeddingModel',
      'imageProviderId', 'imageModelId', 'imageDefaultSize', 'imageDefaultQuality',
    ]
    for (const k of storeKeys) {
      const v = store.get(k)
      if (v !== undefined) storeData[k] = v
    }

    // Буфер токенов в main — для сохранения при внезапном terminate()
    let bufferedText = ''
    let bufferedThinking = ''
    let bufferedThinkingMs: number | undefined
    const bufferedSteps: unknown[] = []
    let doneSent = false  // флаг чтобы не слать DONE дважды

    const sendDone = (fullText: string, thinkingText?: string, thinkingMs?: number, steps?: unknown[]) => {
      if (doneSent) {
        console.log('[sendDone] skipped — already sent')
        return
      }
      doneSent = true
      console.log('[sendDone] sending CHAT_STREAM_DONE, fullText length:', fullText.length)
      currentWorker = null

      const assistantMsg: Message = {
        id: assistantMsgId,
        chatId: params.chatId,
        role: 'assistant',
        content: fullText,
        createdAt: Date.now(),
        isPinned: 0,
        model: (storeData.modelAssignments as Array<{ role: string; modelId: string }> | undefined)
          ?.find(a => a.role === 'main')?.modelId || 'claude-sonnet-4-6',
        toolSteps: steps && steps.length > 0 ? steps as never : undefined,
        thinking: thinkingText || undefined,
        thinkingMs,
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

    const workerPath = path.join(__dirname, 'ai-worker.js')
    const worker = new Worker(workerPath, { workerData: { storeData } })
    currentWorker = worker

    worker.on('message', (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case 'token':
          bufferedText += (msg.token as string) || ''
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_TOKEN, {
            chatId: msg.chatId, msgId: msg.msgId, token: msg.token,
          })
          break
        case 'thinking_token': {
          const tok = typeof msg.token === 'string' ? msg.token : ''
          bufferedThinking += tok
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_TOKEN, {
            chatId: msg.chatId, msgId: msg.msgId, thinkingToken: tok,
          })
          break
        }

        case 'thinking_done':
          bufferedThinkingMs = msg.thinkingMs as number
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_TOKEN, {
            chatId: msg.chatId, msgId: msg.msgId,
            thinkingDone: true, thinkingMs: msg.thinkingMs,
          })
          break

        case 'step':
          bufferedSteps.push(msg.step)
          win?.webContents.send('agent:step', { ...(msg.step as object), msgId: msg.msgId })
          break

        case 'spawn_agent': {
          // Worker хочет запустить суб-агента — делаем через AgentManager
          ;(async () => {
            const spawnResult = await agentManager.spawn({
              id: msg.id as string,
              parentId: msg.msgId as string,
              chatId: msg.chatId as string,
              task: msg.task as string,
              parallel: !!(msg.parallel),
              model: msg.model as string | undefined,
              storeData,
            })
            worker.postMessage({
              type: 'spawn_agent_reply',
              replyId: msg.replyId,
              summary: spawnResult.summary,
              error: spawnResult.error,
            })
          })()
          break
        }

        case 'get_agent_status': {
          const record = agentManager.get(msg.agent_id as string)
          worker.postMessage({
            type: 'get_agent_status_reply',
            replyId: msg.replyId,
            status: record ? {
              status: record.status,
              stepsCount: record.steps.length,
              currentStep: record.steps.length > 0
                ? record.steps[record.steps.length - 1].content?.slice(0, 80)
                : undefined,
            } : null,
          })
          break
        }

        case 'wait_agents': {
          // Ждём пока все агенты завершатся (polling с timeout 5 мин)
          ;(async () => {
            const agentIds = msg.agentIds as string[]
            const TIMEOUT = 5 * 60 * 1000
            const POLL_INTERVAL = 1000
            const start = Date.now()
            while (Date.now() - start < TIMEOUT) {
              const records = agentIds.map(id => agentManager.get(id))
              const allDone = records.every(r => r && (r.status === 'done' || r.status === 'error' || r.status === 'cancelled'))
              if (allDone) {
                // Шлём обновления статусов обратно в worker
                agentIds.forEach(id => {
                  const r = agentManager.get(id)
                  if (r) worker.postMessage({ type: 'agent_status_update', agentId: id, statusData: { status: r.status, stepsCount: r.steps.length } })
                })
                worker.postMessage({
                  type: 'wait_agents_reply',
                  replyId: msg.replyId,
                  results: records.map(r => ({ summary: r?.result ?? '', error: r?.error })),
                })
                return
              }
              // Шлём промежуточные статусы
              agentIds.forEach(id => {
                const r = agentManager.get(id)
                if (r) worker.postMessage({ type: 'agent_status_update', agentId: id, statusData: { status: r.status, stepsCount: r.steps.length, currentStep: r.steps.at(-1)?.content?.slice(0, 80) } })
              })
              await new Promise(r => setTimeout(r, POLL_INTERVAL))
            }
            // Timeout — возвращаем что есть
            worker.postMessage({
              type: 'wait_agents_reply',
              replyId: msg.replyId,
              results: agentIds.map(id => {
                const r = agentManager.get(id)
                return { summary: r?.result ?? '', error: r?.status !== 'done' ? `Таймаут (${r?.status})` : undefined }
              }),
            })
          })()
          break
        }

        case 'rate_limit':
          win?.webContents.send(IPC_EVENTS.RATE_LIMIT, { waitSec: msg.waitSec })
          break

        case 'done':
          sendDone(
            (msg.fullText as string) || bufferedText,
            (msg.thinkingText as string) || bufferedThinking || undefined,
            (msg.thinkingMs as number) || bufferedThinkingMs,
            (msg.collectedSteps as unknown[]) || bufferedSteps,
          )
          break

        case 'error':
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_ERROR, {
            chatId: msg.chatId, error: msg.error,
          })
          break
      }
    })

    worker.on('error', (err) => {
      console.error('[Worker] error:', err)
      // Ошибка воркера — финализируем с буфером
      sendDone(bufferedText, bufferedThinking, bufferedThinkingMs, bufferedSteps)
      win?.webContents.send(IPC_EVENTS.CHAT_STREAM_ERROR, {
        chatId: params.chatId, error: err.message,
      })
    })

    worker.on('exit', () => {
      // Вызывается при terminate() или нормальном выходе
      // sendDone игнорирует второй вызов через doneSent флаг
      sendDone(bufferedText, bufferedThinking, bufferedThinkingMs, bufferedSteps)
    })

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
    // Сообщаем renderer что стриминг завершён — иначе isTyping остаётся true
    const win = mainWindow.getWindow()
    if (win && currentChatIdForStop) {
      win.webContents.send(IPC_EVENTS.CHAT_STREAM_ERROR, {
        chatId: currentChatIdForStop,
        error: 'stopped',
      })
    }
    currentChatIdForStop = null
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
