import type Store from 'electron-store'
import { AIClient } from '../ai/AIClient'
import { needsApproval } from './commandSafety'
import { updateStructuredMemory } from '../context/structuredMemory'
import type { DiffEntry } from '../context/structuredMemory'
import {
  runCommand, readFile, writeFile, listDirectory,
  findFiles, getFileOutline,
  getClipboard, setClipboard, searchWeb, getSystemInfo, generateImage,
  readFiles, searchCode, analyzeProject,
  TOOL_SCHEMAS, type ToolResult, editFile, multiEditFile,
} from '../tools'
import { truncateToolResult, getContextSettings, estimateTokens, TOOL_SCHEMAS_OVERHEAD } from '../context/contextManager'

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
  onDone: (answer: string) => void
  onError: (error: Error) => void
  onPlanSaved?: (plan: { title: string; content: string; summary: string; filePath: string }) => void
  onStatus?: (text: string) => void
  onRateLimit?: (waitSec: number) => void
  onRetry?: (attempt: number, reason: string, waitSec?: number) => void
  onContextUpdate?: (tokens: number) => void
  onConfirm?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>
  approvalMode?: 'auto' | 'ask'
  onSpawnAgent?: (opts: { id: string; task: string; parallel?: boolean; model?: string }) => Promise<{ summary: string; error?: string }>
  onWaitAgents?: (agentIds: string[]) => Promise<Array<{ summary: string; error?: string }>>
  onGetAgentStatus?: (agentId: string) => Promise<{ status: string; currentStep?: string; stepsCount: number } | null>
  onContextCounted?: (promptTokens: number) => void
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
  toolSummarization?: boolean
  maxRepeatedToolCalls?: number
  maxRepeatedErrors?: number
  contextCompactionPct?: number
  preserveRecentToolRounds?: number
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
  return ''
}

function isSequentialTool(name: string): boolean {
  return name === 'write_file' ||
    name === 'edit_file' ||
    name === 'multi_edit_file' ||
    name === 'run_command' ||
    name === 'set_clipboard'
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

function summarizeToolResultForMemory(toolName: string, content: string, success: boolean): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  const short = normalized.slice(0, 180)
  const status = success ? 'ok' : 'error'

  if (toolName === 'read_file' || toolName === 'read_files') {
    const fileMatch = content.match(/\[Файл: ([^\]|]+)/)
    const file = fileMatch?.[1]?.trim()
    return `${toolName}:${status}${file ? ` ${file}` : ''}`
  }

  if (toolName === 'run_command') {
    const exitMatch = content.match(/\[exit: (\d+)\]/)
    return `${toolName}:${status} exit=${exitMatch?.[1] ?? '?'}`
  }

  return `${toolName}:${status} ${short}`
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

function summarizeToolRound(messages: AgentMessage[], round: ToolRound): string {
  const parts = round.toolIndices.map(toolIndex => {
    const toolMsg = messages[toolIndex]
    const toolName = toolMsg.name || 'tool'
    const success = !toolMsg.content.startsWith('Ошибка:')
    return summarizeToolResultForMemory(toolName, toolMsg.content || '', success)
  }).filter(Boolean)

  return parts.length > 0
    ? `[${round.toolNames.join(', ')}] ${parts.join(' | ')}`
    : `[${round.toolNames.join(', ')}]`
}

function compactAgentMessages(
  messages: AgentMessage[],
  maxPromptTokens: number,
  preserveRecentRounds: number,
): AgentMessage[] {
  const estimated = messages.reduce((sum, msg) => sum + estimateTokens(msg.content || '') + 4, TOOL_SCHEMAS_OVERHEAD)
  if (estimated <= maxPromptTokens) return messages

  const rounds = getToolRounds(messages)
  if (rounds.length <= preserveRecentRounds) return messages

  const splitIndex = Math.max(0, rounds.length - preserveRecentRounds)
  const roundsToCompress = rounds.slice(0, splitIndex)
  if (roundsToCompress.length === 0) return messages

  const compressedLines = roundsToCompress
    .map(round => summarizeToolRound(messages, round))
    .filter(Boolean)
  if (compressedLines.length === 0) return messages

  const removeIndices = new Set<number>()
  for (const round of roundsToCompress) {
    removeIndices.add(round.assistantIndex)
    for (const toolIndex of round.toolIndices) removeIndices.add(toolIndex)
  }

  const summaryMessage: AgentMessage = {
    role: 'system',
    content: `[Agent scratch summary]\n${compressedLines.join('\n')}\n[/Agent scratch summary]`,
  }

  const compacted = messages.filter((_, index) => !removeIndices.has(index))
  const firstNonSystem = compacted.findIndex(msg => msg.role !== 'system')
  const insertAt = firstNonSystem === -1 ? compacted.length : firstNonSystem
  compacted.splice(insertAt, 0, summaryMessage)
  return compacted
}

export class Agent {
  private store: Store
  private client: AIClient
  private role: 'main' | 'subagent'
  chatId?: string
  onUpdateWorkingMemory?: (chatId: string, content: string, mode: 'replace' | 'append') => void
  onGetWorkingMemory?: (chatId: string) => string
  pendingDiffEntries: DiffEntry[] = []
  private readFileCache = new Map<string, string>()
  private fileMap = new Map<string, { reads: number; writes: number; note: string }>()
  private recentToolFingerprints: AgentToolCallFingerprint[] = []
  private recentErrorFingerprints: string[] = []

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
    history?: Array<{ role: string; content: string }>,
    toolSchemas?: typeof TOOL_SCHEMAS,
    options?: AgentRuntimeOptions
  ): Promise<void> {
    const messages: AgentMessage[] = [
      { role: 'system', content: systemPrompt || FALLBACK_SYSTEM_PROMPT },
      ...(history ?? []).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMessage },
    ]

    const tavilyKey = (this.store.get('integrations') as { tavily?: { key: string } } | undefined)?.tavily?.key
    const pendingParallelAgents = new Set<string>()
    const modifiedFiles = new Set<string>()
    const useCache = options?.readFileCache !== false
    this.readFileCache = useCache ? new Map<string, string>() : new Map()
    this.pendingDiffEntries = []
    this.fileMap = new Map()
    this.recentToolFingerprints = []
    this.recentErrorFingerprints = []
    const useSummarization = options?.toolSummarization === true
    const ctxSettings = getContextSettings(this.store.get('contextSettings') as Partial<import('../context/contextManager').ContextSettings> ?? {})
    const activeSchemas = (toolSchemas ?? TOOL_SCHEMAS) as Array<{ function: { name: string } }>
    const autoMemoryInterval = Math.max(0, options?.autoMemoryInterval ?? 0)
    const maxRepeatedToolCalls = Math.max(2, options?.maxRepeatedToolCalls ?? 3)
    const maxRepeatedErrors = Math.max(2, options?.maxRepeatedErrors ?? 2)
    const contextWindow = Math.max(32_000, ctxSettings.contextLimitTokens)
    const contextCompactionPct = Math.min(95, Math.max(50, options?.contextCompactionPct ?? 75))
    const preserveRecentToolRounds = Math.max(2, options?.preserveRecentToolRounds ?? 8)
    const maxPromptTokensBeforeCompact = Math.floor(contextWindow * contextCompactionPct / 100)

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

    for (let step = 0; step < maxSteps; step++) {
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
        )

        if (signal?.aborted) {
          callbacks.onDone('')
          return
        }

        if (!response.tool_calls?.length) {
          const answer = response.content || ''

          if (pendingParallelAgents.size > 0 && callbacks.onWaitAgents) {
            const results = await callbacks.onWaitAgents(Array.from(pendingParallelAgents))
            pendingParallelAgents.clear()
            const summaries = results.map((r, i) => `Subagent ${i + 1}: ${r.summary || r.error || 'no result'}`).join('\n')
            messages.push({ role: 'user', content: `Parallel subagent results:\n${summaries}\n\nContinue and give the final answer.` })
            continue
          }

          if (response.reasoning) {
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

          callbacks.onDone(answer)

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
          const approval = needsApproval(fn.name, args, mode)
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
          const result = await this.executeTool(fn.name, args, tavilyKey, callbacks, pendingParallelAgents)

          if (result.success && (fn.name === 'write_file' || fn.name === 'edit_file' || fn.name === 'multi_edit_file')) {
            const p = args.path as string | undefined
            if (p) {
              const diff = (result as { diff?: string }).diff
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
                for (const key of Array.from(this.readFileCache.keys())) {
                  if (key.startsWith(p + ':')) this.readFileCache.delete(key)
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

        const compactedMessages = compactAgentMessages(messages, maxPromptTokensBeforeCompact, preserveRecentToolRounds)
        if (compactedMessages !== messages) {
          messages.length = 0
          messages.push(...compactedMessages)
        }

        const toolMsgCount = messages.filter(m => m.role === 'tool' || (m.role === 'assistant' && (m as { tool_calls?: unknown[] }).tool_calls?.length)).length
        if (useSummarization && toolMsgCount > preserveRecentToolRounds * 2) {
          const summarized = compactAgentMessages(messages, maxPromptTokensBeforeCompact, preserveRecentToolRounds)
          if (summarized !== messages) {
            messages.length = 0
            messages.push(...summarized)
          }
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
          callbacks.onError(err instanceof Error ? err : new Error(`API error ${status}: ${error?.message}`))
          return
        }
        if (error?.message?.includes('превышено число попыток') || error?.message?.includes('number of retries')) {
          callbacks.onError(new Error('Не удалось получить ответ от AI после нескольких попыток.'))
          return
        }
        callbacks.onStep({ type: 'tool_result', toolName: '_error', content: `Ошибка: ${error?.message || String(err)}`, success: false })
        if (step >= maxSteps - 1) {
          callbacks.onError(new Error(`Агент завершился с ошибкой: ${error?.message || String(err)}`))
          return
        }
        messages.push({ role: 'user', content: `Произошла сетевая ошибка: ${error?.message}. Продолжи работу.` })
      }
    }

    callbacks.onError(new Error('Превышено максимальное количество шагов агента'))
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    tavilyKey?: string,
    callbacks?: AgentCallbacks,
    pendingParallelAgents?: Set<string>
  ): Promise<ToolResult> {
    switch (name) {
      case 'run_command': {
        const cmd = (args.command ?? args.cmd ?? args.shell ?? args.script) as string | undefined
        if (!cmd || typeof cmd !== 'string') {
          return { success: false, output: '', error: `run_command: missing "command". Received: ${JSON.stringify(args)}` }
        }
        return runCommand(cmd, args.cwd as string | undefined, args.shell as string | undefined, args.timeout as number | undefined)
      }
      case 'read_file': {
        const filePath = args.path as string
        const cacheKey = `${filePath}:${args.offset ?? 0}:${args.limit ?? 'all'}`
        if (this.readFileCache.has(cacheKey)) {
          return { success: true, output: this.readFileCache.get(cacheKey)! }
        }
        const result = await readFile(filePath, args.offset as number | undefined, args.limit as number | undefined, args.outline_only as boolean | undefined)
        if (result.success) {
          this.readFileCache.set(cacheKey, result.output)
          const localCtx = getContextSettings(this.store.get('contextSettings') as Partial<import('../context/contextManager').ContextSettings> ?? {})
          if (localCtx.fileMapEnabled) {
            const existing = this.fileMap.get(filePath)
            this.fileMap.set(filePath, {
              reads: (existing?.reads ?? 0) + 1,
              writes: existing?.writes ?? 0,
              note: existing?.note || result.output.slice(0, 200).replace(/\n/g, ' '),
            })
          }
        }
        return result
      }
      case 'find_files':
        return findFiles(args.pattern as string, args.path as string, { maxResults: args.max_results as number | undefined })
      case 'get_file_outline':
        return getFileOutline(args.path as string)
      case 'write_file':
        return writeFile(args.path as string, args.content as string)
      case 'edit_file':
        return editFile(args as Parameters<typeof editFile>[0])
      case 'multi_edit_file':
        return multiEditFile(args as Parameters<typeof multiEditFile>[0])
      case 'list_directory':
        return listDirectory(args.path as string, {
          recursive: args.recursive as boolean | undefined,
          depth: args.depth as number | undefined,
        })
      case 'get_clipboard':
        return getClipboard()
      case 'set_clipboard':
        return setClipboard(args.text as string)
      case 'search_web':
        return searchWeb(args.query as string, tavilyKey)
      case 'get_system_info':
        return getSystemInfo()
      case 'generate_image':
        return generateImage(args as { prompt: string; model?: string; size?: string; quality?: string; style?: string }, this.store)
      case 'read_files':
        return readFiles(args.paths as string[])
      case 'search_code':
        return searchCode(
          args.pattern as string,
          args.path as string,
          { fileGlob: args.file_glob as string | undefined, ignoreCase: args.ignore_case as boolean | undefined, maxResults: args.max_results as number | undefined }
        )
      case 'analyze_project':
        return analyzeProject(args.path as string)
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
      case 'save_plan': {
        const { savePlan } = await import('../tools/index')
        const result = savePlan(args as { title: string; content: string; summary: string })
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
}
