import { ipcMain } from 'electron'
import { agentManager } from '../managers/AgentManager'
import {
  getDB, getChatModel, getMessageById, getTaskSummaryState, updateTaskSummaryState,
  addTaskSummaryPin, removeTaskSummaryPin,
} from '../../core/db'
import { initializeDelegatedChats, requestState } from '../services/delegatedChats'
import { getDelegatedRequest, listDelegatedRequests, listDelegatedChatCreations, ownsDelegatedChat, getDelegationChat } from '../../core/db/delegatedChats'
import { activeRuns, runStatusListeners } from './chatShared'
import { setBroadcastTaskSummary, setRefreshDelegationSummary, type IpcMainWindow } from './chatRunSupport'
import { IPC_EVENTS } from '../../shared/constants'
import type { TaskSummary, TaskSummaryParticipant } from '../../shared/types/taskSummary'

// Ссылка на главное окно — устанавливается в registerTaskSummaryIPC (один раз при старте).
let taskSummaryWindow: IpcMainWindow | undefined

// ── Гидрация task-summary (module-level: не замыкаются на registrar) ────────
const hydrateTaskSummary = (chatId: string, task: TaskSummary): TaskSummary => {
  const messageIds = new Set(task.messageIds)
  const participants: TaskSummaryParticipant[] = []
  for (const agent of agentManager.getAll()) {
    if (agent.chatId !== chatId || !agent.parentId || !messageIds.has(agent.parentId)) continue
    const safeSummary = (agent.summary || agent.result || '').replace(/<thinking>[\s\S]*?(?:<\/thinking>|$)/gi, '').slice(0, 6000)
            const status = agent.status === 'pending' ? 'starting' : agent.status as TaskSummaryParticipant['status']
      participants.push({ id: `agent:${agent.id}`, kind: 'subagent', title: agent.role || agent.task.slice(0, 120), task: agent.task.slice(0, 6000), status, createdAt: agent.createdAt, finishedAt: agent.finishedAt, model: agent.model || undefined, role: agent.role || undefined, stepsCount: agent.steps.length, toolCallsCount: agent.steps.filter(s => s.type === 'tool_call').length, summary: safeSummary || undefined, error: agent.error?.slice(0, 1000), agentId: agent.id, sourceMessageId: agent.parentId })
  }
  for (const request of listDelegatedRequests(chatId)) {
    const sourceMessageId = request.sourceMessageId ?? ''
    const child = getDelegationChat(request.chatId)
    if (!messageIds.has(sourceMessageId) || !request.task || request.sourceChatId !== chatId || !ownsDelegatedChat(chatId, request.chatId) || !child || child.isIncognito) continue
    // requestState reconciles queued/running records against the authoritative
    // queue/run/message state. Do not render the stale row status here.
    const currentState = requestState(request.chatId, request.requestId)
    const status = currentState?.status && currentState.status !== 'idle' ? currentState.status : request.status
    const resultMessage = ['done', 'error', 'cancelled', 'interrupted'].includes(status) ? getMessageById(request.requestId) : undefined
    const clean = resultMessage?.content?.replace(/<thinking>[\s\S]*?(?:<\/thinking>|$)/gi, '').slice(0, 6000)
    const liveSteps = activeRuns.get(request.chatId)?.msgId === request.requestId ? activeRuns.get(request.chatId)?.bufferedSteps : undefined
    const childSteps = (liveSteps ?? resultMessage?.toolSteps ?? []) as Array<{ type?: string }>
    const updatedRequest = getDelegatedRequest(request.chatId, request.requestId) ?? request
    const titleRow = getDB().prepare('SELECT title FROM chats WHERE id=? AND is_incognito=0').get(request.chatId) as { title?: string } | undefined
    const model = getChatModel(request.chatId)
    participants.push({ id: `chat:${request.requestId}`, kind: 'chat', title: titleRow?.title || 'Связанный чат', task: request.task.slice(0, 6000), status: status as TaskSummaryParticipant['status'], createdAt: request.createdAt, finishedAt: ['done','error','cancelled','interrupted'].includes(status) ? updatedRequest.updatedAt : undefined, model: model?.modelId, stepsCount: childSteps.length, toolCallsCount: childSteps.filter(step => step.type === 'tool_call').length, summary: clean, error: updatedRequest.error?.slice(0, 1000), chatId: request.chatId, requestId: request.requestId, sourceMessageId, readAt: updatedRequest.readAt })
  }
  for (const creation of listDelegatedChatCreations(chatId)) {
    if (!messageIds.has(creation.sourceMessageId) || participants.some(item => item.kind === 'chat' && item.chatId === creation.chatId)) continue
    participants.push({ id: `created:${creation.chatId}`, kind: 'chat', title: creation.title, task: 'Чат создан без поручения в этой задаче.', status: 'idle', chatId: creation.chatId, sourceMessageId: creation.sourceMessageId, createdAt: creation.createdAt })
  }
  return { ...task, participants: participants.slice(-50) }
}
const hydrateState = (chatId: string, state: ReturnType<typeof getTaskSummaryState>) => ({ ...state, tasks: state.tasks.map(task => hydrateTaskSummary(chatId, task)) })

/** Гидратированный task-summary + рассылка в renderer. Вызывается и из
 * chatSendEngine (старт рана / sendDone), и из IPC task-summary:*. */
export const emitTaskSummary = (chatId: string, state: ReturnType<typeof getTaskSummaryState>) => { const hydrated = hydrateState(chatId, state); taskSummaryWindow?.getWindow()?.webContents.send(IPC_EVENTS.TASK_SUMMARY_CHANGED, { chatId, state: hydrated }); return hydrated }

/** task-summary: wiring agentManager'а и IPC task-summary:*. */
export function registerTaskSummaryIPC(mainWindow: IpcMainWindow): void {
  taskSummaryWindow = mainWindow
  const validChatId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128 && !!getDB().prepare('SELECT 1 FROM chats WHERE id=? AND is_incognito=0').get(id)
  initializeDelegatedChats() // Persist child status before observers hydrate its parent.
  const participantTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const refreshParticipants = (chatId: string) => {
    if (!validChatId(chatId) || participantTimers.has(chatId)) return
    participantTimers.set(chatId, setTimeout(() => {
      participantTimers.delete(chatId)
      if (validChatId(chatId)) emitTaskSummary(chatId, getTaskSummaryState(chatId))
    }, 180))
  }
  setRefreshDelegationSummary((childChatId, requestId) => {
    const request = getDelegatedRequest(childChatId, requestId)
    if (request?.sourceMessageId && validChatId(request.sourceChatId)) refreshParticipants(request.sourceChatId)
  })
  agentManager.registerWindowGetter(() => mainWindow.getWindow())
  agentManager.onUpdate(agent => {
    // AgentManager is authoritative for both live and terminal subagent state.
    // Hydration is keyed by parent message, never by title/time.
    if (!agent.parentId) return
    const taskState = getTaskSummaryState(agent.chatId)
    if (taskState.tasks.some(task => task.messageIds.includes(agent.parentId!))) refreshParticipants(agent.chatId)
  })
  runStatusListeners.add((childChatId, status, requestId) => {
    if (!requestId || status === 'compacting') return
    const request = getDelegatedRequest(childChatId, requestId)
    if (!request || request.sourceChatId === childChatId) return
    const taskState = getTaskSummaryState(request.sourceChatId)
    if (request.sourceMessageId && taskState.tasks.some(task => task.messageIds.includes(request.sourceMessageId!))) refreshParticipants(request.sourceChatId)
  })
  ipcMain.handle('task-summary:get', (_e, chatId: unknown) => validChatId(chatId) ? hydrateState(chatId, getTaskSummaryState(chatId)) : { tasks: [], pinned: false, manualPins: [] })
  ipcMain.handle('task-summary:update', (_e, chatId: unknown, patch: unknown) => {
    if (!validChatId(chatId) || !patch || typeof patch !== 'object' || Array.isArray(patch)) return { tasks: [], pinned: false, manualPins: [] }
    const p=patch as Record<string,unknown>; if(Object.keys(p).some(k=>!['pinned','selectedTaskId','newTaskRequested'].includes(k)) || (p.pinned!==undefined&&typeof p.pinned!=='boolean') || (p.newTaskRequested!==undefined&&typeof p.newTaskRequested!=='boolean') || (p.selectedTaskId!==undefined&&(typeof p.selectedTaskId!=='string'||p.selectedTaskId.length>128))) return getTaskSummaryState(chatId)
    return emitTaskSummary(chatId,updateTaskSummaryState(chatId,p as import('../../shared/types/taskSummary').TaskSummaryPatch))
  })
  ipcMain.handle('task-summary:addPin', (_e, chatId: unknown, text: unknown, messageId?: unknown) => {
    if (!validChatId(chatId) || typeof text!=='string' || !text.trim() || text.length>500 || (messageId!==undefined && (typeof messageId!=='string' || !getDB().prepare('SELECT 1 FROM messages WHERE id=? AND chat_id=?').get(messageId,chatId)))) return { tasks: [], pinned: false, manualPins: [] }
    return emitTaskSummary(chatId,addTaskSummaryPin(chatId,text.trim(),messageId as string|undefined))
  })
  ipcMain.handle('task-summary:removePin', (_e, chatId: unknown, id: unknown) => !validChatId(chatId)||typeof id!=='string' ? {tasks:[],pinned:false,manualPins:[]} : emitTaskSummary(chatId,removeTaskSummaryPin(chatId,id)))
  setBroadcastTaskSummary(emitTaskSummary)
}
