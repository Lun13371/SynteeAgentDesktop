import { BrowserWindow } from 'electron'
import { Worker } from 'worker_threads'
import { join } from 'path'
import type Store from 'electron-store'

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
  parentId: string | null       // null = корневой агент чата
  chatId: string
  task: string
  status: AgentStatus
  model: string
  parallel: boolean
  steps: AgentStep[]
  result: string                // итоговый текст после завершения
  summary: string               // краткий итог для контекста родителя
  createdAt: number
  finishedAt?: number
  error?: string
}

// ── AgentManager ──────────────────────────────────────────────────────────
class AgentManager {
  private agents = new Map<string, AgentRecord>()
  private workers = new Map<string, Worker>()
  private windows = new Set<BrowserWindow>()
  private store: Store | null = null
  private defaultMaxParallel = 3

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

  // Основной метод — запустить суб-агента
  async spawn(opts: {
    id: string
    parentId: string
    chatId: string
    task: string
    parallel: boolean
    model?: string
    storeData: Record<string, unknown>
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
      steps: [],
      result: '',
      summary: '',
      createdAt: Date.now(),
    }

    this.agents.set(opts.id, record)
    this.broadcast('agent:update', record)

    // Запускаем worker
    const promise = this._runWorker(record, opts.storeData)

    if (opts.parallel) {
      // Не ждём — возвращаем сразу
      promise.catch(e => {
        record.status = 'error'
        record.error = String(e)
        record.finishedAt = Date.now()
        this.broadcast('agent:update', record)
      })
      return { summary: `Суб-агент "${opts.task}" запущен параллельно (id: ${opts.id})` }
    } else {
      // Ждём результата
      return promise
    }
  }

  private async _runWorker(
    record: AgentRecord,
    storeData: Record<string, unknown>
  ): Promise<{ summary: string; error?: string }> {
    return new Promise((resolve) => {
      const workerPath = join(__dirname, 'ai-worker.js')

      let worker: Worker
      try {
        worker = new Worker(workerPath, { workerData: { storeData, isSubAgent: true }, env: process.env })
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

      // Шлём params так же как chat.ipc.ts
      const agentSettings = (storeData.agentSettings as Record<string, unknown> | undefined) ?? {
        maxSteps: 8, approvalMode: 'auto',
        toolOutputMode: 'normal', enableThinking: false,
      }
      worker.postMessage({
        chatId: `subagent:${record.id}`,
        msgId: record.id,
        content: record.task,
        history: [],
        systemPrompt: `Ты суб-агент. Твоя задача: ${record.task}\n\nВыполни задачу и дай чёткий итог. Будь краток в финальном ответе — только результат.`,
        enableTools: true,
        incognito: false,
        agentSettings,
        storeData,
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
            record.status = 'done'
            record.finishedAt = Date.now()
            const fullResult = record.result.trim()
            record.summary = fullResult.length > 500
              ? fullResult.slice(0, 500) + '...'
              : fullResult
            this.workers.delete(record.id)
            this.broadcast('agent:update', record)
            resolve({ summary: record.summary })
            break
          }
          case 'error': {
            record.status = 'error'
            record.error = msg.error as string
            record.finishedAt = Date.now()
            this.workers.delete(record.id)
            this.broadcast('agent:update', record)
            resolve({ summary: '', error: record.error })
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
    // Отменяем дочерние тоже
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

export const agentManager = new AgentManager()
