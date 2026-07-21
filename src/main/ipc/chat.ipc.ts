import { ipcMain, BrowserWindow, app, dialog } from 'electron'
import { Worker } from 'worker_threads'
import * as path from 'path'
import type Store from 'electron-store'
import { agentManager } from '../AgentManager'
import {
  createChat, getAllChats, getMessages, saveMessage,
  deleteChat, renameChat, pinMessage, unpinMessage, initDB,
  archiveChat, pinChat, setChatColor, duplicateChat, exportChat,
  getWorkingMemory, setWorkingMemory, getChatSummary, setChatSummary,
  getChatMode, getChatWorkdirContext,
  createProject, getAllProjects, renameProject, deleteProject, getProjectById, touchProject,
  setProjectVerificationCommand,
} from '../../core/db/database'
import { getAllMemoriesForContext, extractMemoriesFromConversation, saveMemory } from '../../core/memory/MemoryEngine'
import { buildSystemPrompt } from '../../core/prompts/buildSystemPrompt'
import { AIClient } from '../../core/ai/AIClient'
import { getToolSchemas, analyzeProject } from '../../core/tools'
import { IPC_EVENTS } from '../../shared/constants'
import { v4 as uuid } from 'uuid'
import {
  applyRollingWindowAsync, getContextSettings, estimateTokens,
  getModelContextWindow,
  type ChatMessage,
} from '../../core/context/contextManager'
import { buildSnapshotFromEstimate, getSessionCost } from '../../core/tokens/usageTracker'
import { getFileCacheSnapshot, mergeFileCache, clearFileCache } from '../../core/context/fileReadCache'
import { shellSessionManager } from '../ShellSessionManager'
import { log } from '../../core/logger'
import type { Message, AgentSettings, ChatMode, QueueItemMeta } from '../../shared/types'

const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  approvalMode: 'ask',
  maxSteps: 32,
  toolOutputMode: 'normal',
  enableThinking: false,
  maxParallelSubAgents: 3,
  readFileCache: true,
  autoMemoryInterval: 5,
  maxRepeatedToolCalls: 3,
  maxRepeatedErrors: 2,
}

/**
 * Состояние одного активного запуска chat:send.
 *
 * Раньше эти буферы были module-scoped и разделялись между ВСЕМИ вызовами
 * chat:send — из-за этого новый send обнулял буферы (chat.ipc.ts:165-168)
 * ДО того, как убивал старый воркер (184-188), и весь накопленный старым
 * прогоном контекст терялся безвозвратно (worker.terminate() рвёт поток
 * мгновенно, единственная точка персистентности — sendDone → saveMessage).
 *
 * Теперь каждый запуск держит свой собственный экземпляр ActiveRun, а
 * module-level `activeRuns` — это Map по chatId. Несколько чатов могут
 * работать параллельно, каждый со своим воркером и буферами. В пределах
 * одного chatId запуски сериализуются через chatQueues (FIFO).
 */
interface ActiveRun {
  worker: Worker
  chatId: string
  msgId: string
  bufferedText: string
  bufferedThinking: string
  bufferedThinkingMs?: number
  bufferedSteps: unknown[]
  bufferedIters: unknown[]
  bufferedTodo: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>
  bufferedAgentStatus: string | null
  bufferedRateLimitSec: number
  doneSent: boolean
  sendDone: (fullText: string, thinkingText?: string, thinkingMs?: number, steps?: unknown[], iters?: unknown[], todo?: unknown[]) => void
}

const activeRuns = new Map<string, ActiveRun>()
// Метаданные активного запуска для UI очереди (preview/userMsgId/startedAt).
// Дублирует часть ActiveRun, но хранится отдельно — т.к. ActiveRun содержит
// тяжёлые буферы токенов/шагов, а meta нужна для лёгкого снапшота в renderer.
const activeRunMeta = new Map<string, QueueItemMeta>()

// FIFO-очередь запусков на один chatId. Новый chat:send в чат, где уже
// работает воркер, ставится в очередь и стартует после завершения старого.
// Каждый элемент хранит meta (queueId/msgId/preview/...) для отображения
// в UI панели очереди и управления (cancel/reorder/remove).
interface QueuedSend {
  run: () => Promise<void>
  meta: QueueItemMeta
}
const chatQueues = new Map<string, Array<QueuedSend>>()

function emitRunStatus(
  win: BrowserWindow | null,
  chatId: string,
  status: 'running' | 'done' | 'error' | 'cancelled' | 'queued',
  msgId?: string,
  error?: string,
) {
  win?.webContents.send(IPC_EVENTS.CHAT_RUN_STATUS, { chatId, status, msgId, error, ts: Date.now() })
}

/**
 * Эмитит снапшот текущей очереди chatId для UI (список ожидающих запросов).
 * Вызывается при любом изменении: добавлении, удалении, reorder, drain.
 */
function emitQueueUpdate(win: BrowserWindow | null, chatId: string) {
  const q = chatQueues.get(chatId) ?? []
  const queue = q.map(item => item.meta)
  win?.webContents.send(IPC_EVENTS.CHAT_QUEUE_UPDATED, { chatId, queue, ts: Date.now() })
}

/**
 * Запускает следующий chat:send из очереди chatId, если он есть.
 * Вызывается после терминального статуса предыдущего запуска (done/error/cancelled).
 */
function drainQueue(win: BrowserWindow | null, chatId: string) {
  const q = chatQueues.get(chatId)
  if (!q || q.length === 0) {
    chatQueues.delete(chatId)
    emitQueueUpdate(win, chatId)
    return
  }
  const next = q.shift()!
  // Переносим meta из очереди в activeRunMeta — запрос стартовал.
  // Добавляем startedAt для UI (отображение длительности выполнения).
  activeRunMeta.set(chatId, { ...next.meta, startedAt: Date.now() })
  emitQueueUpdate(win, chatId)
  // Асинхронный запуск — ошибки внутри run() обрабатываются им самим.
  void next.run().catch((e) => {
    log('[chat:send] queued run failed chatId=%s: %s', chatId, (e as Error).message)
  })
}

/**
 * Разворачивает Message с toolSteps в массив полноценных OpenAI-совместимых
 * сообщений: assistant (с tool_calls) + tool (с результатами).
 *
 * Раньше toolSteps сжимались в компактный текстовый trace (400 симв. на шаг),
 * из-за чего агент терял результаты предыдущих tool-вызовов (содержимое
 * файлов, результаты команд) и был вынужден перечитывать всё заново.
 * Теперь полная история tool-вызовов передаётся в нативном формате API.
 */
function messageToContextMessages(message: Message): ChatMessage[] {
  // План — как раньше, просто текст
  if (message.planData) {
    return [{
      role: message.role as ChatMessage['role'],
      content: `[ПЛАН: "${message.planData.title}"]\n${message.planData.content}\n[Файл: ${message.planData.filePath}]`,
    }]
  }

  const steps = message.toolSteps ?? []

  // Нет toolSteps — обычное текстовое сообщение
  if (message.role !== 'assistant' || steps.length === 0) {
    // Даже для текстового сообщения без toolSteps — если есть todo,
    // инжектим его (user-роль, после assistant) чтобы AI видел свой
    // незавершённый план из прошлой итерации. Без этого AI не знает
    // что todo сохраняется между сообщениями и не может продолжить.
    if (message.role === 'assistant' && message.todo?.length) {
      return [
        { role: 'assistant' as const, content: message.content },
        { role: 'user' as const, content: formatTodoForContext(message.todo) },
      ]
    }
    return [{ role: message.role as ChatMessage['role'], content: message.content }]
  }

  // Группируем steps по итерациям: каждая итерация = assistant с tool_calls
  // + последующие tool results. Сохраняем текст между итерациями.
  type Iteration = {
    textBefore?: string
    calls: Array<{ callId: string; toolName: string; toolArgs: Record<string, unknown> }>
    results: Map<string, { content: string; success?: boolean; toolName?: string }>
  }

  const iterations: Iteration[] = []
  let currentIter: Iteration | null = null
  let pendingCall: { callId: string; toolName: string; toolArgs: Record<string, unknown> } | null = null

  for (const step of steps) {
    if (step.type === 'tool_call') {
      if (!currentIter || currentIter.calls.length > 0 || currentIter.results.size > 0) {
        // Новая итерация
        currentIter = { calls: [], results: new Map() }
        iterations.push(currentIter)
      }
      const callId = step.callId || `call_${iterations.length}_${currentIter.calls.length}`
      currentIter.calls.push({
        callId,
        toolName: step.toolName || 'tool',
        toolArgs: step.toolArgs || {},
      })
      pendingCall = { callId, toolName: step.toolName || 'tool', toolArgs: step.toolArgs || {} }
    } else if (step.type === 'tool_result') {
      if (!currentIter) {
        currentIter = { calls: [], results: new Map() }
        iterations.push(currentIter)
      }
      const callId = step.callId || pendingCall?.callId || `call_${iterations.length}_${currentIter.results.size}`
      currentIter.results.set(callId, {
        content: step.content || '',
        success: step.success,
        toolName: step.toolName || pendingCall?.toolName,
      })
      pendingCall = null
    }
  }

  // Если итераций нет — просто текст (но мог быть todo)
  if (iterations.length === 0) {
    if (message.todo?.length) {
      return [
        { role: 'assistant' as const, content: message.content },
        { role: 'user' as const, content: formatTodoForContext(message.todo) },
      ]
    }
    return [{ role: 'assistant', content: message.content }]
  }

  // Если есть content до первой итерации и он непустой — добавляем как отдельное сообщение
  const result: ChatMessage[] = []
  const contentBefore = message.content || ''
  const hasContentBefore = contentBefore.trim().length > 0

  for (let i = 0; i < iterations.length; i++) {
    const iter = iterations[i]

    // Assistant сообщение с tool_calls (включает текст ответа перед тулаами)
    const assistantContent = (i === 0 && hasContentBefore) ? contentBefore : ''
    const toolCalls = iter.calls.map(c => ({
      id: c.callId,
      type: 'function' as const,
      function: {
        name: c.toolName,
        arguments: JSON.stringify(c.toolArgs),
      },
    }))

    result.push({
      role: 'assistant',
      content: assistantContent,
      tool_calls: toolCalls,
    })

    // Tool результаты для каждого call
    for (const call of iter.calls) {
      const toolResult = iter.results.get(call.callId)
      result.push({
        role: 'tool',
        content: toolResult?.content ?? '',
        tool_call_id: call.callId,
        name: call.toolName,
      })
    }
  }

  // Если у assistant-сообщения есть todo — добавляем user-напоминание
  // ПОСЛЕ всей цепочки assistant(tool_calls)→tool results. User-роль
  // работает со всеми провайдерами (system в середине некоторые
  // прокси отбрасывают). AI видит свой незавершённый план и может
  // продолжить работу по нему в следующем ответе.
  if (message.role === 'assistant' && message.todo?.length) {
    result.push({ role: 'user' as const, content: formatTodoForContext(message.todo) })
  }

  return result
}

// Форматирует todo-список для инжекции в контекст истории.
// Используется в messageToContextMessages — AI видит это как user-сообщение
// после своего прошлого ответа, чтобы понимать что осталось сделать.
function formatTodoForContext(todo: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>): string {
  const lines = todo.map(t => {
    const mark = t.status === 'done' ? '[x]'
      : t.status === 'in_progress' ? '[~]'
      : t.status === 'skipped' ? '[-]'
      : '[ ]'
    return `${mark} ${t.text}`
  })
  const unfinished = todo.filter(t => t.status === 'pending' || t.status === 'in_progress').length
  const suffix = unfinished > 0
    ? `\n\nЭто твой незавершённый план из предыдущего ответа (${unfinished} пункт(ов) осталось). Продолжи работу по нему — не создавай новый план, если этот ещё актуален.`
    : '\n\nЭто твой завершённый план из предыдущего ответа (все пункты выполнены).'
  return `[АКТУАЛЬНЫЙ ПЛАН ЗАДАЧИ — состояние на момент предыдущего сообщения]\n${lines.join('\n')}${suffix}`
}

export function registerChatIPC(store: Store, mainWindow: { getWindow: () => BrowserWindow | null }): void {
  initDB()

  const getSystemPrompt = (chatId?: string): string => {
    const userName = store.get('userName') as string || ''
    let memoryContext = ''
    let workingMemory = ''
    let summary = ''
    let workdir: string | undefined
    let projectContext: string | undefined
    try { memoryContext = getAllMemoriesForContext() } catch { /* ok */ }
    try { if (chatId) workingMemory = getWorkingMemory(chatId) } catch { /* ok */ }
    try { if (chatId) summary = getChatSummary(chatId) } catch { /* ok */ }
    try {
      if (chatId) {
        const wctx = getChatWorkdirContext(chatId)
        workdir = wctx.workdir
        projectContext = wctx.projectContext
      }
    } catch { /* ok */ }

    const mergedWorkingMemory = summary
      ? `${workingMemory ? workingMemory + '\n\n' : ''}## Сжатое резюме предыдущего контекста\n${summary}`
      : workingMemory

    // Глобальный system prompt из Настройки → AI → Параметры (или /sys команды)
    const customSystemPrompt = (store.get('modelParams') as { systemPrompt?: string } | undefined)?.systemPrompt

    return buildSystemPrompt({ userName, memoryContext, workingMemory: mergedWorkingMemory, customSystemPrompt, workdir, projectContext })
  }

  /**
   * Реальный запуск воркера для chat:send. Вынесено из ipcMain.handle чтобы
   *  можно было ставить запросы в очередь на один chatId (если воркер уже
   *  работает) и вызывать drainQueue после терминального статуса.
   *
   *  Все ссылки на глобальные синглтоны (activeRuns, chatQueues) — module-level.
   *  store / mainWindow / getSystemPrompt — из замыкания registerChatIPC.
   */
  async function runChatSend(
    params: {
      chatId: string
      content: string
      displayContent?: string
      slashCommand?: { name: string; args: string }
      incognito?: boolean
      userMsgId?: string
      planningMode?: boolean
      imageMode?: boolean
      mode?: ChatMode
    },
    win: BrowserWindow | null,
    chatMode: ChatMode,
    agentSettings: AgentSettings,
    userMsg: Message,
    history: Message[],
    assistantMsgId: string,
  ): Promise<{ userMsg: Message; assistantMsgId: string }> {
    const storeData: Record<string, unknown> = {}
    const storeKeys = [
      'apiKey', 'apiEndpoint', 'providers', 'modelAssignments', 'customModels',
      'temperature', 'maxTokens', 'reasoningValue', 'agentSettings', 'agentPermissions', 'integrations',
      'voiceId', 'embeddingModel',
      'imageProviderId', 'imageModelId', 'imageDefaultSize', 'imageDefaultQuality',
      'contextSettings',
    ]
    for (const k of storeKeys) {
      const v = store.get(k)
      if (v !== undefined) storeData[k] = v
    }

    const ctxSettings = getContextSettings(storeData)
    let currentWorkingMemory = ''
    let storedSummary = ''
    try { currentWorkingMemory = getWorkingMemory(params.chatId) } catch { /* ok */ }
    try { storedSummary = getChatSummary(params.chatId) } catch { /* ok */ }

    // Обновляем createdAt на момент реального старта. Для queued-запросов
    // userMsg.createdAt был зафиксирован в chat:send при отправке (до очереди),
    // а saveMessage происходит только сейчас. Без этого БД (сортировка по
    // created_at ASC) поставит user2/user3 перед assistant1 — порядок
    // диалога сломается при перезаходе в чат.
    userMsg.createdAt = Date.now()
    if (!params.incognito) saveMessage(userMsg)

    const historyLimit = 40
    const rawHistory: ChatMessage[] = history.slice(-historyLimit).flatMap(messageToContextMessages)

    let processedHistory = rawHistory
    let contextCompressed = false
    if (ctxSettings.rollingEnabled && rawHistory.length > 0) {
      const realContextWindow = getModelContextWindow(storeData)
      const rollingSettings = { ...ctxSettings, contextLimitTokens: realContextWindow }

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

      const result = await applyRollingWindowAsync(rawHistory, rollingSettings, summaryFn, storedSummary || undefined, false)
      if (result.compressed) {
        const triggerTokens = Math.floor(realContextWindow * ctxSettings.rollingTriggerPct / 100)
        log('[chat:send] rolling-window компакция chatId=%s: contextWindow=%d triggerTokens=%d(=%d%%) removed=%d сообщений',
          params.chatId, realContextWindow, triggerTokens, ctxSettings.rollingTriggerPct, result.removedCount)
        processedHistory = result.messages
        contextCompressed = true
        if (result.summaryContent && !params.incognito) {
          setChatSummary(params.chatId, result.summaryContent)
          storedSummary = result.summaryContent
        }
      }
    }

    if (ctxSettings.tokenCounterEnabled) {
      const contextWindow = getModelContextWindow(storeData)
      const sysPrompt = getSystemPrompt(params.chatId)
      const currentMsgTokens = estimateTokens(params.content)
      const snapshot = buildSnapshotFromEstimate(processedHistory, contextWindow, {
        systemPrompt: sysPrompt,
        currentMsgTokens,
        includeToolSchemas: true,
      })
      const sess = getSessionCost(params.chatId)
      win?.webContents.send(IPC_EVENTS.CONTEXT_USAGE, {
        chatId: params.chatId,
        pct: snapshot.pct,
        estimated: snapshot.estimated,
        limit: snapshot.limit,
        status: snapshot.status,
        source: 'estimate',
        compressed: contextCompressed,
        breakdown: snapshot.breakdown,
        sessionCostCents: sess?.totalCents ?? null,
        sessionRequests: sess?.requests ?? 0,
        historyMessages: history.length,
        toolCallsCount: history.reduce((sum, msg) => {
          const steps = msg.toolSteps as Array<{ type: string }> | undefined
          return sum + (steps?.filter(s => s.type === 'tool_call').length ?? 0)
        }, 0),
      })
    }

    let pendingPlan: { title: string; content: string; summary: string; filePath: string } | undefined

    // Request-scoped состояние этого запуска. Каждый chat:send имеет свой
    // собственный экземпляр — буферы не пересекаются между запусками.
    const run: ActiveRun = {
      worker: undefined as unknown as Worker,
      chatId: params.chatId,
      msgId: assistantMsgId,
      bufferedText: '',
      bufferedThinking: '',
      bufferedThinkingMs: undefined,
      bufferedSteps: [],
      bufferedIters: [],
      bufferedTodo: [],
      bufferedAgentStatus: null,
      bufferedRateLimitSec: 0,
      doneSent: false,
      sendDone: () => { /* присваивается ниже после определения sendDone */ },
    }

    const sendDone = (fullText: string, thinkingText?: string, thinkingMs?: number, steps?: unknown[], iters?: unknown[], todo?: unknown[]) => {
      if (run.doneSent) return
      run.doneSent = true
      // Снимаем ссылку на активный запуск этого чата — следующий chat:send
      // увидит, что слот свободен, и стартует (или дрейнит очередь).
      if (activeRuns.get(params.chatId) === run) {
        activeRuns.delete(params.chatId)
      }
      // Сбрасываем meta активного запуска — UI очереди уберёт Running-карточку.
      activeRunMeta.delete(params.chatId)

      const todoArr = (todo as Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }> | undefined)
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
        todo: todoArr && todoArr.length > 0 ? todoArr : undefined,
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

      // Эмитим терминальный статус для сайдбара (бейдж ✓).
      emitRunStatus(win, params.chatId, 'done', assistantMsgId)

      // Запускаем следующий запрос из очереди этого чата, если он есть.
      // drainQueue сам эмитит CHAT_QUEUE_UPDATED (очередь стала короче,
      // а следующий элемент переехал в activeRunMeta).
      drainQueue(win, params.chatId)
    }
    run.sendDone = sendDone

    const workerPath = path.join(__dirname, 'ai-worker.js')
    const mainAssignment = (storeData.modelAssignments as Array<{ role: string; modelId: string; providerId: string }> | undefined)
      ?.find(a => a.role === 'main')
    const catalogCachePath = path.join(app.getPath('userData'), 'modelsCatalog.json')
    const { workdir: chatWorkdir, verificationCommand } = (() => {
      try { return getChatWorkdirContext(params.chatId) } catch { return {} as ReturnType<typeof getChatWorkdirContext> }
    })()

    const worker = new Worker(workerPath, {
      workerData: {
        storeData,
        planningMode: params.planningMode ?? false,
        workingMemory: currentWorkingMemory,
        mode: chatMode,
        catalogCachePath,
        modelId: mainAssignment?.modelId,
        providerId: mainAssignment?.providerId,
        fileCacheSnapshot: getFileCacheSnapshot(params.chatId),
        workdir: chatWorkdir,
        verificationCommand,
      },
      env: process.env,
    })
    run.worker = worker
    activeRuns.set(params.chatId, run)

    // Эмитим стартовый статус для сайдбара (spinner).
    emitRunStatus(win, params.chatId, 'running', assistantMsgId)

    worker.on('message', (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case 'token':
          run.bufferedText += (msg.token as string) || ''
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_TOKEN, {
            chatId: msg.chatId, msgId: msg.msgId, token: msg.token,
          })
          break

        case 'thinking_token': {
          const tok = typeof msg.token === 'string' ? msg.token : ''
          run.bufferedThinking += tok
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_TOKEN, {
            chatId: msg.chatId, msgId: msg.msgId, thinkingToken: tok,
          })
          break
        }

        case 'thinking_done':
          run.bufferedThinkingMs = msg.thinkingMs as number
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_TOKEN, {
            chatId: msg.chatId, msgId: msg.msgId,
            thinkingDone: true, thinkingMs: msg.thinkingMs,
          })
          break

        case 'step':
          // tool_call_pending — временный ранний сигнал для UI (см. Agent.ts
          // onToolCallStarted), заменяется настоящим tool_call через
          // pendingCallId матчинг на фронтенде. Не персистим его в
          // bufferedSteps — иначе он попал бы в БД как "фантомный" шаг.
          if ((msg.step as { type?: string }).type !== 'tool_call_pending') {
            run.bufferedSteps.push(msg.step)
          }
          // chatId добавлен чтобы глобальный хук useChatRunSubscription мог
          // маршрутизировать шаг в нужный чат (раньше фильтрация шла по msgId
          // в локальном стейте ChatPage — не работало для параллельных чатов).
          win?.webContents.send('agent:step', { ...(msg.step as object), msgId: msg.msgId, chatId: msg.chatId })
          break

        case 'confirm': {
          const { reqId, toolName, args } = msg as { reqId: string; toolName: string; args: Record<string, unknown>; dangerLevel?: string; dangerReason?: string; previewDiff?: string }
          ipcMain.once(`agent:confirm:response:${reqId}`, (_, approved: boolean) => {
            worker.postMessage({ type: 'confirm_reply', replyId: `confirm-reply-${reqId}`, approved })
          })
          win?.webContents.send('agent:confirm', {
            reqId, toolName, args,
            dangerLevel: msg.dangerLevel,
            dangerReason: msg.dangerReason,
            previewDiff: msg.previewDiff,
          })
          break
        }

        case 'agent_status':
          run.bufferedAgentStatus = msg.text as string
          win?.webContents.send('agent:status', { msgId: msg.msgId, chatId: msg.chatId, text: msg.text })
          break

        case 'todo_update':
          run.bufferedTodo = msg.items as typeof run.bufferedTodo
          win?.webContents.send('agent:todo', { msgId: msg.msgId, chatId: msg.chatId, items: msg.items })
          break

        case 'spawn_agent': {
          ;(async () => {
            const parentSummary = getChatSummary(msg.chatId as string)
            const parentWorkingMemory = getWorkingMemory(msg.chatId as string)
            const subModeIntro = 'Сначала пойми релевантный код и ограничения, потом выполни только свою часть работы.'
            const subModeOutro = 'Финальный ответ дай кратко: что найдено или сделано, важные файлы, риски или следующий шаг.'
            const spawnResult = await agentManager.spawn({
              id: msg.id as string,
              parentId: msg.msgId as string,
              chatId: msg.chatId as string,
              task: msg.task as string,
              parallel: !!msg.parallel,
              model: msg.model as string | undefined,
              approvalMode: msg.approval_mode as 'auto' | 'ask' | 'full' | undefined,
              mode: chatMode,
              storeData,
              context: {
                systemPrompt: `Ты суб-агент. Твоя задача: ${msg.task as string}

Контекст родителя:
${parentSummary ? `${parentSummary}\n\n` : ''}${parentWorkingMemory ? `Рабочая память:\n${parentWorkingMemory}` : 'Рабочая память отсутствует.'}

${subModeIntro}
${subModeOutro}`,
                history: processedHistory.slice(-12),
                workingMemory: parentWorkingMemory,
                mode: chatMode,
              },
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

        case 'shell_exec': {
          ;(async () => {
            const result = await shellSessionManager.exec(
              msg.chatId as string,
              msg.command as string,
              msg.cwd as string | undefined,
              (msg.timeoutSec as number | undefined) ?? 60,
            )
            worker.postMessage({
              type: 'shell_exec_reply',
              replyId: msg.replyId,
              output: result.output,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
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
          ;(async () => {
            const agentIds = msg.agentIds as string[]
            const timeout = 5 * 60 * 1000
            const pollInterval = 1000
            const start = Date.now()

            while (Date.now() - start < timeout) {
              const records = agentIds.map(id => agentManager.get(id))
              const allDone = records.every(r => r && (r.status === 'done' || r.status === 'error' || r.status === 'cancelled'))
              if (allDone) {
                agentIds.forEach(id => {
                  const r = agentManager.get(id)
                  if (r) {
                    worker.postMessage({ type: 'agent_status_update', agentId: id, statusData: { status: r.status, stepsCount: r.steps.length } })
                  }
                })
                worker.postMessage({
                  type: 'wait_agents_reply',
                  replyId: msg.replyId,
                  results: records.map(r => ({ summary: r?.result ?? '', error: r?.error })),
                })
                return
              }

              agentIds.forEach(id => {
                const r = agentManager.get(id)
                if (r) {
                  worker.postMessage({
                    type: 'agent_status_update',
                    agentId: id,
                    statusData: { status: r.status, stepsCount: r.steps.length, currentStep: r.steps.at(-1)?.content?.slice(0, 80) },
                  })
                }
              })
              await new Promise(resolve => setTimeout(resolve, pollInterval))
            }

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
          run.bufferedRateLimitSec = msg.waitSec as number
          win?.webContents.send(IPC_EVENTS.RATE_LIMIT, { waitSec: msg.waitSec, chatId: params.chatId })
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
            chatId: params.chatId,
            pct: msg.pct,
            estimated: msg.estimated,
            limit: msg.limit,
            status: msg.status,
            source: msg.source ?? 'estimate',
            compressed: contextCompressed,
            breakdown: msg.breakdown,
            sessionCostCents: msg.sessionCostCents ?? null,
            sessionRequests: msg.sessionRequests ?? 0,
            historyMessages: history.length,
            toolCallsCount: history.reduce((sum, m) => {
              const steps = m.toolSteps as Array<{ type: string }> | undefined
              return sum + (steps?.filter(s => s.type === 'tool_call').length ?? 0)
            }, 0),
          })
          break

        case 'done':
          if (msg.updatedProviders) {
            store.set('providers', msg.updatedProviders)
          }
          if (msg.fileCacheUpdates) {
            mergeFileCache(params.chatId, msg.fileCacheUpdates as Record<string, unknown> as never)
          }
          sendDone(
            (msg.fullText as string) || run.bufferedText,
            (msg.thinkingText as string) || run.bufferedThinking || undefined,
            (msg.thinkingMs as number) || run.bufferedThinkingMs,
            (msg.collectedSteps as unknown[]) || run.bufferedSteps,
            (msg.collectedIters as unknown[]) || undefined,
            run.bufferedTodo,
          )
          break

        case 'plan_saved':
          pendingPlan = msg.plan as { title: string; content: string; summary: string; filePath: string }
          break

        case 'error': {
          // Если агент успел что-то сделать (текст/тулы) до ошибки — сохраняем
          // это в историю чата вместо того чтобы просто выбросить прогресс.
          if (msg.updatedProviders) {
            store.set('providers', msg.updatedProviders)
          }
          if (msg.fileCacheUpdates) {
            mergeFileCache(params.chatId, msg.fileCacheUpdates as Record<string, unknown> as never)
          }
          const errFullText = (msg.fullText as string) || run.bufferedText
          const errSteps = (msg.collectedSteps as unknown[]) || run.bufferedSteps
          if (errFullText.trim() || errSteps.length > 0) {
            sendDone(
              errFullText,
              (msg.thinkingText as string) || run.bufferedThinking,
              (msg.thinkingMs as number) || run.bufferedThinkingMs,
              errSteps,
              (msg.collectedIters as unknown[]) || undefined,
              run.bufferedTodo,
            )
          } else {
            // Нет прогресса — просто помечаем запуск завершённым и дрейним очередь.
            run.doneSent = true
            if (activeRuns.get(params.chatId) === run) activeRuns.delete(params.chatId)
            activeRunMeta.delete(params.chatId)
            drainQueue(win, params.chatId)
          }
          emitRunStatus(win, params.chatId, 'error', assistantMsgId, msg.error as string)
          win?.webContents.send(IPC_EVENTS.CHAT_STREAM_ERROR, {
            chatId: msg.chatId,
            error: msg.error,
          })
          break
        }
      }
    })

    worker.on('error', (err) => {
      log('[Worker] error chatId=%s: %s', params.chatId, err.message)
      console.error('[Worker] error:', err)
      sendDone(run.bufferedText, run.bufferedThinking, run.bufferedThinkingMs, run.bufferedSteps, run.bufferedIters, run.bufferedTodo)
      emitRunStatus(win, params.chatId, 'error', assistantMsgId, err.message)
      win?.webContents.send(IPC_EVENTS.CHAT_STREAM_ERROR, {
        chatId: params.chatId, error: err.message,
      })
    })

    worker.on('exit', () => {
      setImmediate(() => {
        // Если воркер был остановлен кнопкой Стоп или terminated — sendDone
        // уже вызван до terminate(), doneSent=true и flush здесь будет no-op.
        // Если же воркер упал/завершился сам, не дойдя до 'done' — сохраняем
        // накопленный прогресс, чтобы не потерять его.
        if (!run.doneSent) {
          log('[Worker] exit без done — флешим накопленный прогресс chatId=%s (text=%d chars, steps=%d)',
            params.chatId, run.bufferedText.length, run.bufferedSteps.length)
          sendDone(run.bufferedText, run.bufferedThinking, run.bufferedThinkingMs, run.bufferedSteps, run.bufferedIters, run.bufferedTodo)
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
      slashCommandName: params.slashCommand?.name,
      modelId: mainAssignment?.modelId,
      providerId: mainAssignment?.providerId,
      toolSchemas: getToolSchemas({
        planningMode: !!params.planningMode,
        imageMode: !!params.imageMode || params.slashCommand?.name === 'image',
        mode: chatMode,
      }),
    })

    return { userMsg, assistantMsgId }
  }

  // ── Проекты (рабочие директории) ────────────────────────────────────
  // Проект = именованная привязка к папке + зафиксированный при создании
  // контекст (analyzeProject). Чаты создаются внутри проекта и наследуют
  // его workdir. Пикер папки теперь часть создания проекта, а не чата.

  ipcMain.handle('projects:pickWorkdir', async () => {
    const win = mainWindow.getWindow()
    const result = await dialog.showOpenDialog(win ?? new BrowserWindow(), {
      properties: ['openDirectory'],
      title: 'Выберите папку проекта',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Создание НОВОЙ пустой папки для проекта. Используем showSaveDialog, чтобы
  // пользователь мог задать имя папки и выбрать родительский каталог; затем
  // физически создаём каталог через mkdirSync. Если каталог уже существует и
  // не пуст — отказываемся, чтобы не превращать «пустой проект» в скан
  // существующего содержимого.
  ipcMain.handle('projects:pickNewWorkdir', async () => {
    const win = mainWindow.getWindow()
    const result = await dialog.showSaveDialog(win ?? new BrowserWindow(), {
      title: 'Создать папку для нового проекта',
      buttonLabel: 'Создать проект',
      defaultPath: 'new-project',
      properties: ['createDirectory'],
    })
    if (result.canceled || !result.filePath) return null
    try {
      const fs = await import('fs')
      if (fs.existsSync(result.filePath)) {
        const entries = fs.readdirSync(result.filePath)
        if (entries.length > 0) {
          log('[projects:pickNewWorkdir] dir not empty, abort: %s', result.filePath)
          return null
        }
      } else {
        fs.mkdirSync(result.filePath, { recursive: true })
      }
    } catch (e) {
      log('[projects:pickNewWorkdir] mkdir failed: %s', (e as Error).message)
      return null
    }
    return result.filePath
  })

  ipcMain.handle('projects:create', async (_, workdir: string) => {
    // Если проект с таким workdir уже существует — createProject вернёт его
    // (UNIQUE constraint). Скан запускаем только если project_context пуст.
    const existing = getAllProjects().find(p => p.workdir === workdir)
    if (existing && existing.projectContext) return existing
    let projectContext: string | undefined
    try {
      const scan = await analyzeProject(workdir)
      if (scan.success && scan.output) projectContext = scan.output
      else log('[projects:create] analyzeProject не удался для workdir=%s: %s', workdir, scan.error ?? 'no output')
    } catch (e) {
      log('[projects:create] analyzeProject exception для workdir=%s: %s', workdir, (e as Error).message)
    }
    return createProject(workdir, projectContext)
  })

  ipcMain.handle('projects:getAll', () => getAllProjects())
  ipcMain.handle('projects:rename', (_, id: string, name: string) => renameProject(id, name))
  ipcMain.handle('projects:delete', (_, id: string) => deleteProject(id))
  ipcMain.handle('projects:getById', (_, id: string) => getProjectById(id))
  ipcMain.handle('projects:touch', (_, id: string) => touchProject(id))
  ipcMain.handle('projects:setVerificationCommand', (_, id: string, command: string | null) => setProjectVerificationCommand(id, command))

  ipcMain.handle('chat:create', async (_, isIncognito = false, mode: ChatMode = 'code', projectId?: string) => {
    return createChat(isIncognito, mode, projectId)
  })

  ipcMain.handle('chat:getAll', () => getAllChats())
  ipcMain.handle('chat:getMessages', (_, chatId: string) => getMessages(chatId))
  ipcMain.handle('chat:delete', (_, chatId: string) => {
    // Если в удаляемом чате работает воркер — убиваем его и чистим очередь.
    const run = activeRuns.get(chatId)
    if (run) {
      ;(run.worker as unknown as { _terminated?: boolean })._terminated = true
      run.worker.terminate()
      run.doneSent = true
      activeRuns.delete(chatId)
    }
    activeRunMeta.delete(chatId)
    chatQueues.delete(chatId)
    deleteChat(chatId)
    clearFileCache(chatId)
    agentManager.clearChat(chatId)
    shellSessionManager.kill(chatId)
  })
  ipcMain.handle('chat:rename', (_, chatId: string, title: string) => renameChat(chatId, title))
  ipcMain.handle('chat:pinMsg', (_, messageId: string) => pinMessage(messageId))
  ipcMain.handle('chat:unpinMsg', (_, messageId: string) => unpinMessage(messageId))

  // ── context:calculate — пересчёт контекста чата без отправки сообщения.
  //    Вызывается renderer-хуком useContextCounter при смене activeChatId,
  //    чтобы показатель контекста не был пустым до первого сообщения.
  //    Эмитит CONTEXT_USAGE с тем же payload, что и chat:send.
  ipcMain.handle('context:calculate', async (_, chatId: string) => {
    try {
      const win = mainWindow.getWindow()
      if (!win) return

      const storeData: Record<string, unknown> = {}
      const storeKeys = [
        'apiKey', 'apiEndpoint', 'providers', 'modelAssignments', 'customModels',
        'temperature', 'maxTokens', 'reasoningValue', 'agentSettings', 'agentPermissions', 'integrations',
        'voiceId', 'embeddingModel',
        'imageProviderId', 'imageModelId', 'imageDefaultSize', 'imageDefaultQuality',
        'contextSettings',
      ]
      for (const k of storeKeys) {
        const v = store.get(k)
        if (v !== undefined) storeData[k] = v
      }

      const ctxSettings = getContextSettings(storeData)
      if (!ctxSettings.tokenCounterEnabled) return

      const contextWindow = getModelContextWindow(storeData)
      const sysPrompt = getSystemPrompt(chatId)

      // Загружаем историю (как в chat:send) — для incognito-чатов она пуста
      const history = getMessages(chatId)
      const historyLimit = 40
      const rawHistory: ChatMessage[] = history.slice(-historyLimit).flatMap(messageToContextMessages)

      const snapshot = buildSnapshotFromEstimate(rawHistory, contextWindow, {
        systemPrompt: sysPrompt,
        currentMsgTokens: 0, // при смене чата ввод пуст
        includeToolSchemas: true,
      })
      const sess = getSessionCost(chatId)

      // Метаданные для legacy-полей ContextRing (historyMessages / toolCallsCount)
      const historyMessagesCount = history.length
      const toolCallsCount = history.reduce((sum, msg) => {
        const steps = msg.toolSteps as Array<{ type: string }> | undefined
        return sum + (steps?.filter(s => s.type === 'tool_call').length ?? 0)
      }, 0)

      win.webContents.send(IPC_EVENTS.CONTEXT_USAGE, {
        chatId,
        pct: snapshot.pct,
        estimated: snapshot.estimated,
        limit: snapshot.limit,
        status: snapshot.status,
        source: 'estimate',
        compressed: false,
        breakdown: snapshot.breakdown,
        sessionCostCents: sess?.totalCents ?? null,
        sessionRequests: sess?.requests ?? 0,
        historyMessages: historyMessagesCount,
        toolCallsCount,
      })
    } catch (e) {
      log('[context:calculate] error chatId=%s: %s', chatId, (e as Error).message)
    }
  })

  ipcMain.handle('chat:send', async (_, params: {
    chatId: string
    content: string
    displayContent?: string
    slashCommand?: { name: string; args: string }
    incognito?: boolean
    userMsgId?: string
    planningMode?: boolean
    imageMode?: boolean
    mode?: ChatMode
  }) => {
    const win = mainWindow.getWindow()

    // Читаем режим из БД — надёжнее чем доверять клиенту (защита от рассинхрона)
    const chatMode: ChatMode = params.mode ?? (() => { try { return getChatMode(params.chatId) } catch { return 'code' } })()

    const agentSettings = store.get('agentSettings', DEFAULT_AGENT_SETTINGS) as AgentSettings

    const userMsg: Message = {
      id: params.userMsgId ?? uuid(),
      chatId: params.chatId,
      role: 'user',
      content: params.displayContent ?? params.content,
      createdAt: Date.now(),
      isPinned: 0,
      slashCommand: params.slashCommand,
    }
    const history = params.incognito ? [] : getMessages(params.chatId)
    const assistantMsgId = uuid()

    // Метаданные для UI очереди: preview первых ~80 симв. запроса.
    const previewSrc = params.displayContent ?? params.content ?? ''
    const preview = previewSrc.replace(/\s+/g, ' ').trim().slice(0, 80)
    const meta: QueueItemMeta = {
      queueId: uuid(),
      chatId: params.chatId,
      msgId: assistantMsgId,
      userMsgId: userMsg.id,
      preview,
      enqueuedAt: Date.now(),
    }

    // Если в этом чате уже работает воркер — ставим запрос в очередь и
    // возвращаемся. Реальный запуск произойдёт после drainQueue(win, chatId).
    if (activeRuns.has(params.chatId)) {
      log('[chat:send] chatId=%s уже работает — ставим в очередь', params.chatId)
      emitRunStatus(win, params.chatId, 'queued', assistantMsgId)
      const queued: QueuedSend = {
        run: async () => { await runChatSend(params, win, chatMode, agentSettings, userMsg, history, assistantMsgId, store, mainWindow) },
        meta,
      }
      const q = chatQueues.get(params.chatId) ?? []
      q.push(queued)
      chatQueues.set(params.chatId, q)
      // Эмитим обновление очереди — UI покажет новый ожидающий запрос.
      emitQueueUpdate(win, params.chatId)
      return { userMsg, assistantMsgId, queued: true }
    }

    // Слот свободен — стартуем сразу. Запоминаем meta как активный запуск.
    activeRunMeta.set(params.chatId, { ...meta, startedAt: Date.now() })
    return runChatSend(params, win, chatMode, agentSettings, userMsg, history, assistantMsgId, store, mainWindow)
  })

  // ── chat:getLiveState — снапшот накопленного прогресса активного запуска.
  //    Используется renderer-ом при смене чата, чтобы гидрировать live-пузырь
  //    (текст/шаги/thinking) из main-буферов. Без этого при возврате в чат
  //    с активным агентом пользователь видел бы пустой пузырь и только новые
  //    токены, накопленные уже после переключения.
  ipcMain.handle('chat:getLiveState', (_, chatId: string) => {
    const run = activeRuns.get(chatId)
    if (!run) return null
    return {
      chatId,
      msgId: run.msgId,
      isRunning: !run.doneSent,
      bufferedText: run.bufferedText,
      bufferedThinking: run.bufferedThinking,
      bufferedThinkingMs: run.bufferedThinkingMs,
      bufferedSteps: run.bufferedSteps,
      bufferedIters: run.bufferedIters,
      bufferedTodo: run.bufferedTodo,
      bufferedAgentStatus: run.bufferedAgentStatus,
      bufferedRateLimitSec: run.bufferedRateLimitSec,
      meta: activeRunMeta.get(chatId) ?? null,
    }
  })

  // ── chat:stop — остановка активного запуска. Если передан chatId,
  //    останавливаем только этот чат (новое поведение для параллельных чатов).
  //    Если chatId не передан — backward compat: останавливаем все активные.
  ipcMain.handle('chat:stop', (_, chatId?: string) => {
    const win = mainWindow.getWindow()
    const stopRun = (run: ActiveRun) => {
      ;(run.worker as unknown as { _terminated?: boolean })._terminated = true
      run.worker.terminate()
      // Флешим накопленный прогресс — пользователь увидит частичный ответ,
      // сохранённый в историю. sendDone также сбрасывает activeRunMeta и
      // дрейнит очередь этого чата.
      run.sendDone(run.bufferedText, run.bufferedThinking, run.bufferedThinkingMs, run.bufferedSteps, run.bufferedIters, run.bufferedTodo)
      emitRunStatus(win, run.chatId, 'cancelled', run.msgId)
    }
    if (chatId) {
      const run = activeRuns.get(chatId)
      if (run) {
        stopRun(run)
        // activeRuns/activeRunMeta уже сброшены в sendDone; этот delete —
        // подстраховка на случай если sendDone был no-op (doneSent=true).
        activeRuns.delete(chatId)
        activeRunMeta.delete(chatId)
        emitQueueUpdate(win, chatId)
      } else {
        // Активного запуска нет — но могла быть очередь. Чистим её целиком.
        if (chatQueues.has(chatId)) {
          chatQueues.delete(chatId)
          emitQueueUpdate(win, chatId)
        }
      }
    } else {
      // Legacy: останавливаем все активные запуски
      const chatIds = new Set<string>()
      for (const [cid, run] of activeRuns) {
        chatIds.add(cid)
        stopRun(run)
      }
      activeRuns.clear()
      activeRunMeta.clear()
      chatQueues.clear()
      for (const cid of chatIds) emitQueueUpdate(win, cid)
    }
  })

  // ── chat:getQueue — снапшот очереди ожидающих запросов chatId.
  //    Возвращает массив meta (без активного запуска — он доступен через
  //    chat:getLiveState.meta). Используется UI-панелью очереди при
  //    инициализации и смене чата.
  ipcMain.handle('chat:getQueue', (_, chatId: string): QueueItemMeta[] => {
    const q = chatQueues.get(chatId) ?? []
    return q.map(item => item.meta)
  })

  // ── chat:queueRemove — убирает запрос из очереди по queueId.
  //    Сам воркер не трогается (запрос ещё не стартовал). Если удаляемый
  //    элемент был единственным — очередь очищается. Эмитит обновление.
  ipcMain.handle('chat:queueRemove', (_, chatId: string, queueId: string) => {
    const q = chatQueues.get(chatId)
    if (!q) return false
    const idx = q.findIndex(item => item.meta.queueId === queueId)
    if (idx === -1) return false
    q.splice(idx, 1)
    if (q.length === 0) chatQueues.delete(chatId)
    emitQueueUpdate(mainWindow.getWindow(), chatId)
    return true
  })

  // ── chat:queueReorder — переставляет очередь под новый порядок queueId.
  //    Элементы, не найденные в новом порядке, сохраняют свои позиции в конце.
  //    Активный запуск (если есть) не затрагивается — он не в очереди.
  ipcMain.handle('chat:queueReorder', (_, chatId: string, queueIds: string[]) => {
    const q = chatQueues.get(chatId)
    if (!q || q.length === 0) return false
    const byId = new Map(q.map(item => [item.meta.queueId, item]))
    const next: QueuedSend[] = []
    const used = new Set<string>()
    for (const id of queueIds) {
      const item = byId.get(id)
      if (item && !used.has(id)) {
        next.push(item)
        used.add(id)
      }
    }
    // Дописываем элементы, не указанные в новом порядке (сохраняя порядок).
    for (const item of q) {
      if (!used.has(item.meta.queueId)) next.push(item)
    }
    chatQueues.set(chatId, next)
    emitQueueUpdate(mainWindow.getWindow(), chatId)
    return true
  })

  ipcMain.handle('chat:reloadClient', () => {})

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

async function autoNameChat(chatId: string, firstMessage: string, store: Store, win?: BrowserWindow | null): Promise<void> {
  try {
    const client = new AIClient(store)
    const title = await client.complete(
      [{ role: 'user', content: `Придумай короткое название (3-5 слов) для чата, который начинается с этого сообщения: "${firstMessage.slice(0, 200)}". Ответь только названием без кавычек и лишних слов.` }],
      'fast',
    )
    const clean = title.trim().slice(0, 60)
    if (clean) {
      renameChat(chatId, clean)
      win?.webContents.send('chat:renamed', { chatId, title: clean })
    }
  } catch {
    // not critical
  }
}
