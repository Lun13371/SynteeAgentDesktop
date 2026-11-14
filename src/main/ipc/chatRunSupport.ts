import { ipcMain, BrowserWindow } from 'electron'
import { v4 as uuid } from 'uuid'
import {
  activeRuns, activeRunMeta, chatQueues, compactRuns, emitRunStatus, questionCallbacks,
  type ActiveRun,
} from './chatShared'
import { getTaskSummaryState, upsertTaskSummary } from '../../core/db'
import { disposeBrowserWorkerBroker } from '../../core/agent/browserWorkerBroker'
import { detachAssistants } from '../assistants/bridge'
import { IPC_EVENTS } from '../../shared/constants'
import { setForegroundBusy } from '../../core/sidecar/sidecarClient'
import { log } from '../../core/logger'
import type { Message, Attachment, ReplyTarget, ChatMode } from '../../shared/types'

/** Тип ссылки на главное окно, единый для chat-IPC модулей. */
export interface IpcMainWindow { getWindow: () => BrowserWindow | null }

// Installed by registerChatIPC; all events must include authoritative participants.
export let broadcastTaskSummary: ((chatId: string, state: ReturnType<typeof getTaskSummaryState>) => void) | undefined
export let refreshDelegationSummary: ((chatId: string, requestId: string) => void) | undefined

export function setBroadcastTaskSummary(fn: NonNullable<typeof broadcastTaskSummary>): void { broadcastTaskSummary = fn }
export function setRefreshDelegationSummary(fn: NonNullable<typeof refreshDelegationSummary>): void { refreshDelegationSummary = fn }

/**
 * Эмитит снапшот текущей очереди chatId для UI (список ожидающих запросов).
 * Вызывается при любом изменении: добавлении, удалении, reorder, drain.
 */
export function emitQueueUpdate(win: BrowserWindow | null, chatId: string) {
  const q = chatQueues.get(chatId) ?? []
  const queue = q.map(item => item.meta)
  win?.webContents.send(IPC_EVENTS.CHAT_QUEUE_UPDATED, { chatId, queue, ts: Date.now() })
}

// ── Хелперы реконструкции итераций для ActiveRun ──────────────────────
// Зеркалят логику ai-worker.ts (flushIter + finalize) чтобы main мог строить
// iterations из потоковых событий при stop/exit/error и для chat:getLiveState.
// Без этого при ручной остановке или возврате в чат во время стриминга тулы
// теряли позиции (все сливались в одну кучу, текст — отдельным блоком).

/**
 * Чинит незакрытые markdown code-fences в textBefore. Если агент стримил
 * prose до зависшего тула и не дописал закрывающий ```` ``` ```` — ReactMarkdown
 * проглотил бы весь последующий контент в code-block. Считаем fences (``` и ~~~)
 * и если нечётное — дописываем закрывающий.
 */
export function repairMarkdownFence(text: string): string {
  if (!text) return text
  const fenceMatches = text.match(/^[ \t]*(`{3,}|~{3,})/gm)
  if (!fenceMatches) return text
  // Группируем по типу ограды (``` или ~~~) — незакрытый считается только
  // если нечётное число ОДНОТИПНЫХ оград.
  const byChar: Record<string, number> = {}
  for (const f of fenceMatches) {
    const ch = f.trim()[0]
    byChar[ch] = (byChar[ch] || 0) + 1
  }
  let result = text
  for (const [ch, count] of Object.entries(byChar)) {
    if (count % 2 !== 0) {
      result += `\n${ch.repeat(3)} `
    }
  }
  return result
}

/**
 * Добавляет синтетические tool_result для tool_call без парного result.
 * При ручной остановке/падении воркера агент мог эмитить tool_call, но
 * executeTool не успел вернуть результат → в шагах висит orphan call.
 * Без этого ToolChain рендерит карточку без бейджа (ни ✓ ни ✗) — "кривая".
 * Синтетический result даёт ✗ бейдж + текст "[прервано пользователем]".
 */
export function ensureToolResults(steps: unknown[]): unknown[] {
  const result = [...steps]
  const calls = result.filter((s: any) => s?.type === 'tool_call')
  const results = result.filter((s: any) => s?.type === 'tool_result')
  for (const call of calls) {
    const c = call as { callId?: string; toolName?: string; id: string }
    const hasResult = results.some((r: any) =>
      (c.callId && r?.callId === c.callId) ||
      (!c.callId && r?.toolName === c.toolName && !(r as any)._matched)
    )
    if (!hasResult) {
      // Помечаем чтобы fallback-матчинг не цеплял один result на несколько call'ов
      result.push({
        id: uuid(),
        type: 'tool_result',
        toolName: c.toolName,
        content: '[прервано пользователем]',
        success: false,
        timestamp: Date.now(),
        callId: c.callId,
      })
    }
  }
  return result
}

export function flushRunIter(run: ActiveRun): void {
  if (run.currentIterSteps.length > 0) {
    run.closedIters.push({
      textBefore: repairMarkdownFence(run.currentIterTextBefore),
      thinking: run.currentIterThinking || undefined,
      thinkingMs: run.currentIterThinkingMs,
      steps: run.currentIterSteps,
    })
    run.currentIterTextBefore = ''
    run.currentIterSteps = []
    run.currentIterThinking = ''
    run.currentIterThinkingMs = undefined
  }
}

/**
 * Снапшот для chat:getLiveState: закрытые iters + открытая (текущая) итерация.
 * Включает open-iter чтобы при возврате в чат показать частичный прогресс
 * (тулы на своих местах, незавершённый тулчейн — с isRunning).
 */
export function buildLiveIters(run: ActiveRun): unknown[] {
  const iters = [...run.closedIters]
  if (run.currentIterSteps.length > 0) {
    iters.push({
      textBefore: run.currentIterTextBefore,
      thinking: run.currentIterThinking || undefined,
      thinkingMs: run.currentIterThinkingMs,
      steps: [...run.currentIterSteps],
    })
  }
  return iters
}

/**
 * Финальные iters для sendDone: закрытые + открытая + хвостовой text-only iter
 * (зеркало ai-worker.ts finalize 176-187). Возвращает undefined если iters нет
 * (чисто текстовый ответ без тулов — рендерится через message.content).
 * Для каждого tool_call без парного tool_result добавляется синтетический
 * result (success:false, '[прервано]') — иначе ToolChain показывает orphan-карточку.
 */
export function buildFinalIters(run: ActiveRun): unknown[] | undefined {
  const iters = [...run.closedIters]
  if (run.currentIterSteps.length > 0) {
    iters.push({
      textBefore: repairMarkdownFence(run.currentIterTextBefore),
      thinking: run.currentIterThinking || undefined,
      thinkingMs: run.currentIterThinkingMs,
      steps: [...run.currentIterSteps],
    })
  }
  if (iters.length > 0 && (run.pendingThinking || run.pendingTextAfter.trim())) {
    iters.push({
      textBefore: repairMarkdownFence(run.pendingTextAfter),
      thinking: run.pendingThinking || undefined,
      thinkingMs: run.pendingThinkingMs,
      steps: [],
    })
  }
  // Чиним orphan tool_call'ы во ВСЕХ итерациях (синтетические tool_result).
  for (const iter of iters as Array<{ steps: unknown[] }>) {
    iter.steps = ensureToolResults(iter.steps)
  }
  return iters.length > 0 ? iters : undefined
}
// ── Programmatic chat:send для main-процессных модулей (DotManager) ──────
// registerChatIPC при старте кладёт сюда реализацию chat:send. DotManager
// будит Dot'ов (фоновые пробуждения по cron/webhook/fs) прямым вызовом из
// main — без IPC round-trip через renderer. Результат тот же, что у
// renderer-отправки: { userMsg, assistantMsgId, queued? }.
export interface ProgrammaticChatSendParams {
  chatId: string
  content: string
  displayContent?: string
  slashCommand?: { name: string; args: string }
  incognito?: boolean
  userMsgId?: string
  /** Reserved ID for delegated requests, persisted before asynchronous startup. */
  assistantMsgId?: string
  planningMode?: boolean
  askMode?: boolean
  imageMode?: boolean
  /** Тумблер «Управление браузером»: browser_* тулы (гейтится также
   *  chats.browser_mode из БД — request_access пишет туда). */
  browserMode?: boolean
  mode?: ChatMode
  oneShotSkill?: { name: string; instructions: string }
  oneShotAllowedTools?: string[]
  oneShotMode?: 'ask' | 'plan' | 'code'
  reasoningValue?: string
  attachments?: Attachment[]
  replyTo?: ReplyTarget[]
}
// Request-scoped cancellation during async preparation, before a Worker exists.
export const cancelledDelegatedStarts = new Set<string>()
export let chatStopImpl: ((chatId: string, requestId: string) => boolean) | null = null
export let chatSendImpl: ((params: ProgrammaticChatSendParams) => Promise<{ userMsg: Message; assistantMsgId: string; queued?: boolean }>) | null = null

/** Обновляет дешёвый сигнал для sidecar: фоновая индексация уступает фореграунду. */
export function updateForegroundBusy(): void {
  setForegroundBusy(activeRuns.size > 0 || activeRunMeta.size > 0 || compactRuns.size > 0)
}

/** Отправить сообщение в чат из main-процесса (DotManager: пробуждение Dot'ов). */
export function sendChatMessageProgrammatic(params: ProgrammaticChatSendParams): Promise<{ userMsg: Message; assistantMsgId: string; queued?: boolean }> {
  if (!chatSendImpl) {
    return Promise.reject(new Error('chat:send не зарегистрирован — registerChatIPC ещё не вызван'))
  }
  return chatSendImpl(params)
}

/**
 * Флешит все активные стримящиеся запуски в БД — вызывается при before-quit/will-quit.
 * Каждый ActiveRun, у которого есть накопленный текст/шаги, сохраняется через
 * sendDone (saveMessage с заменой строки по id — идемпотентен). Воркеры terminate'ятся отдельно.
 * Без этого при резком выходе частичный ответ ассистента терялся бы.
 */
export function flushAllActiveRuns(): void {
  for (const [chatId, run] of activeRuns) {
    if (run.doneSent) continue
    // Останавливаем checkpoint-таймер перед флешем — sendDone ниже
    // сохранит финальную версию и перезапишет любой частичный checkpoint.
    if (run.streamCheckpointTimer) {
      clearInterval(run.streamCheckpointTimer)
      run.streamCheckpointTimer = null
    }
    const hasContent = run.bufferedText.trim() || run.bufferedSteps.length > 0 || run.bufferedThinking.trim()
    if (!hasContent) continue
    try {
      const iters = buildFinalIters(run)
      run.sendDone(
        run.bufferedText,
        run.bufferedThinking || undefined,
        run.bufferedThinkingMs,
        run.bufferedSteps.length > 0 ? run.bufferedSteps : undefined,
        iters,
        run.bufferedTodo.length > 0 ? run.bufferedTodo : undefined,
      )
      log('[flushAllActiveRuns] flushed chatId=%s msgId=%s text=%d chars', chatId, run.msgId, run.bufferedText.length)
    } catch (e) {
      log('[flushAllActiveRuns] failed chatId=%s: %s', chatId, (e as Error).message)
    }
  }
}

export function setChatStopImpl(fn: NonNullable<typeof chatStopImpl>): void { chatStopImpl = fn }
export function setChatSendImpl(fn: NonNullable<typeof chatSendImpl>): void { chatSendImpl = fn }

/**
 * Снимает висящие ask_user запуска: удаляет callback + ipcMain-листенер и
 * просит renderer убрать вопрос из очереди QuestionPanel. Нужно при Стопе и
 * крахе воркера — отвечать на такие вопросы уже некому, иначе панель висит с
 * мёртвым вопросом, а листенер `agent:question:response:<reqId>` течёт.
 */
export function dismissPendingQuestions(win: BrowserWindow | null, run: ActiveRun): void {
  if (!run.pendingQuestions || run.pendingQuestions.size === 0) return
  for (const reqId of run.pendingQuestions) {
    questionCallbacks.delete(reqId)
    ipcMain.removeAllListeners(`agent:question:response:${reqId}`)
    try { win?.webContents.send('agent:question:dismiss', reqId) } catch { /* окно могло закрыться */ }
  }
  run.pendingQuestions.clear()
}

/**
 * Аварийная очистка после НЕОЖИДАННОГО падения runChatSend (throw вне
 * штатных путей: исключение в getSystemPrompt, компакции, построении
 * workerData и т.п.). Штатные ошибки (worker 'error'/'exit') чистят своё
 * сами. Без этой очистки чат оставался «занятым» НАВСЕГДА: activeRunMeta
 * не удалялся → каждый следующий chat:send молча уходил в очередь,
 * UI крутил «работает», Стоп не работал, очередь не дрейнилась.
 */
export function failRunCleanup(
  win: BrowserWindow | null,
  chatId: string,
  assistantMsgId: string,
  e: unknown,
): void {
  // If setup failed before the worker's terminal event, close only a summary
  // explicitly associated with this assistant message. Incognito runs never create one.
  const closeSummary = (status: 'error' | 'cancelled', detail: string) => {
    try {
      const state = getTaskSummaryState(chatId)
      const task = state.tasks.find(item => item.status === 'running' && item.messageIds.includes(assistantMsgId))
      if (!task) return
      task.status = status
      task.updatedAt = Date.now()
      task.summary = detail.slice(0, 500)
      const next = upsertTaskSummary(task)
      broadcastTaskSummary?.(chatId, next)
    } catch (summaryError) { log('[task-summary] terminal update failed: %s', (summaryError as Error).message) }
  }
  if (cancelledDelegatedStarts.delete(assistantMsgId)) {
    const cancelledRun = activeRuns.get(chatId)
    if (cancelledRun?.msgId === assistantMsgId) {
      cancelledRun.doneSent = true // worker exit must not finalize a cancelled preparation as error
      if (cancelledRun.streamCheckpointTimer) clearInterval(cancelledRun.streamCheckpointTimer)
      if (cancelledRun.uiFlushTimer) clearTimeout(cancelledRun.uiFlushTimer)
      disposeBrowserWorkerBroker(cancelledRun.worker)
      void cancelledRun.worker?.terminate()
      dismissPendingQuestions(win, cancelledRun)
      activeRuns.delete(chatId)
      detachAssistants(chatId)
    }
    if (activeRunMeta.get(chatId)?.msgId === assistantMsgId) activeRunMeta.delete(chatId)
    updateForegroundBusy()
    closeSummary('cancelled', 'Работа остановлена до запуска агента')
    emitRunStatus(win, chatId, 'cancelled', assistantMsgId)
    drainQueue(win, chatId)
    return
  }
  const message = e instanceof Error ? e.message : String(e)
  log('[chat:send] runChatSend CRASHED chatId=%s: %s', chatId, message)
  console.error('[chat:send] runChatSend CRASHED:', e)
  closeSummary('error', message)
  // Воркер мог быть создан до падения — терминируем, не течём потоками.
  const run = activeRuns.get(chatId)
  if (run?.streamCheckpointTimer) {
    clearInterval(run.streamCheckpointTimer)
    run.streamCheckpointTimer = null
  }
  if (run?.uiFlushTimer) {
    clearTimeout(run.uiFlushTimer)
    run.uiFlushTimer = null
  }
  if (run?.worker) {
    ;(run.worker as unknown as { _terminated?: boolean })._terminated = true
    disposeBrowserWorkerBroker(run.worker)
    try { run.worker.terminate() } catch { /* уже мёртв */ }
  }
  if (run) dismissPendingQuestions(win, run)
  activeRuns.delete(chatId)
  detachAssistants(chatId)
  activeRunMeta.delete(chatId)
  updateForegroundBusy()
  emitRunStatus(win, chatId, 'error', assistantMsgId, message)
  try {
    win?.webContents.send(IPC_EVENTS.CHAT_STREAM_ERROR, { chatId, error: message })
  } catch { /* окно могло закрыться */ }
  drainQueue(win, chatId)
}

/**
 * Запускает следующий chat:send из очереди chatId, если он есть.
 * Вызывается после терминального статуса предыдущего запуска (done/error/cancelled).
 */
export function drainQueue(win: BrowserWindow | null, chatId: string) {
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
  updateForegroundBusy()
  emitQueueUpdate(win, chatId)
  // Асинхронный запуск — ошибки внутри run() обрабатываются им самим.
  void next.run().catch((e) => failRunCleanup(win, chatId, next.meta.msgId, e))
}

/** Рассылает обновлённую goal всем окнам (раньше — замыкание registerChatIPC). */
export const broadcastGoal = (chatId: string, goal: import('../../shared/types/goal').ChatGoal | null): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('goal:updated', { chatId, goal })
  }
}
