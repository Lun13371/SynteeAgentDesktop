import { BrowserWindow } from 'electron'
import { Worker } from 'worker_threads'
import { join } from 'path'
import type Store from 'electron-store'
import type { ChatMode } from '../shared/types'
import { getToolSchemas } from '../core/tools'
import { getFileCacheSnapshot, mergeFileCache } from '../core/context/fileReadCache'

export type AgentStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

export interface AgentStep {
  id: string
  type: 'tool_call' | 'tool_result'
  toolName?: string
  toolArgs?: Record<string, unknown>
  content: string
  success?: boolean
  timestamp: number
  imageUrl?: string
  diff?: string
}

export interface AgentRecord {
  id: string
  parentId: string | null
  chatId: string
  task: string
  status: AgentStatus
  model: string
  parallel: boolean
  mode: ChatMode
  steps: AgentStep[]
  result: string
  summary: string
  createdAt: number
  finishedAt?: number
  error?: string
}

export interface SubagentContext {
  systemPrompt?: string
  history?: Array<{ role: string; content: string }>
  workingMemory?: string
  mode?: ChatMode
}

class AgentManager {
  private agents = new Map<string, AgentRecord>()
  private workers = new Map<string, Worker>()
  private windows = new Set<BrowserWindow>()
  private store: Store | null = null
  private resolvers = new Map<string, (result: { summary: string; error?: string }) => void>()

  init(store: Store) {
    this.store = store
  }

  registerWindow(win: BrowserWindow) {
    this.windows.add(win)
    win.on('closed', () => this.windows.delete(win))
  }

  private broadcast(channel: string, payload: unknown) {
    Array.from(this.windows).forEach(win => {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    })
  }

  getAll(): AgentRecord[] {
    return Array.from(this.agents.values()).sort((a, b) => a.createdAt - b.createdAt)
  }

  get(id: string): AgentRecord | undefined {
    return this.agents.get(id)
  }

  getChildren(parentId: string): AgentRecord[] {
    return this.getAll().filter(a => a.parentId === parentId)
  }

  getMaxParallel(): number {
    return (this.store?.get('agentSettings.maxParallelSubAgents', 3) as number) ?? 3
  }

  getRunningCount(parentId?: string): number {
    return this.getAll().filter(a =>
      a.status === 'running' &&
      (parentId == null || a.parentId === parentId)
    ).length
  }

  async spawn(opts: {
    id: string
    parentId: string
    chatId: string
    task: string
    parallel: boolean
    model?: string
    mode?: ChatMode
    storeData: Record<string, unknown>
    context?: SubagentContext
    approvalMode?: 'auto' | 'ask' | 'full'  // §1.10 — override глобального режима
  }): Promise<{ summary: string; error?: string }> {
    const maxParallel = this.getMaxParallel()
    const running = this.getRunningCount()
    if (running >= maxParallel) {
      return { summary: '', error: `Достигнут лимит параллельных агентов (${maxParallel}). Подождите завершения текущих.` }
    }

    const model = opts.model ||
      (opts.storeData.modelAssignments as Array<{ role: string; modelId: string }> | undefined)
        ?.find(a => a.role === 'subagent')?.modelId ||
      (opts.storeData.modelAssignments as Array<{ role: string; modelId: string }> | undefined)
        ?.find(a => a.role === 'main')?.modelId ||
      'claude-sonnet-4-6'

    const record: AgentRecord = {
      id: opts.id,
      parentId: opts.parentId,
      chatId: opts.chatId,
      task: opts.task,
      status: 'pending',
      model,
      parallel: opts.parallel,
      mode: opts.mode ?? opts.context?.mode ?? 'code',
      steps: [],
      result: '',
      summary: '',
      createdAt: Date.now(),
    }

    this.agents.set(opts.id, record)
    this.broadcast('agent:update', record)

    const promise = this._runWorker(record, opts.storeData, opts.context, opts.approvalMode)

    if (opts.parallel) {
      promise.catch(e => {
        record.status = 'error'
        record.error = String(e)
        record.finishedAt = Date.now()
        this.broadcast('agent:update', record)
      })
      return { summary: `Суб-агент "${opts.task}" запущен параллельно (id: ${opts.id})` }
    }

    return promise
  }

  private async _runWorker(
    record: AgentRecord,
    storeData: Record<string, unknown>,
    context?: SubagentContext,
    approvalModeOverride?: 'auto' | 'ask' | 'full',
  ): Promise<{ summary: string; error?: string }> {
    return new Promise((resolve) => {
      const workerPath = join(__dirname, 'ai-worker.js')
      this.resolvers.set(record.id, resolve)

      let worker: Worker
      try {
        worker = new Worker(workerPath, { workerData: { storeData, isSubAgent: true, mode: record.mode, fileCacheSnapshot: getFileCacheSnapshot(record.chatId) }, env: process.env })
      } catch (e: any) {
        record.status = 'error'
        record.error = e.message
        record.finishedAt = Date.now()
        this.broadcast('agent:update', record)
        resolve({ summary: '', error: e.message })
        return
      }

      record.status = 'running'
      this.workers.set(record.id, worker)
      this.broadcast('agent:update', record)

      const agentSettings = (storeData.agentSettings as Record<string, unknown> | undefined) ?? {
        maxSteps: 8,
        approvalMode: 'auto',
        toolOutputMode: 'normal',
        enableThinking: false,
      }
      // §1.10 — позволяем суб-агенту иметь свой approval режим
      if (approvalModeOverride) {
        agentSettings.approvalMode = approvalModeOverride
      }

      // Work-режим удалён — всегда Code-формулировка для суб-агентов.
      const subModeIntro = 'Работай только в рамках этой подзадачи.\nСначала пойми релевантный код и контекст, затем выполни работу.'
      const subModeOutro = '- что найдено или сделано\n- какие файлы важны\n- какие есть риски или следующий шаг'

      worker.postMessage({
        chatId: `subagent:${record.id}`,
        msgId: record.id,
        content: record.task,
        history: context?.history ?? [],
        systemPrompt: context?.systemPrompt ?? `Ты суб-агент. Твоя задача: ${record.task}

${subModeIntro}
Финальный ответ дай кратко:
${subModeOutro}`,
        enableTools: true,
        incognito: false,
        agentSettings,
        storeData,
        workingMemory: context?.workingMemory ?? '',
        toolSchemas: getToolSchemas({ mode: record.mode }),
      })

      worker.on('message', (msg: Record<string, unknown>) => {
        switch (msg.type) {
          case 'step': {
            const step = msg.step as AgentStep & { imageUrl?: string }
            if (step.type === 'tool_call' || step.type === 'tool_result') {
              const ts: AgentStep = {
                id: `${Date.now()}-${Math.random()}`,
                type: step.type,
                toolName: step.toolName,
                toolArgs: step.toolArgs,
                content: step.content,
                success: step.success,
                timestamp: Date.now(),
                imageUrl: step.imageUrl,
              }
              record.steps.push(ts)
              this.broadcast('agent:update', record)
            }
            break
          }
          case 'token':
            record.result += msg.token as string
            break
          case 'done': {
            // Персистим round-robin индекс ключей провайдера, обновлённый суб-агентом
            if (msg.updatedProviders && this.store) {
              this.store.set('providers', msg.updatedProviders)
            }
            // Мержим обновлённый кэш файлов в кэш родительского чата
            if (msg.fileCacheUpdates) {
              mergeFileCache(record.chatId, msg.fileCacheUpdates as Record<string, unknown> as never)
            }
            record.status = 'done'
            record.finishedAt = Date.now()
            record.summary = buildSubagentSummary(record.result.trim(), msg.agentSummary)
            this.workers.delete(record.id)
            this.resolvers.delete(record.id)
            this.broadcast('agent:update', record)
            resolve({ summary: record.summary })
            break
          }
          case 'error': {
            // Персистим round-robin если суб-агент успел его обновить перед ошибкой
            if (msg.updatedProviders && this.store) {
              this.store.set('providers', msg.updatedProviders)
            }
            if (msg.fileCacheUpdates) {
              mergeFileCache(record.chatId, msg.fileCacheUpdates as Record<string, unknown> as never)
            }
            record.status = 'error'
            record.error = msg.error as string
            record.finishedAt = Date.now()
            // Если суб-агент успел накопить текст/шаги до ошибки — отдаём это
            // родителю как частичный summary вместо пустой строки, иначе
            // родительский агент теряет весь прогресс суб-агента.
            record.summary = buildSubagentSummary(record.result.trim(), msg.agentSummary)
            this.workers.delete(record.id)
            this.resolvers.delete(record.id)
            this.broadcast('agent:update', record)
            resolve({ summary: record.summary, error: record.error })
            break
          }
        }
      })

      worker.on('error', (e) => {
        record.status = 'error'
        record.error = e.message
        record.finishedAt = Date.now()
        this.workers.delete(record.id)
        this.broadcast('agent:update', record)
        resolve({ summary: '', error: e.message })
      })

      worker.on('exit', (code) => {
        if (record.status === 'running') {
          record.status = code === 0 ? 'done' : 'error'
          record.error = code !== 0 ? `Worker завершился с кодом ${code}` : undefined
          record.finishedAt = Date.now()
          this.workers.delete(record.id)
          this.broadcast('agent:update', record)
          resolve({ summary: record.summary || '', error: record.error })
        }
      })
    })
  }

  cancel(id: string) {
    const worker = this.workers.get(id)
    const record = this.agents.get(id)
    if (worker) {
      worker.terminate()
      this.workers.delete(id)
    }
    if (record) {
      record.status = 'cancelled'
      record.finishedAt = Date.now()
      this.broadcast('agent:update', record)
    }
    const resolver = this.resolvers.get(id)
    if (resolver) {
      this.resolvers.delete(id)
      resolver({ summary: '', error: 'Суб-агент отменен пользователем' })
    }
    for (const child of this.getChildren(id)) {
      this.cancel(child.id)
    }
  }

  clearChat(chatId: string) {
    Array.from(this.agents.entries()).forEach(([id, record]) => {
      if (record.chatId === chatId) {
        this.cancel(id)
        this.agents.delete(id)
      }
    })
  }
}

/**
 * Строит расширенный summary суб-агента: финальный текст (до 3000 симв.) +
 * структурированный хвост (изменённые файлы, diff-и, команды), общий кап ~4000 симв.
 * Заменяет старый подход с обрезкой до 500 симв. без деталей.
 */
function buildSubagentSummary(text: string, details?: unknown): string {
  const textPart = text.length > 3000 ? text.slice(0, 3000) + '...' : text

  if (!details || typeof details !== 'object') return textPart

  const d = details as {
    modifiedFiles?: string[]
    diffs?: Array<{ file: string; summary: string }>
    commandsRun?: Array<{ command: string; exitCode?: string; success: boolean }>
    filesRead?: string[]
  }

  const parts: string[] = [textPart]

  if (d.modifiedFiles && d.modifiedFiles.length > 0) {
    parts.push(`\n[Modified files]\n${d.modifiedFiles.map(f => `- ${f}`).join('\n')}`)
  }
  if (d.diffs && d.diffs.length > 0) {
    const diffLines = d.diffs.slice(-15).map(e => `- ${e.file}: ${e.summary}`)
    parts.push(`\n[Diffs]\n${diffLines.join('\n')}`)
  }
  if (d.commandsRun && d.commandsRun.length > 0) {
    const cmdLines = d.commandsRun.slice(-15).map(c => `- ${c.command} → exit ${c.exitCode ?? '?'} (${c.success ? 'ok' : 'error'})`)
    parts.push(`\n[Commands]\n${cmdLines.join('\n')}`)
  }
  if (d.filesRead && d.filesRead.length > 0) {
    parts.push(`\n[Files read]\n${d.filesRead.map(f => `- ${f}`).join('\n')}`)
  }

  const result = parts.join('\n')
  return result.length > 4000 ? result.slice(0, 4000) + '\n...' : result
}

export const agentManager = new AgentManager()
