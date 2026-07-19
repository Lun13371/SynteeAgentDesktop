import type Store from 'electron-store'
import { AIClient } from '../ai/AIClient'
import { needsApproval } from './commandSafety'
import { updateStructuredMemory } from '../context/structuredMemory'
import type { DiffEntry } from '../context/structuredMemory'
import {
  runCommand, readFile, writeFile, listDirectory,
  findFiles,
  searchWeb, getSystemInfo, generateImage,
  readFiles, searchCode, analyzeProject,
  httpRequest,
  TOOL_SCHEMAS, type ToolResult, editFile, multiEditFile,
} from '../tools'
import { truncateToolResult, getContextSettings, estimateTokens, TOOL_SCHEMAS_OVERHEAD, getModelContextWindow } from '../context/contextManager'
import type { FileCacheEntry } from '../context/fileCacheTypes'
import { statSync } from 'fs'

export interface AgentStep {
  type: 'thought' | 'tool_call' | 'tool_result' | 'answer'
  toolName?: string
  toolArgs?: Record<string, unknown>
  content: string
  success?: boolean
  imageUrl?: string
  diff?: string
  callId?: string
  hidden?: boolean
}

export interface AgentCallbacks {
  onStep: (step: AgentStep) => void
  onDone: (answer: string, details?: AgentSummaryDetails) => void
  onError: (error: Error) => void
  onPlanSaved?: (plan: { title: string; content: string; summary: string; filePath: string }) => void
  onStatus?: (text: string) => void
  onRateLimit?: (waitSec: number) => void
  onRetry?: (attempt: number, reason: string, waitSec?: number) => void
  onContextUpdate?: (tokens: number) => void
  onUsage?: (promptTokens: number, completionTokens: number) => void
  onConfirm?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>
  approvalMode?: 'auto' | 'ask'
  onSpawnAgent?: (opts: { id: string; task: string; parallel?: boolean; model?: string; approvalMode?: 'auto' | 'ask' | 'full' }) => Promise<{ summary: string; error?: string }>
  onWaitAgents?: (agentIds: string[]) => Promise<Array<{ summary: string; error?: string }>>
  onGetAgentStatus?: (agentId: string) => Promise<{ status: string; currentStep?: string; stepsCount: number } | null>
  onContextCounted?: (promptTokens: number) => void
  onTodoUpdate?: (items: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>) => void
  onThinkingToken?: (token: string) => void
  onThinkingDone?: (ms: number) => void
}

export interface AgentSummaryDetails {
  modifiedFiles: string[]
  diffs: Array<{ file: string; summary: string }>
  commandsRun: Array<{ command: string; exitCode?: string; success: boolean }>
  filesRead: string[]
}

const FALLBACK_SYSTEM_PROMPT = 'You are a capable coding agent. Follow the provided system prompt and use tools when needed.'

type AgentMessage = {
  role: string
  content: string
  tool_calls?: unknown[]
  tool_call_id?: string
  name?: string
}

type NormalizedToolCall = {
  call: unknown
  callId: string
  fn: { name: string; arguments: string }
  args: Record<string, unknown>
  isHiddenTool: boolean
}

type AgentRuntimeOptions = {
  autoMemoryInterval?: number
  readFileCache?: boolean
  maxRepeatedToolCalls?: number
  maxRepeatedErrors?: number
  fileCacheSnapshot?: Record<string, FileCacheEntry>
}

type AgentToolCallFingerprint = {
  toolName: string
  argsKey: string
}

type ToolRound = {
  assistantIndex: number
  toolIndices: number[]
  toolNames: string[]
}

function normalizeToolName(name: string, schemas: Array<{ function: { name: string } }>): string {
  const knownNames = schemas.map(s => s.function.name)
  if (knownNames.includes(name)) return name

  const parts = name.split('_')
  for (let i = 1; i < parts.length; i++) {
    const candidate = parts.slice(i).join('_')
    if (knownNames.includes(candidate)) return candidate
  }

  for (let i = parts.length - 1; i > 0; i--) {
    const candidate = parts.slice(0, i).join('_')
    if (knownNames.includes(candidate)) return candidate
  }

  for (const known of knownNames) {
    if (name.includes(known)) return known
  }

  return name
}

function getToolErrorHint(toolName: string, error: string): string {
  const e = error.toLowerCase()
  if ((toolName === 'edit_file' || toolName === 'multi_edit_file') && (e.includes('not found') || e.includes('old_str'))) {
    return '\n\n[Hint: refresh the file with read_file before retrying edit_file.]'
  }
  if ((toolName === 'read_file' || toolName === 'write_file') && (e.includes('no such file') || e.includes('enoent') || e.includes('not found'))) {
    return '\n\n[Hint: locate the exact path with find_files first.]'
  }
  if (toolName === 'run_command') {
    if (e.includes('not recognized') || e.includes('command not found')) {
      return '\n\n[Hint: verify the command exists or use an installed alternative.]'
    }
    if (e.includes('permission') || e.includes('access denied')) {
      return '\n\n[Hint: the command likely needs different permissions or a safer target path.]'
    }
  }
  if (toolName === 'search_code' && (e.includes('rg') || e.includes('ripgrep') || e.includes('not found'))) {
    return '\n\n[Hint: ripgrep may be missing — try run_command with grep/Select-String as alternative.]'
  }
  if (toolName === 'http_request' && e.includes('timed out')) {
    return '\n\n[Hint: increase the timeout parameter or try a different endpoint.]'
  }
  if (toolName === 'find_files' && e.includes('not found') && e.includes('pattern')) {
    return '\n\n[Hint: use a simpler glob pattern like *.ts or a partial filename.]'
  }
  return ''
}

function isSequentialTool(name: string): boolean {
  return name === 'write_file' ||
    name === 'edit_file' ||
    name === 'multi_edit_file' ||
    name === 'run_command'
}

function stableStringify(value: unknown): string {
  if (value == null) return ''
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${stableStringify(v)}`)
    return `{${entries.join(',')}}`
  }
  return String(value)
}

function buildToolFingerprint(toolName: string, args: Record<string, unknown>): AgentToolCallFingerprint {
  const normalizedArgs: Record<string, unknown> = { ...args }
  for (const key of ['content', 'old_str', 'new_str']) {
    if (typeof normalizedArgs[key] === 'string' && normalizedArgs[key].length > 160) {
      normalizedArgs[key] = `${normalizedArgs[key].slice(0, 160)}...`
    }
  }
  return {
    toolName,
    argsKey: stableStringify(normalizedArgs),
  }
}

function getToolRounds(messages: AgentMessage[]): ToolRound[] {
  const rounds: ToolRound[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as AgentMessage & { tool_calls?: Array<{ function?: { name?: string } }> }
    if (msg.role !== 'assistant' || !msg.tool_calls?.length) continue
    const toolIndices: number[] = []
    let j = i + 1
    while (j < messages.length && messages[j].role === 'tool') {
      toolIndices.push(j)
      j++
    }
    rounds.push({
      assistantIndex: i,
      toolIndices,
      toolNames: msg.tool_calls.map(tc => tc.function?.name || 'tool'),
    })
  }
  return rounds
}

/**
 * Аварийный клапан: если токены сообщений реально подбираются к 97% лимита
 * модели — физически удаляем самые старые целые tool-раунды (assistant+tool
 * сообщения целиком), без замены на текст-резюме. Это защита от hard-fail API,
 * а не проактивное сжатие: срабатывает исключительно на грани реального предела.
 */
function dropOldestRoundsIfOverflow(
  messages: AgentMessage[],
  hardLimitTokens: number,
): AgentMessage[] {
  const estimated = messages.reduce((sum, msg) => sum + estimateTokens(msg.content || '') + 4, TOOL_SCHEMAS_OVERHEAD)
  if (estimated <= hardLimitTokens) return messages

  const rounds = getToolRounds(messages)
  if (rounds.length === 0) return messages

  // Удаляем раунды с начала (самые старые), пока не уложимся в лимит.
  // Сохраняем system-сообщения и последнее user-сообщение.
  const removeIndices = new Set<number>()
  let currentEstimate = estimated
  for (const round of rounds) {
    if (currentEstimate <= hardLimitTokens) break
    removeIndices.add(round.assistantIndex)
    for (const toolIndex of round.toolIndices) removeIndices.add(toolIndex)
    for (const idx of [round.assistantIndex, ...round.toolIndices]) {
      currentEstimate -= estimateTokens(messages[idx].content || '') + 4
    }
  }

  if (removeIndices.size === 0) return messages

  const result = messages.filter((_, index) => !removeIndices.has(index))
  // Вставляем короткую метку чтобы модель знала что старые раунды были удалены
  const firstNonSystem = result.findIndex(msg => msg.role !== 'system')
  const insertAt = firstNonSystem === -1 ? result.length : firstNonSystem
  result.splice(insertAt, 0, {
    role: 'system',
    content: `[Старые tool-раунды удалены для экономии контекста — ${removeIndices.size} сообщений]`,
  })
  return result
}

export class Agent {
  private store: Store
  private client: AIClient
  private role: 'main' | 'subagent'
  chatId?: string
  /**
   * Рабочая директория чата (режим "Код"). Когда задана, файловые тулы
   * и run_command резолвят относительные пути относительно неё вместо
   * process.cwd()/homedir(). Не задана для Work-режима и старых чатов
   * (созданных до фичи workdir) — в этом случае поведение прежнее.
   */
  workdir?: string
  onUpdateWorkingMemory?: (chatId: string, content: string, mode: 'replace' | 'append') => void
  onGetWorkingMemory?: (chatId: string) => string
  pendingDiffEntries: DiffEntry[] = []
  private readFileCache = new Map<string, string>()
  private readFileCacheEnabled = true
  private fileMap = new Map<string, { reads: number; writes: number; note: string }>()
  private recentToolFingerprints: AgentToolCallFingerprint[] = []
  private recentErrorFingerprints: string[] = []
  // §1.8 — undo/rollback: стек {path, originalContent} для отмены последних изменений
  private undoStack: Array<{ path: string; originalContent: string | null }> = []

  // Персистентный кэш read_file — переживает несколько run() вызовов,
  // инвалидация по mtime+size файла на диске.
  private fileCache = new Map<string, FileCacheEntry>()
  private dirtyFileCacheKeys = new Set<string>()

  // Журнал выполненных команд — для структурированного результата суб-агента
  private commandsRun: Array<{ command: string; exitCode?: string; success: boolean }> = []

  constructor(store: Store, role: 'main' | 'subagent' = 'main') {
    this.store = store
    this.role = role
    this.client = new AIClient(store)
  }

  async run(
    userMessage: string,
    callbacks: AgentCallbacks,
    maxSteps = 8,
    signal?: AbortSignal,
    systemPrompt?: string,
    history?: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }>,
    toolSchemas?: typeof TOOL_SCHEMAS,
    options?: AgentRuntimeOptions
  ): Promise<void> {
    const messages: AgentMessage[] = [
      { role: 'system', content: systemPrompt || FALLBACK_SYSTEM_PROMPT },
      ...(history ?? []).map(m => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.name ? { name: m.name } : {}),
      })),
      { role: 'user', content: userMessage },
    ]

    const tavilyKey = (this.store.get('integrations') as { tavily?: { key: string } } | undefined)?.tavily?.key
    const pendingParallelAgents = new Set<string>()
    const modifiedFiles = new Set<string>()
    this.readFileCacheEnabled = options?.readFileCache !== false
    this.readFileCache = new Map<string, string>()
    this.pendingDiffEntries = []
    this.fileMap = new Map()
    this.recentToolFingerprints = []
    this.recentErrorFingerprints = []
    this.commandsRun = []
    // Инициализируем персистентный кэш из снимка (передаётся из main через worker)
    this.fileCache = new Map(Object.entries(options?.fileCacheSnapshot ?? {}))
    this.dirtyFileCacheKeys = new Set()
    const ctxSettings = getContextSettings(this.store.get('contextSettings') as Partial<import('../context/contextManager').ContextSettings> ?? {})
    const activeSchemas = (toolSchemas ?? TOOL_SCHEMAS) as Array<{ function: { name: string } }>
    const autoMemoryInterval = Math.max(0, options?.autoMemoryInterval ?? 0)
    const maxRepeatedToolCalls = Math.max(2, options?.maxRepeatedToolCalls ?? 3)
    const maxRepeatedErrors = Math.max(2, options?.maxRepeatedErrors ?? 2)
    // Реальный лимит контекста активной модели — для аварийного клапана.
    const realContextWindow = getModelContextWindow({
      modelAssignments: this.store.get('modelAssignments'),
      customModels: this.store.get('customModels'),
    }, this.role)
    const contextWindow = Math.max(32_000, realContextWindow)
    // Аварийный клапан: 97% реального лимита — только отбрасывание старых раундов
    const hardLimitTokens = Math.floor(contextWindow * 0.97)

    const flushWorkingMemory = (label: string) => {
      if (!this.chatId || !this.onUpdateWorkingMemory || this.role !== 'main') return
      const existing = this.onGetWorkingMemory ? this.onGetWorkingMemory(this.chatId) : ''
      const structured = updateStructuredMemory(existing, {
        lastTask: label.slice(0, 200),
        modifiedFiles: Array.from(modifiedFiles),
        diffEntries: ctxSettings.diffJournalEnabled
          ? this.pendingDiffEntries.slice(-ctxSettings.diffJournalLines * 2)
          : [],
        fileMap: ctxSettings.fileMapEnabled ? this.fileMap : undefined,
      })
      this.onUpdateWorkingMemory(this.chatId, structured, 'replace')
    }

    for (let step = 0; ; step++) {
      if (signal?.aborted) {
        callbacks.onDone('')
        return
      }

      try {
        callbacks.onStatus?.('Ожидаю ответа...')
        const response = await this.client.chatWithTools(
          messages,
          toolSchemas ?? TOOL_SCHEMAS,
          signal,
          this.role,
          (token) => callbacks.onStep({ type: 'answer', content: token }),
          callbacks.onContextCounted,
          (waitSec) => {
            callbacks.onStatus?.(`Rate limit — жду ${waitSec}с...`)
            callbacks.onRateLimit?.(waitSec)
          },
          (attempt, reason, waitSec) => {
            callbacks.onStatus?.(reason === 'rate_limit'
              ? `Лимит запросов, повтор через ${waitSec}с...`
              : `Ошибка сети, повтор ${attempt}...`)
            callbacks.onRetry?.(attempt, reason, waitSec)
          },
          callbacks.onUsage,
          callbacks.onThinkingToken,
          callbacks.onThinkingDone,
        )

        if (signal?.aborted) {
          callbacks.onDone('')
          return
        }

        if (!response.tool_calls?.length) {
          const answer = response.content || ''

          // ── Защита от пустого ответа после reasoning ──
          // Модель (например GLM) может стримить reasoning 80+ секунд,
          // исчерпать лимит и завершить стрим с пустым content.
          // В этом случае НЕ завершаем — продолжаем цикл, даём модели
          // шанс дать ответ, добавив assistant-сообщение с reasoning
          // и user-промпт "продолжи".
          if (!answer.trim() && !signal?.aborted) {
            // Считаем, сколько раз уже пытались продолжить — чтобы не зациклиться
            const emptyRetries = (messages.filter(m =>
              m.role === 'user' && typeof m.content === 'string' &&
              m.content.startsWith('[empty-reasoning-retry]')
            ).length)
            if (emptyRetries < 2) {
              // Добавляем assistant-сообщение (чтобы модель видела свой reasoning)
              messages.push({ role: 'assistant', content: response.reasoning || '(reasoning)' })
              messages.push({
                role: 'user',
                content: '[empty-reasoning-retry] Твой предыдущий ответ содержал только рассуждение, но не содержал финального ответа. Дай краткий ответ на задачу без повторного рассуждения.',
              })
              continue
            }
            // Если уже дважды пытались — завершаем с пустым ответом
            callbacks.onDone(answer, this.buildSummaryDetails(modifiedFiles))
            return
          }

          if (pendingParallelAgents.size > 0 && callbacks.onWaitAgents) {
            const results = await callbacks.onWaitAgents(Array.from(pendingParallelAgents))
            pendingParallelAgents.clear()
            const summaries = results.map((r, i) => `Subagent ${i + 1}: ${r.summary || r.error || 'no result'}`).join('\n')
            messages.push({ role: 'user', content: `Parallel subagent results:\n${summaries}\n\nContinue and give the final answer.` })
            continue
          }

          // Reasoning уже стримится через onThinkingToken/onThinkingDone.
          // Fallback: если стриминг не настроен, шлём одним блоком.
          if (response.reasoning && !callbacks.onThinkingToken) {
            callbacks.onStep({ type: 'thought', content: response.reasoning })
          }

          if (!response.hadStreamedTokens) {
            const words = answer.split(/(?<=\s)|(?=\s)/)
            for (const chunk of words) {
              if (signal?.aborted) {
                callbacks.onDone(answer)
                return
              }
              callbacks.onStep({ type: 'answer', content: chunk })
            }
          }

          callbacks.onDone(answer, this.buildSummaryDetails(modifiedFiles))

          if (this.chatId && this.onUpdateWorkingMemory && this.role === 'main') {
            const existing = this.onGetWorkingMemory ? this.onGetWorkingMemory(this.chatId) : ''
            if (modifiedFiles.size > 0) {
              const structured = updateStructuredMemory(existing, {
                lastTask: answer.slice(0, 200),
                modifiedFiles: Array.from(modifiedFiles),
                diffEntries: ctxSettings.diffJournalEnabled ? this.pendingDiffEntries : [],
                fileMap: ctxSettings.fileMapEnabled ? this.fileMap : undefined,
              })
              this.pendingDiffEntries = []
              this.onUpdateWorkingMemory(this.chatId, structured, 'replace')
            } else if (this.fileMap.size > 0 && ctxSettings.fileMapEnabled) {
              const structured = updateStructuredMemory(existing, {
                lastTask: answer.slice(0, 200),
                modifiedFiles: [],
                diffEntries: [],
                fileMap: this.fileMap,
              })
              this.onUpdateWorkingMemory(this.chatId, structured, 'replace')
            }
          }

          return
        }

        messages.push({ role: 'assistant', content: response.content || '', tool_calls: response.tool_calls })

        const resultMap = new Map<string, { contentForAI: string; callId: string; name: string }>()
        const pendingMutations: Array<() => void> = []

        const normalizedCalls: NormalizedToolCall[] = response.tool_calls.map((call) => {
          const fn = (call as { function: { name: string; arguments: string } }).function
          const callId = (call as { id: string }).id
          const rawName = fn.name
          const normalizedName = normalizeToolName(rawName, activeSchemas)
          if (normalizedName !== rawName) {
            console.warn(`[Agent] Auto-repaired tool name: '${rawName}' -> '${normalizedName}'`)
          }
          fn.name = normalizedName

          let args: Record<string, unknown> = {}
          try { args = JSON.parse(fn.arguments) } catch {}

          return {
            call,
            callId,
            fn,
            args,
            isHiddenTool: normalizedName === 'think' || normalizedName === 'update_working_memory',
          }
        })

        const executeCall = async (item: NormalizedToolCall) => {
          const { callId, fn, args, isHiddenTool } = item
          if (!isHiddenTool) {
            const fingerprint = buildToolFingerprint(fn.name, args)
            this.recentToolFingerprints.push(fingerprint)
            if (this.recentToolFingerprints.length > maxRepeatedToolCalls) {
              this.recentToolFingerprints.shift()
            }
            const repeatedCalls = this.recentToolFingerprints.length >= maxRepeatedToolCalls &&
              this.recentToolFingerprints.every(entry =>
                entry.toolName === fingerprint.toolName && entry.argsKey === fingerprint.argsKey,
              )
            if (repeatedCalls) {
              messages.push({
                role: 'user',
                content: `Loop guard: you repeated ${fn.name} with effectively the same arguments ${maxRepeatedToolCalls} times. Stop retrying it unchanged and switch strategy.`,
              })
            }
          }
          callbacks.onStep({ type: 'tool_call', toolName: fn.name, toolArgs: args, content: fn.name, callId, hidden: isHiddenTool })

          const mode = (callbacks.approvalMode || 'auto') as 'auto' | 'ask' | 'full'
          // Читаем agentPermissions из store — раньше они были объявлены в
          // DEFAULT_SETTINGS и показаны в UI, но нигде не использовались.
          const agentPerms = (this.store.get('agentPermissions') as {
            confirmDangerous?: boolean
            dryRunMode?: boolean
            forbiddenPaths?: string[]
          } | undefined) ?? {}
          const dryRunMode = agentPerms.dryRunMode === true
          const approval = needsApproval(fn.name, args, mode, {
            confirmDangerous: agentPerms.confirmDangerous,
            forbiddenPaths: agentPerms.forbiddenPaths,
          })
          const effectiveApproval = isHiddenTool ? { confirm: false, block: false, reason: '' } : approval

          if (effectiveApproval.block) {
            const blockMsg = `Действие заблокировано (режим ${mode}): ${effectiveApproval.reason}`
            resultMap.set(callId, { contentForAI: blockMsg, callId, name: fn.name })
            callbacks.onStep({ type: 'tool_result', toolName: fn.name, content: blockMsg, success: false })
            return
          }

          if (effectiveApproval.confirm && callbacks.onConfirm) {
            const approved = await callbacks.onConfirm(fn.name, args)
            if (!approved) {
              resultMap.set(callId, { contentForAI: 'Действие отклонено пользователем.', callId, name: fn.name })
              callbacks.onStep({ type: 'tool_result', toolName: fn.name, content: 'Отклонено пользователем', success: false })
              return
            }
          }

          callbacks.onStatus?.(`${fn.name}...`)
          const result = await this.executeTool(fn.name, args, tavilyKey, callbacks, pendingParallelAgents, dryRunMode)

          if (result.success && !dryRunMode && (fn.name === 'write_file' || fn.name === 'edit_file' || fn.name === 'multi_edit_file')) {
            const p = args.path as string | undefined
            if (p) {
              const diff = (result as { diff?: string }).diff
              const origContent = (result as { originalContent?: string }).originalContent
              let diffSummary = ''
              if (ctxSettings.diffJournalEnabled) {
                if (diff) {
                  const diffLines = diff.split('\n').filter((l: string) => l.startsWith('+') || l.startsWith('-')).slice(0, ctxSettings.diffJournalLines)
                  diffSummary = diffLines.join(' | ').slice(0, 200)
                } else {
                  diffSummary = fn.name === 'write_file' ? 'created or replaced' : `changed via ${fn.name}`
                }
              }
              const fnNameCopy = fn.name
              pendingMutations.push(() => {
                modifiedFiles.add(p)
                // §1.8 — сохраняем оригинал для undo (null = файл был создан заново)
                this.undoStack.push({ path: p, originalContent: origContent ?? null })
                if (this.undoStack.length > 50) this.undoStack.shift()  // ограничиваем стек
                for (const key of Array.from(this.readFileCache.keys())) {
                  if (key.startsWith(p + ':')) this.readFileCache.delete(key)
                }
                // Инвалидируем персистентный кэш — mtime изменился, следующий read возьмёт свежие данные
                for (const fckey of Array.from(this.fileCache.keys())) {
                  if (fckey.startsWith(p + ':')) this.fileCache.delete(fckey)
                }
                if (ctxSettings.diffJournalEnabled && diffSummary) {
                  this.pendingDiffEntries.push({ file: p, summary: diffSummary })
                }
                if (ctxSettings.fileMapEnabled) {
                  const existing = this.fileMap.get(p)
                  this.fileMap.set(p, {
                    reads: existing?.reads ?? 0,
                    writes: (existing?.writes ?? 0) + 1,
                    note: existing?.note ?? fnNameCopy,
                  })
                }
              })
            }
          }

          const imageMatch = result.output?.match(/^\[IMAGE:(.+)\]$/)
          const imageUrl = imageMatch ? imageMatch[1] : undefined
          const rawContent = imageUrl
            ? 'Image generated and shown to the user.'
            : (result.success ? result.output : `Ошибка: ${result.error}`)
          const errorHint = !result.success ? getToolErrorHint(fn.name, result.error ?? '') : ''
          const contentForAI = (!imageUrl && ctxSettings.toolTruncEnabled)
            ? truncateToolResult((rawContent || '') + errorHint, ctxSettings.toolMaxChars)
            : ((rawContent || '') + errorHint)

          if (!result.success && !isHiddenTool) {
            const errorFingerprint = `${fn.name}:${(result.error ?? '').slice(0, 180)}`
            this.recentErrorFingerprints.push(errorFingerprint)
            if (this.recentErrorFingerprints.length > maxRepeatedErrors) {
              this.recentErrorFingerprints.shift()
            }
            const repeatedErrors = this.recentErrorFingerprints.length >= maxRepeatedErrors &&
              this.recentErrorFingerprints.every(entry => entry === errorFingerprint)
            if (repeatedErrors) {
              messages.push({
                role: 'user',
                content: `Loop guard: ${fn.name} produced the same error ${maxRepeatedErrors} times. Do not retry it unchanged. Use a different tool or explain the blocker.`,
              })
            }
          }

          callbacks.onStep({
            type: 'tool_result',
            toolName: fn.name,
            content: imageUrl ? 'Изображение сгенерировано' : (result.output || result.error || ''),
            success: result.success,
            imageUrl,
            diff: (result as { diff?: string }).diff,
            callId,
            hidden: isHiddenTool || !!(result as { hidden?: boolean }).hidden,
          })

          resultMap.set(callId, { contentForAI, callId, name: fn.name })
        }

        const parallelCalls = normalizedCalls.filter((item) => !isSequentialTool(item.fn.name))
        const sequentialCalls = normalizedCalls.filter((item) => isSequentialTool(item.fn.name))

        if (parallelCalls.length > 0) {
          await Promise.all(parallelCalls.map(executeCall))
        }
        for (const item of sequentialCalls) {
          await executeCall(item)
        }

        for (const mutation of pendingMutations) mutation()

        for (const item of normalizedCalls) {
          const r = resultMap.get(item.callId)
          messages.push({
            role: 'tool',
            tool_call_id: item.callId,
            name: item.fn.name,
            content: r?.contentForAI ?? '',
          })
        }

        if (autoMemoryInterval > 0 && (step + 1) % autoMemoryInterval === 0) {
          flushWorkingMemory(`Intermediate progress after ${step + 1} agent steps`)
        }

        // Аварийный клапан: только если реальные токены подбираются к 97% лимита.
        // Никакой проактивной суммаризации — модель видит свои tool-раунды как есть.
        const overflowedMessages = dropOldestRoundsIfOverflow(messages, hardLimitTokens)
        if (overflowedMessages !== messages) {
          messages.length = 0
          messages.push(...overflowedMessages)
        }

        if (callbacks.onContextUpdate) {
          const msgTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content || '') + 4, 0)
          callbacks.onContextUpdate(msgTokens + TOOL_SCHEMAS_OVERHEAD)
        }
      } catch (err) {
        const error = err as { name?: string; status?: number; message?: string }
        if (error?.name === 'AbortError' || signal?.aborted) {
          callbacks.onDone('')
          return
        }
        const status = error?.status ?? 0
        if (status >= 400 && status < 500 && status !== 429) {
          // 401/403/404 — конфиг/авторизация, нет смысла продолжать
          if (status === 401 || status === 403 || status === 404) {
            callbacks.onError(err instanceof Error ? err : new Error(`API error ${status}: ${error?.message}`))
            return
          }
          // 400/413/422 и прочие 4xx — часто это context_length_exceeded или
          // временная ошибка формата. Не останавливаем агента, даём шанс
          // продолжить — модель получит сообщение об ошибке и может
          // переформулировать запрос или обойтись без этого раунда.
          callbacks.onStep({ type: 'tool_result', toolName: '_error', content: `API error ${status}: ${error?.message || String(err)}`, success: false })
          messages.push({ role: 'user', content: `Произошла ошибка API (${status}): ${error?.message}. Продолжи работу, возможно нужно упростить запрос.` })
          continue
        }
        if (error?.message?.includes('превышено число попыток') || error?.message?.includes('number of retries')) {
          // Не останавливаем агента — просто сообщаем об ошибке и продолжаем
          // цикл. Сетевые проблемы провайдера не должны обрывать работу агента.
          callbacks.onStep({ type: 'tool_result', toolName: '_error', content: `Не удалось получить ответ после нескольких попыток. Продолжаю.`, success: false })
          messages.push({ role: 'user', content: 'Произошла сетевая ошибка: не удалось получить ответ от API после нескольких попыток. Продолжи работу.' })
          continue
        }
        callbacks.onStep({ type: 'tool_result', toolName: '_error', content: `Ошибка: ${error?.message || String(err)}`, success: false })
        messages.push({ role: 'user', content: `Произошла сетевая ошибка: ${error?.message}. Продолжи работу.` })
      }
    }
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    tavilyKey?: string,
    callbacks?: AgentCallbacks,
    pendingParallelAgents?: Set<string>,
    dryRun?: boolean
  ): Promise<ToolResult> {
    switch (name) {
      case 'run_command': {
        const cmd = (args.command ?? args.cmd ?? args.shell ?? args.script) as string | undefined
        if (!cmd || typeof cmd !== 'string') {
          return { success: false, output: '', error: `run_command: missing "command". Received: ${JSON.stringify(args)}` }
        }
        if (dryRun) {
          return { success: true, output: `[DRY RUN] Команда не выполнена. Была бы запущена:\n${cmd}`.slice(0, 4000) }
        }
        // cwd модели → workdir чата → (внутри runCommand) homedir()
        // Модель может явно переопределить cwd; иначе берём workdir чата.
        const cmdResult = await runCommand(cmd, (args.cwd as string | undefined) ?? this.workdir, args.shell as string | undefined, args.timeout as number | undefined)
        // Трекаем для структурированного результата суб-агента
        const exitMatch = cmdResult.output.match(/\[exit: (\d+)\]/)
        this.commandsRun.push({
          command: cmd,
          exitCode: exitMatch?.[1],
          success: cmdResult.success,
        })
        return cmdResult
      }
      case 'read_file': {
        const filePath = args.path as string
        const cacheKey = `${filePath}:${args.offset ?? 0}:${args.limit ?? 'all'}:${args.outline_only ? 'outline' : 'full'}`

        // 1. Быстрый in-session кэш (в рамках одного run())
        if (this.readFileCacheEnabled && this.readFileCache.has(cacheKey)) {
          return { success: true, output: this.readFileCache.get(cacheKey)! }
        }

        // 2. Персистентный кэш на весь чат — проверка по mtime+size файла на диске.
        // Ключ составной (path:offset:limit:outline) — один файл может читаться
        // разными кусками, каждый кусок кэшируется отдельно.
        if (this.readFileCacheEnabled) {
          const cached = this.fileCache.get(cacheKey)
          if (cached) {
            try {
              const stat = statSync(filePath)
              if (stat.mtimeMs === cached.mtimeMs && stat.size === cached.size) {
                // Кэш-хит — файл не менялся, отдаём закэшированный результат
                this.readFileCache.set(cacheKey, cached.output)
                return { success: true, output: cached.output }
              }
            } catch {
              // statSync упал (файл удалён?) — продолжаем к обычному чтению
            }
          }
        }

        const result = await readFile(filePath, args.offset as number | undefined, args.limit as number | undefined, args.outline_only as boolean | undefined, this.workdir)
        if (result.success) {
          if (this.readFileCacheEnabled) this.readFileCache.set(cacheKey, result.output)
          // Обновляем персистентный кэш — ключ составной
          if (this.readFileCacheEnabled) {
            try {
              const stat = statSync(filePath)
              this.fileCache.set(cacheKey, {
                mtimeMs: stat.mtimeMs,
                size: stat.size,
                output: result.output,
                cachedAt: Date.now(),
              })
              this.dirtyFileCacheKeys.add(cacheKey)
            } catch { /* ok — не критично */ }
          }
          const localCtx = getContextSettings(this.store.get('contextSettings') as Partial<import('../context/contextManager').ContextSettings> ?? {})
          if (localCtx.fileMapEnabled) {
            const existing = this.fileMap.get(filePath)
            this.fileMap.set(filePath, {
              reads: (existing?.reads ?? 0) + 1,
              writes: existing?.writes ?? 0,
              note: existing?.note || result.output.slice(0, 400).replace(/\n/g, ' '),
            })
          }
        }
        return result
      }
      case 'find_files':
        return findFiles(args.pattern as string, args.path as string, { maxResults: args.max_results as number | undefined, workdir: this.workdir })
      case 'http_request':
        return httpRequest({
          url: args.url as string,
          method: args.method as string | undefined,
          headers: args.headers as Record<string, string> | undefined,
          body: args.body as string | undefined,
          timeout: args.timeout as number | undefined,
        })
      case 'write_file':
        return writeFile(args.path as string, args.content as string, { dryRun, workdir: this.workdir })
      case 'edit_file':
        return editFile({ ...(args as Parameters<typeof editFile>[0]), dryRun, workdir: this.workdir })
      case 'multi_edit_file':
        return multiEditFile({ ...(args as Parameters<typeof multiEditFile>[0]), dryRun, workdir: this.workdir })
      case 'list_directory':
        return listDirectory(args.path as string, {
          recursive: args.recursive as boolean | undefined,
          depth: args.depth as number | undefined,
          workdir: this.workdir,
        })
      case 'search_web':
        return searchWeb(args.query as string, tavilyKey)
      case 'get_system_info':
        return getSystemInfo()
      case 'generate_image':
        return generateImage(args as { prompt: string; model?: string; size?: string; quality?: string; style?: string }, this.store)
      case 'read_files':
        return readFiles(args.paths as string[], this.workdir)
      case 'search_code':
        return searchCode(
          args.pattern as string,
          args.path as string,
          { fileGlob: args.file_glob as string | undefined, ignoreCase: args.ignore_case as boolean | undefined, maxResults: args.max_results as number | undefined, workdir: this.workdir }
        )
      case 'analyze_project':
        return analyzeProject((args.path as string) ?? this.workdir ?? '.', this.workdir)
      case 'spawn_agent': {
        if (!callbacks?.onSpawnAgent) {
          return { success: false, output: '', error: 'spawn_agent is not supported in this context' }
        }
        const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        const isParallel = !!(args.parallel ?? false)
        const result = await callbacks.onSpawnAgent({
          id: agentId,
          task: args.task as string,
          parallel: isParallel,
          model: args.model as string | undefined,
          approvalMode: args.approval_mode as 'auto' | 'ask' | 'full' | undefined,
        })
        if (result.error) return { success: false, output: '', error: result.error }
        if (isParallel) pendingParallelAgents?.add(agentId)
        return {
          success: true,
          output: isParallel
            ? `[AGENT:${agentId}] Subagent started in parallel: "${args.task}"`
            : `[AGENT:${agentId}] Subagent finished: ${result.summary}`,
        }
      }
      case 'get_agent_status': {
        if (!callbacks?.onGetAgentStatus) {
          return { success: false, output: '', error: 'get_agent_status is not supported' }
        }
        const agentId = args.agent_id as string
        const status = await callbacks.onGetAgentStatus(agentId)
        if (!status) return { success: false, output: '', error: `Agent ${agentId} not found` }
        return {
          success: true,
          output: `Agent ${agentId}: status=${status.status}, steps=${status.stepsCount}${status.currentStep ? `, current=${status.currentStep}` : ''}`,
        }
      }
      case 'update_working_memory': {
        const content = args.content as string
        const mode = (args.mode as 'replace' | 'append') ?? 'replace'
        if (!content) return { success: false, output: '', error: 'content is required' }
        if (this.chatId && this.onUpdateWorkingMemory) {
          this.onUpdateWorkingMemory(this.chatId, content, mode)
          return { success: true, output: `Working memory updated (${mode}, ${content.length} chars)`, hidden: true }
        }
        return { success: false, output: '', error: 'chatId is not set - update_working_memory unavailable' }
      }
      case 'think': {
        const thought = args.thought as string
        if (!thought) return { success: false, output: '', error: 'thought is required' }
        return { success: true, output: 'OK. Continue with the plan.', hidden: true }
      }
      case 'revert_last_change': {
        // §1.8 — undo/rollback: восстанавливаем последний изменённый файл
        const steps = args.steps as number | undefined ?? 1
        if (this.undoStack.length === 0) {
          return { success: false, output: '', error: 'Нет изменений для отката (undo-стек пуст)' }
        }
        const { writeFileSync, unlinkSync } = await import('fs')
        const reverted: string[] = []
        for (let i = 0; i < Math.min(steps, this.undoStack.length); i++) {
          const entry = this.undoStack.pop()!
          if (entry.originalContent === null) {
            // Файл был создан — удаляем
            try { unlinkSync(entry.path); reverted.push(`удалён: ${entry.path}`) }
            catch { reverted.push(`не удалось удалить: ${entry.path}`) }
          } else {
            try {
              writeFileSync(entry.path, entry.originalContent, 'utf-8')
              reverted.push(`восстановлен: ${entry.path}`)
            } catch (e: any) {
              reverted.push(`ошибка восстановления ${entry.path}: ${e.message}`)
            }
          }
          // Чистим кэш чтения для этого файла
          for (const key of Array.from(this.readFileCache.keys())) {
            if (key.startsWith(entry.path + ':')) this.readFileCache.delete(key)
          }
        }
        return { success: true, output: `Откат ${reverted.length} изменений:\n${reverted.join('\n')}` }
      }
      case 'update_todo': {
        // §3.1/§4.3 — видимый чек-лист для многошаговых задач
        const items = (args.items as Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>) ?? []
        if (callbacks?.onTodoUpdate) callbacks.onTodoUpdate(items)
        const done = items.filter(i => i.status === 'done').length
        const total = items.length
        return { success: true, output: `Todo updated: ${done}/${total} done`, hidden: true }
      }
      case 'save_plan': {
        const { savePlan } = await import('../tools/index')
        const result = await savePlan(args as { title: string; content: string; summary: string })
        if (result.success && callbacks?.onPlanSaved) {
          callbacks.onPlanSaved({
            title: args.title as string,
            content: args.content as string,
            summary: args.summary as string,
            filePath: result.output,
          })
        }
        return { success: true, output: `Plan saved: ${args.title}` }
      }
      default:
        return { success: false, output: '', error: `Unknown tool: ${name}` }
    }
  }

  /**
   * Возвращает только изменённые/новые записи персистентного кэша —
   * для передачи обратно в main-процесс через postMessage.
   */
  getFileCacheUpdates(): Record<string, FileCacheEntry> {
    const result: Record<string, FileCacheEntry> = {}
    for (const key of this.dirtyFileCacheKeys) {
      const entry = this.fileCache.get(key)
      if (entry) result[key] = entry
    }
    this.dirtyFileCacheKeys.clear()
    return result
  }

  /**
   * Структурированная выжимка действий агента — для передачи родительскому
   * агенту при spawn_agent, вместо обрезанного 500-символьного текста.
   */
  private buildSummaryDetails(modifiedFiles: Set<string>): AgentSummaryDetails {
    return {
      modifiedFiles: Array.from(modifiedFiles),
      diffs: [...this.pendingDiffEntries],
      commandsRun: [...this.commandsRun],
      filesRead: Array.from(this.fileMap.keys()),
    }
  }
}
