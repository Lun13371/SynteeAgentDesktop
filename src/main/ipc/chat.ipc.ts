import { ipcMain, BrowserWindow } from 'electron'
import { Worker } from 'worker_threads'
import * as path from 'path'
import type Store from 'electron-store'
import { agentManager } from '../AgentManager'
import {
  createChat, getAllChats, getMessages, saveMessage,
  deleteChat, renameChat, pinMessage, unpinMessage, initDB,
  archiveChat, pinChat, setChatColor, duplicateChat, exportChat,
  getWorkingMemory, setWorkingMemory,
} from '../../core/db/database'
import { getAllMemoriesForContext, extractMemoriesFromConversation, saveMemory } from '../../core/memory/MemoryEngine'
import { buildSystemPrompt } from '../../core/prompts/buildSystemPrompt'
import { AIClient } from '../../core/ai/AIClient'
import { IPC_EVENTS } from '../../shared/constants'
import { v4 as uuid } from 'uuid'
import {
  applyRollingWindowAsync, calcTokenUsage, getContextSettings, estimateTokens,
  getModelContextWindow,
  type ChatMessage,
} from '../../core/context/contextManager'
import type { Message, AgentSettings } from '../../shared/types'

const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  approvalMode: 'ask',
  maxSteps: 8,
  toolOutputMode: 'normal',
  enableThinking: false,
}

// Текущий воркер — terminate() убивает мгновенно
let currentWorker: Worker | null = null

export function registerChatIPC(store: Store, mainWindow: { getWindow: () => BrowserWindow | null }): void {
  initDB()

  let currentChatIdForStop: string | null = null
  let bufferedText = ''
  let bufferedThinking = ''
  let bufferedThinkingMs: number | undefined
  let bufferedSteps: unknown[] = []
  let currentSendDone: ((fullText: string, thinkingText?: string, thinkingMs?: number, steps?: unknown[]) => void) | null = null

  // Системный промпт с рабочей памятью
  const getSystemPrompt = (chatId?: string): string => {
    const userName = store.get('userName') as string || ''
    let memoryContext = ''
    let workingMemory = ''
    try { memoryContext = getAllMemoriesForContext() } catch { /* ok */ }
    try { if (chatId) workingMemory = getWorkingMemory(chatId) } catch { /* ok */ }
    return buildSystemPrompt({ userName, memoryContext, workingMemory })
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
    userMsgId?: string
    planningMode?: boolean
  }) => {
    const win = mainWindow.getWindow()
    currentChatIdForStop = params.chatId

    // Сбрасываем буферы для нового запроса
    bufferedText = ''
    bufferedThinking = ''
    bufferedThinkingMs = undefined
    bufferedSteps = []

    const agentSettings = store.get('agentSettings', DEFAULT_AGENT_SETTINGS) as AgentSettings

    // Сохраняем сообщение пользователя
    // displayContent — что видит пользователь (команда), content — что уходит в AI
    const userMsg: Message = {
      id: params.userMsgId ?? uuid(),  // используем id от renderer если передан
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
      ;(currentWorker as unknown as { _terminated?: boolean })._terminated = true
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
      'contextSettings',
    ]
    for (const k of storeKeys) {
      const v = store.get(k)
      if (v !== undefined) storeData[k] = v
    }

    // ── Context management ─────────────────────────────────────────────────
    const ctxSettings = getContextSettings(storeData)
    const rawHistory: ChatMessage[] = history.map(m => {
      if (m.planData) {
        return {
          role: m.role as ChatMessage['role'],
          content: `[ПЛАН: "${m.planData.title}"]\n${m.planData.content}\n[Файл: ${m.planData.filePath}]`,
        }
      }
      return { role: m.role as ChatMessage['role'], content: m.content }
    })

    // ── Compressed tool history — настраиваемое кол-во сессий ────────────────
    if (!params.incognito) {
      try {
        const allMsgs = getMessages(params.chatId)
        const toolMsgs = allMsgs
          .filter(m => m.role === 'assistant' && m.toolSteps && (m.toolSteps as unknown[]).length > 0)
          .slice(-ctxSettings.toolHistorySessions)  // настраиваемое кол-во сессий

        const compressedToolHistory: ChatMessage[] = []
        for (const m of toolMsgs) {
          const steps = (m.toolSteps ?? []) as Array<{ type: string; toolName?: string; content?: string }>
          const calls = steps.filter(s => s.type === 'tool_call')
          const results = steps.filter(s => s.type === 'tool_result')
          if (calls.length === 0) continue

          const summary = calls.map((c, i) => {
            const r = results[i]
            const maxChars = ctxSettings.toolHistoryChars  // настраиваемый размер
            const resultShort = r?.content ? r.content.slice(0, maxChars) + (r.content.length > maxChars ? '…' : '') : '(нет результата)'
            return `[${c.toolName}] → ${resultShort}`
          }).join('\n')

          compressedToolHistory.push({ role: 'assistant', content: `[Предыдущие действия агента]\n${summary}` })
        }

        if (compressedToolHistory.length > 0) {
          console.log('[chat.ipc] injecting tool history:', compressedToolHistory.length, 'sessions')
          rawHistory.unshift(...compressedToolHistory)
        }
      } catch (e) {
        console.warn('[chat.ipc] compressed tool history error:', e)
      }
    }

    // ── Project Index — авточтение AGENTS.md/package.json при старте ──────────
    if (!params.incognito && ctxSettings.projectIndexEnabled) {
      try {
        const fs = await import('fs')
        const path = await import('path')
        const cwd = process.cwd()
        const candidates = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', 'README.md']
        let projectIndex = ''

        for (const file of candidates) {
          const full = path.join(cwd, file)
          if (fs.existsSync(full)) {
            const content = fs.readFileSync(full, 'utf-8').slice(0, 2000)
            projectIndex += `\n### ${file}\n${content}\n`
            console.log('[chat.ipc] project index loaded:', file)
            break  // берём первый найденный
          }
        }

        // package.json — всегда добавляем если есть
        const pkgPath = path.join(cwd, 'package.json')
        if (fs.existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
            projectIndex += `\n### package.json\nname: ${pkg.name}, version: ${pkg.version}\ndeps: ${Object.keys(pkg.dependencies ?? {}).slice(0, 15).join(', ')}\n`
          } catch { /* ok */ }
        }

        if (projectIndex) {
          rawHistory.unshift({ role: 'system', content: `## Контекст проекта\n${projectIndex.trim()}` })
        }
      } catch (e) {
        console.warn('[chat.ipc] project index error:', e)
      }
    }

    let processedHistory = rawHistory
    let contextCompressed = false
    if (ctxSettings.rollingEnabled && rawHistory.length > 0) {
      // AI-резюме через fast модель (haiku/flash) — fallback на обрезку если не работает
      const summaryFn = async (prompt: string): Promise<string> => {
        const aiClient = new AIClient(store)
        let result = ''
        await aiClient.streamChat(
          [{ role: 'user', content: prompt }],
          { onToken: (t) => { result += t }, onDone: () => {}, onError: () => {} },
          'fast',
        )
        return result
      }
      const result = await applyRollingWindowAsync(rawHistory, ctxSettings, summaryFn)
      if (result.compressed) {
        processedHistory = result.messages
        contextCompressed = true
      }
    }

    if (ctxSettings.tokenCounterEnabled) {
      // Получаем реальный contextWindow активной модели из провайдера
      const contextWindow = getModelContextWindow(storeData)
      // Строим systemPrompt для точного подсчёта его токенов
      const sysPrompt = getSystemPrompt(params.chatId)
      const currentMsgTokens = estimateTokens(params.content)
      const usage = calcTokenUsage(processedHistory, contextWindow, {
        systemPrompt: sysPrompt,
        currentMsgTokens,
        includeToolSchemas: true,
      })
      win?.webContents.send(IPC_EVENTS.CONTEXT_USAGE, {
        pct: usage.pct,
        estimated: usage.estimated,
        limit: usage.limit,
        status: usage.status,
        compressed: contextCompressed,
        breakdown: {
          history: usage.historyTokens,
          system: usage.systemPromptTokens,
          tools: usage.toolSchemasTokens,
          current: usage.currentMsgTokens,
        },
      })
    }
    // ──────────────────────────────────────────────────────────────────────

    // Буфер токенов в main — для сохранения при внезапном terminate()
    let doneSent = false
    let pendingPlan: { title: string; content: string; summary: string; filePath: string } | undefined  // флаг чтобы не слать DONE дважды

    const sendDone = (fullText: string, thinkingText?: string, thinkingMs?: number, steps?: unknown[], iters?: unknown[]) => {
      if (doneSent) return
      doneSent = true
      currentSendDone = null
      currentWorker = null

      const assistantMsg: Message & { iterations?: unknown } = {
        id: assistantMsgId,
        chatId: params.chatId,
        role: 'assistant',
        content: fullText,
        createdAt: Date.now(),
        isPinned: 0,
        model: (storeData.modelAssignments as Array<{ role: string; modelId: string }> | undefined)
          ?.find(a => a.role === 'main')?.modelId || 'claude-sonnet-4-6',
        toolSteps: steps && steps.length > 0 ? steps as never : undefined,
        iterations: iters && iters.length > 0 ? iters as never : undefined,
        thinking: thinkingText || undefined,
        thinkingMs,
        planData: pendingPlan,
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
    currentSendDone = sendDone

    const workerPath = path.join(__dirname, 'ai-worker.js')
    // Передаём workingMemory в воркер чтобы onGetWorkingMemory мог его прочитать синхронно
    let currentWorkingMemory = ''
    try { currentWorkingMemory = getWorkingMemory(params.chatId) } catch { /* ok */ }
    const worker = new Worker(workerPath, {
      workerData: { storeData, planningMode: params.planningMode ?? false, workingMemory: currentWorkingMemory },
      env: process.env
    })
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

        case 'confirm': {
          const { reqId, toolName, args } = msg as { reqId: string; toolName: string; args: Record<string, unknown> }
          // Сначала регистрируем listener — до отправки в renderer, чтобы не пропустить быстрый ответ
          ipcMain.once(`agent:confirm:response:${reqId}`, (_, approved: boolean) => {
            worker.postMessage({ type: 'confirm_reply', replyId: `confirm-reply-${reqId}`, approved })
          })
          // Потом шлём в renderer — показываем диалог
          win?.webContents.send('agent:confirm', { reqId, toolName, args })
          break
        }

        case 'agent_status':
          win?.webContents.send('agent:status', { msgId: msg.msgId, chatId: msg.chatId, text: msg.text })
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

        case 'update_working_memory': {
          const { chatId: wChatId, content: wContent, mode: wMode } = msg as { chatId: string; content: string; mode: 'replace' | 'append' }
          try {
            if (wMode === 'append') {
              const existing = getWorkingMemory(wChatId)
              setWorkingMemory(wChatId, existing ? existing + '\n' + wContent : wContent)
            } else {
              setWorkingMemory(wChatId, wContent)
            }
          } catch { /* ok */ }
          break
        }

        case 'context_usage':
          win?.webContents.send(IPC_EVENTS.CONTEXT_USAGE, {
            pct: msg.pct,
            estimated: msg.estimated,
            limit: msg.limit,
            status: msg.status,
            compressed: contextCompressed,
            breakdown: msg.breakdown,
          })
          break

        case 'done':
          sendDone(
            (msg.fullText as string) || bufferedText,
            (msg.thinkingText as string) || bufferedThinking || undefined,
            (msg.thinkingMs as number) || bufferedThinkingMs,
            (msg.collectedSteps as unknown[]) || bufferedSteps,
            (msg.collectedIters as unknown[]) || undefined,
          )
          break

        case 'plan_saved':
          pendingPlan = msg.plan as { title: string; content: string; summary: string; filePath: string }
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

    let terminated = false  // флаг намеренного terminate — не вызывать sendDone

    worker.on('exit', () => {
      // exit может прийти раньше последнего message('done') в event loop
      // setImmediate даёт обработать все pending message события сначала
      setImmediate(() => {
        const wasTerminated = terminated || !!(worker as unknown as { _terminated?: boolean })._terminated
        if (!wasTerminated) {
          sendDone(bufferedText, bufferedThinking, bufferedThinkingMs, bufferedSteps)
        }
      })
    })

    worker.postMessage({
      chatId: params.chatId,
      msgId: assistantMsgId,
      content: params.content,
      history: processedHistory,
      systemPrompt: getSystemPrompt(params.chatId),
      enableTools: true,
      incognito: !!params.incognito,
      agentSettings,
    })

    return { userMsg, assistantMsgId }
  })

  // ── Мгновенная остановка — terminate() убивает поток и все соединения ──────
  ipcMain.handle('chat:stop', () => {
    if (currentWorker) {
      ;(currentWorker as unknown as { _terminated?: boolean })._terminated = true
      currentWorker.terminate()
      currentWorker = null
    }
    const win = mainWindow.getWindow()
    if (win && currentChatIdForStop) {
      // Сохраняем то что успело накопиться в буфере
      currentSendDone?.(bufferedText, bufferedThinking, bufferedThinkingMs, bufferedSteps)
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
