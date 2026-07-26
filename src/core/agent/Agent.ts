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
  httpRequest, getDiagnostics, smartTrimOutput,
  TOOL_SCHEMAS, type ToolResult, editFile, multiEditFile,
} from '../tools'
import {
  truncateToolResult, getContextSettings, estimateTokens, TOOL_SCHEMAS_OVERHEAD, getModelContextWindow,
  getHardLimitTokens, getHardLimitTargetTokens,
} from '../context/contextManager'
import { runFastContext, bumpRelevanceBoost, type FastContextResult } from '../context/fastContext'
import type { FileCacheEntry } from '../context/fileCacheTypes'
import { statSync } from 'fs'
import { createHash } from 'crypto'
import { resolve } from 'path'
import { log } from '../logger'
import type {
  AgentStep, AgentCallbacks, AgentSummaryDetails, AgentMessage,
  NormalizedToolCall, AgentRuntimeOptions, AgentToolCallFingerprint, ToolRound,
} from './types'
import {
  FALLBACK_SYSTEM_PROMPT, VERIFICATION_INTERVAL,
  normalizeToolName, findMissingRequiredArgs, getToolErrorHint, isSequentialTool,
  buildToolFingerprint, dropOldestRoundsIfOverflow, extractMcpServerName,
} from './utils'

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
  /**
   * ID проекта (из таблицы projects) — используется fast context для
   * привязки tree-sitter индекса к проекту. undefined для чатов без проекта.
   */
  projectId?: string
  /**
   * Команда авто-верификации проекта (напр. "npm test"), запускаемая
   * автоматически после VERIFICATION_INTERVAL успешных file-edit тулов —
   * упрощённый аналог PostToolUse-хука Claude Code без полной hook-инфры.
   */
  verificationCommand?: string
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
    const modifiedFiles = new Set<string>()
    let successfulEditCount = 0
    let lastVerifiedEditCount = 0
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
    const activeSchemas = (toolSchemas ?? TOOL_SCHEMAS) as Array<{ function: { name: string; parameters?: { required?: string[] } } }>
    const autoMemoryInterval = Math.max(0, options?.autoMemoryInterval ?? 0)
    const maxRepeatedToolCalls = Math.max(2, options?.maxRepeatedToolCalls ?? 3)
    const maxRepeatedErrors = Math.max(2, options?.maxRepeatedErrors ?? 2)
    // Реальный лимит контекста активной модели — для аварийного клапана.
    // Раньше здесь был Math.max(32_000, realContextWindow) — искусственный пол,
    // который мог занижать эффективный лимит для моделей с честным большим
    // окном (128k/200k/1M) до 32k, если резолвинг возвращал что-то маленькое,
    // и заставлял клапан срабатывать намного раньше, чем должен. Убран:
    // getModelContextWindow уже имеет собственный безопасный дефолт (128_000).
    const realContextWindow = getModelContextWindow({
      modelAssignments: this.store.get('modelAssignments'),
      customModels: this.store.get('customModels'),
    }, this.role)
    log('[Agent] run() старт: role=%s realContextWindow=%s', this.role, realContextWindow)
    // Аварийный клапан — последняя линия защиты от hard-fail API (см.
    // getHardLimitTokens/getHardLimitTargetTokens в usageTracker.ts).
    // targetTokens — куда дропаем при срабатывании (с запасом, гистерезис),
    // чтобы клапан не срабатывал повторно на следующем же раунде тулов.
    const hardLimitTokens = getHardLimitTokens(realContextWindow)
    const hardLimitTargetTokens = getHardLimitTargetTokens(realContextWindow)

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

      // maxSteps раньше принимался как параметр, но никогда не проверялся —
      // цикл был фактически бесконечным (агент мог гонять тулы неограниченно
      // долго без реального прогресса, что выглядело как "зависание").
      // Теперь это реальный потолок: по достижении отдаём частичный ответ.
      if (step >= maxSteps) {
        log('[Agent] run() достигнут maxSteps=%s, завершаю с частичным ответом', maxSteps)
        callbacks.onStep({
          type: 'tool_result',
          toolName: '_limit',
          content: `Достигнут лимит шагов агента (${maxSteps}). Заверши текущую работу: кратко суммируй что уже сделано, что осталось, и предложи следующие шаги. Пользователь может сказать «продолжай» — история сохранится.`,
          success: false,
        })
        callbacks.onDone(
          `Достигнут лимит в ${maxSteps} шагов агента.\n\n**Что сделано:** ${this._summarizeProgress(modifiedFiles)}\n\n**Что осталось:** смотри план выше (незавершённые пункты).\n\nСкажи «продолжай» — я подхвачу с того же места. Для больших задач эффективнее делегировать через spawn_agent, чтобы не упереться в лимит.`,
          this.buildSummaryDetails(modifiedFiles),
        )
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
          (index, rawToolName) => {
            const normalizedName = normalizeToolName(rawToolName, activeSchemas)
            const isHidden = normalizedName === 'think' || normalizedName === 'update_working_memory' || normalizedName === 'update_todo'
            if (isHidden) return
            callbacks.onStep({
              type: 'tool_call_pending',
              toolName: normalizedName,
              content: normalizedName,
              callId: `pending-${step}-${index}`,
            })
          },
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

        const normalizedCalls: NormalizedToolCall[] = response.tool_calls.map((call, callIndex) => {
          const fn = (call as { function: { name: string; arguments: string } }).function
          const callObj = call as { id: string }
          // Если стрим оборвался до того, как провайдер прислал id этого
          // tool_call, id остаётся пустой строкой — она тоже навсегда
          // попадёт в историю (assistant.tool_calls[].id и следующее
          // tool_call_id) и может быть отвергнута строгим провайдером как
          // невалидный tool_call_id. Генерируем стабильный id и мутируем
          // call.id — та же ссылка, что уже в messages.
          if (!callObj.id) {
            callObj.id = `call_${Date.now()}_${callIndex}`
          }
          const callId = callObj.id
          // response.tool_calls собран из toolCallMap (AIClient.ts) через
          // Object.values — числовые ключи объекта итерируются по возрастанию,
          // так что callIndex здесь совпадает с tc.index из onToolCallStarted.
          const pendingCallId = `pending-${step}-${callIndex}`
          const rawName = fn.name
          const normalizedName = normalizeToolName(rawName, activeSchemas)
          if (normalizedName !== rawName) {
            console.warn(`[Agent] Auto-repaired tool name: '${rawName}' -> '${normalizedName}'`)
          }
          fn.name = normalizedName

          let args: Record<string, unknown> = {}
          try {
            args = fn.arguments ? JSON.parse(fn.arguments) : {}
          } catch (parseErr) {
            // Раньше здесь был пустой catch {} — при битом/усечённом JSON
            // (например, после серии сетевых ретраев или обрыва стрима у
            // провайдера) args тихо становился {}, и дальше это выглядело
            // как "модель не умеет пользоваться тулом", хотя проблема была
            // в повреждённом ответе провайдера. Логируем сырые arguments,
            // чтобы отличать "модель реально не передала path" от
            // "JSON пришёл обрезанным/невалидным".
            log('[Agent] JSON.parse tool arguments упал для %s: %s | raw=%s',
              normalizedName, (parseErr as Error).message, (fn.arguments ?? '').slice(0, 500))
          }

          // КРИТИЧНО: fn — та же ссылка, что уже лежит внутри объекта,
          // запушенного в messages (строка выше, response.tool_calls).
          // Если оставить сырой fn.arguments (пустая строка/битый JSON от
          // обрыва стрима у провайдера), это НАВСЕГДА оседает в истории
          // диалога — sendDone() сохраняет toolSteps в БД, а следующий
          // chat:send разворачивает их обратно в такое же сообщение
          // (messageToContextMessages в chat.ipc.ts). Строгие провайдеры
          // (litellm-прокси для glm и т.п.) валидируют, что function.arguments
          // — синтаксически валидный JSON, и после этого начинают отвечать
          // 400 BadRequestError на КАЖДЫЙ следующий запрос в этом чате —
          // чат становится непригодным без возможности восстановиться.
          // Перезаписываем на гарантированно валидный JSON (то, что реально
          // распарсили и на чём агент будет исполнять тул) — так история
          // остаётся консистентной независимо от того, что вернул провайдер.
          fn.arguments = JSON.stringify(args)

          return {
            call,
            callId,
            fn,
            args,
            // update_todo тоже всегда возвращает hidden:true результат (см. case
            // 'update_todo' ниже) — если сам tool_call не помечен hidden, его
            // блок навсегда остаётся в UI без результата (ai-worker.ts не шлёт
            // hidden tool_result), и оставшийся "сирота" забирает чужую ошибку
            // через fallback-матчинг в ToolChain.tsx.
            isHiddenTool: normalizedName === 'think' || normalizedName === 'update_working_memory' || normalizedName === 'update_todo',
            pendingCallId,
          }
        })

        const executeCall = async (item: NormalizedToolCall) => {
          const { callId, fn, args, isHiddenTool, pendingCallId } = item
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
          callbacks.onStep({ type: 'tool_call', toolName: fn.name, toolArgs: args, content: fn.name, callId, hidden: isHiddenTool, pendingCallId, serverName: extractMcpServerName(fn.name) })

          const missingArgs = findMissingRequiredArgs(fn.name, args, activeSchemas)
          if (missingArgs.length > 0) {
            const missingMsg = `${fn.name}: отсутствуют обязательные аргументы: ${missingArgs.join(', ')}. Повтори вызов с полным набором аргументов.`
            resultMap.set(callId, { contentForAI: missingMsg, callId, name: fn.name })
            callbacks.onStep({ type: 'tool_result', toolName: fn.name, content: missingMsg, success: false, callId, hidden: isHiddenTool })
            return
          }

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

          // MCP-тулы: per-tool флаг requireApproval из McpManager.
          // Если true — всегда спрашиваем (независимо от mode auto/ask,
          // кроме full — там onMcpRequiresApproval не вызывается).
          const isMcpTool = fn.name.startsWith('mcp__')
          if (isMcpTool && !effectiveApproval.block && callbacks.onMcpRequiresApproval) {
            const mcpNeedsConfirm = callbacks.onMcpRequiresApproval(fn.name)
            if (mcpNeedsConfirm && mode !== 'full') {
              effectiveApproval.confirm = true
              if (!effectiveApproval.reason) effectiveApproval.reason = 'MCP-тул требует подтверждения (per-tool настройка)'
            }
          }

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
          let result: ToolResult
          try {
            result = await this.executeTool(fn.name, args, tavilyKey, callbacks, dryRunMode)
          } catch (toolErr) {
            // Раньше throw из executeTool протекал в outer try/catch и
            // интерпретировался как API/network error (emit '_error' +
            // "Сеть недоступна"). Теперь — честный tool_result с реальным
            // сообщением, агент может обработать и продолжить.
            const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr)
            result = { success: false, output: '', error: `Внутренняя ошибка тула ${fn.name}: ${errMsg}` }
          }

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
                successfulEditCount++
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
            serverName: extractMcpServerName(fn.name),
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

        if (
          this.verificationCommand &&
          this.workdir &&
          successfulEditCount - lastVerifiedEditCount >= VERIFICATION_INTERVAL
        ) {
          lastVerifiedEditCount = successfulEditCount
          const verifyResult = await runCommand(this.verificationCommand, this.workdir)
          const verifyContent = `[Auto-verification after ${VERIFICATION_INTERVAL}+ file edits]\nCommand: ${this.verificationCommand}\n\n${verifyResult.output}`
          messages.push({ role: 'user', content: verifyContent })
          callbacks.onStep({
            type: 'tool_result',
            toolName: '_verification',
            content: verifyResult.output,
            success: verifyResult.success,
          })
        }

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

        // Аварийный клапан: только если реальные токены подбираются к лимиту
        // модели. Никакой проактивной суммаризации — модель видит свои
        // tool-раунды как есть, пока не сработает клапан (с гистерезисом).
        const overflowedMessages = dropOldestRoundsIfOverflow(messages, hardLimitTokens, hardLimitTargetTokens)
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
        // cwd модели → workdir чата → (внутри runCommand/persistent shell) homedir()
        // Модель может явно переопределить cwd; иначе берём workdir чата.
        const effectiveCwd = (args.cwd as string | undefined) ?? this.workdir
        const timeoutSec = (args.timeout as number | undefined) ?? 60
        let cmdResult: ToolResult
        // Persistent shell — только для главного агента (role === 'main') и
        // только если явный shell не запрошен (powershell по умолч. на Windows
        // соответствует тому, что запускает persistent сессия).
        if (callbacks?.onShellExec && this.role === 'main' && !args.shell) {
          const shellRes = await callbacks.onShellExec(cmd, effectiveCwd, timeoutSec)
          // PTY-вывод содержит raw ANSI-коды и возможные остатки маркера
          // завершения (__SYNTEE_DONE_...:N). feedExec срезает маркер, но при
          // дроблении чанков могут остаться огрызки — вырезаем надёжно.
          const cleanShellOutput = (raw: string) => {
            const noMarker = raw.replace(/__SYNTEE_DONE_[a-f0-9]+:\d+\s*$/m, '')
            return noMarker
          }
          if (shellRes.timedOut) {
            // Сессия прервана Ctrl+C (см. PtyManager.execInSession) —
            // env/cwd сохранены, следующий run_command продолжится в ней.
            // shellRes.output содержит частичный вывод команды до прерывания.
            const partial = smartTrimOutput(cleanShellOutput(shellRes.output || ''))
            cmdResult = {
              success: false,
              output: `[timeout после ${timeoutSec}с — команда прервана Ctrl+C]\n${partial || '(нет вывода)'}`,
              error: 'Команда превысила таймаут',
            }
          } else {
            const out = smartTrimOutput(cleanShellOutput(shellRes.output)) || '(нет вывода)'
            cmdResult = shellRes.exitCode === 0
              ? { success: true, output: `[exit: 0]\n${out}` }
              : { success: false, output: `[exit: ${shellRes.exitCode}]\n${out}`, error: out.slice(0, 500) || 'Команда завершилась с ошибкой' }
          }
        } else {
          cmdResult = await runCommand(cmd, effectiveCwd, args.shell as string | undefined, timeoutSec)
        }
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
          // Relevance feedback: AI читает файл → boost для fast context ranking.
          // UPDATE ... WHERE — no-op если файла нет в индексе, безопасно.
          const rbProjectId = this.projectId
            ?? `fc:${createHash('sha1').update(resolve(this.workdir)).digest('hex').slice(0, 16)}`
          bumpRelevanceBoost(rbProjectId, filePath, 1)

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
      case 'get_diagnostics':
        return getDiagnostics((args.cwd as string | undefined) ?? this.workdir)
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
          {
            fileGlob: args.file_glob as string | undefined,
            ignoreCase: args.ignore_case as boolean | undefined,
            literal: args.literal as boolean | undefined,
            maxResults: args.max_results as number | undefined,
            context: args.context as number | undefined,
            maxChars: args.max_chars as number | undefined,
            workdir: this.workdir,
          }
        )
      case 'analyze_project':
        return analyzeProject((args.path as string) ?? this.workdir ?? '.', this.workdir)
      case 'get_fast_context': {
        // Fast context retrieval: tree-sitter индекс + fast LLM synthesis.
        // workdir обязательный — без него fallback на analyze_project.
        // projectId опциональный — если не резолвится (path-mismatch на Windows),
        // генерируем synthetic из sha1(resolve(workdir)) чтобы индекс работал.
        const fcQuery = args.query as string
        if (!fcQuery) return { success: false, output: '', error: 'query is required' }
        if (!this.workdir) {
          // Fallback: нет workdir — обычный analyze_project
          const fallback = await analyzeProject(this.workdir ?? '.', this.workdir)
          return {
            success: true,
            output: JSON.stringify({
              files: [],
              summary: 'Fast context недоступен (нет workdir). Использован analyze_project как fallback. ' + (fallback.output.slice(0, 200)),
              ms: 0,
              indexedFilesCount: 0,
              fallback: true,
            } as FastContextResult & { fallback: boolean }),
          }
        }
        // Synthetic projectId если main-процесс не смог его резолвнуть (path-mismatch).
        // tree-sitter indexing не требует реального projectId из БД — нужен только
        // как namespace key в fast_context_index таблице.
        const fcProjectId = this.projectId
          ?? `fc:${createHash('sha1').update(resolve(this.workdir)).digest('hex').slice(0, 16)}`
        const fcResult = await runFastContext(
          fcProjectId,
          this.workdir,
          fcQuery,
          this.store,
          {
            maxFiles: args.maxFiles as number | undefined,
            maxTokens: args.maxTokens as number | undefined,
            signal: callbacks?.signal,
          },
          (p) => {
            // Progress callbacks транслируем в onToolProgress (если есть)
            // для live-индикации этапов в UI
            callbacks?.onToolProgress?.({
              toolName: 'get_fast_context',
              stage: p.stage,
              detail: p.detail,
              filesProcessed: p.filesProcessed,
              filesTotal: p.filesTotal,
              filesFound: p.filesFound,
            })
          },
        )
        return {
          success: true,
          output: JSON.stringify(fcResult),
        }
      }
      case 'spawn_agent': {
        if (!callbacks?.onSpawnAgent) {
          return { success: false, output: '', error: 'spawn_agent is not supported in this context' }
        }
        const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        const result = await callbacks.onSpawnAgent({
          id: agentId,
          task: args.task as string,
          model: args.model as string | undefined,
          approvalMode: args.approval_mode as 'auto' | 'ask' | 'full' | undefined,
          isolation: args.isolation as 'auto' | 'worktree' | 'none' | undefined,
        })
        if (result.error) return { success: false, output: '', error: result.error }
        return {
          success: true,
          output: `[AGENT:${agentId}] Subagent finished: ${result.summary}`,
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
      case 'save_memory': {
        const content = args.content as string
        if (!content) return { success: false, output: '', error: 'content is required' }
        const kind = args.kind as string
        if (!kind) return { success: false, output: '', error: 'kind is required' }
        if (!callbacks?.onSaveMemory) {
          return { success: false, output: '', error: 'save_memory unavailable (no memory backend)' }
        }
        try {
          const result = await callbacks.onSaveMemory({
            content,
            kind,
            scope: args.scope as string | undefined,
            key: args.key as string | undefined,
            category: args.category as string | undefined,
            importance: args.importance as number | undefined,
            projectId: this.projectId,
            chatId: this.chatId,
          })
          if (!result.success) return { success: false, output: '', error: result.error ?? 'save failed' }
          return { success: true, output: `Saved to memory (id: ${result.id ?? '?'}, kind: ${kind})` }
        } catch (e) {
          return { success: false, output: '', error: (e as Error).message }
        }
      }
      case 'recall_memory': {
        const query = args.query as string
        if (!query) return { success: false, output: '', error: 'query is required' }
        if (!callbacks?.onRecallMemory) {
          return { success: false, output: '', error: 'recall_memory unavailable (no memory backend)' }
        }
        try {
          const result = await callbacks.onRecallMemory({
            query,
            kind: args.kind as string | undefined,
            scope: args.scope as string | undefined,
            projectId: this.projectId,
            limit: args.limit as number | undefined,
            sources: args.sources as string[] | undefined,
          })
          if (!result.success) return { success: false, output: '', error: result.error ?? 'recall failed' }
          if (result.results.length === 0) {
            return { success: true, output: 'Ничего не найдено в памяти. Попробуй другой запрос или уточни ключевые слова.' }
          }
          // Форматируем результаты для агента — группируем по источнику
          const sourceLabels: Record<string, string> = {
            memory: 'Память',
            messages: 'Сообщения',
            summaries: 'Резюме чатов',
            agent_logs: 'Логи агента',
            pinned: 'Закреплённые',
          }
          const lines: string[] = []
          let idx = 1
          // Сортируем: memory сначала (самые важные), потом по score
          const sorted = [...result.results].sort((a, b) => {
            if (a.source === 'memory' && b.source !== 'memory') return -1
            if (a.source !== 'memory' && b.source === 'memory') return 1
            return b.score - a.score
          })
          for (const r of sorted) {
            const scoreStr = r.score.toFixed(2)
            const meta: string[] = []
            if (r.chatTitle) meta.push(`чат: ${r.chatTitle}`)
            if (r.role) meta.push(r.role)
            if (r.date) {
              const dateStr = new Date(r.date).toISOString().slice(0, 10)
              meta.push(dateStr)
            }
            if (r.kind && r.source === 'memory') meta.push(`${r.kind}`)
            if (r.scope && r.source === 'memory') meta.push(r.scope)
            const metaStr = meta.length > 0 ? ` [${meta.join(', ')}]` : ''
            const titleStr = r.title ? `${r.title}: ` : ''
            const sourceLabel = sourceLabels[r.source] ?? r.source
            lines.push(`${idx}. [${sourceLabel}] (релевантность: ${scoreStr})${metaStr}`)
            lines.push(`   ${titleStr}${r.content}`)
            idx++
          }
          return { success: true, output: `Найдено ${result.results.length} результатов:\n\n${lines.join('\n')}` }
        } catch (e) {
          return { success: false, output: '', error: (e as Error).message }
        }
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
        // Тул save_plan удалён — модель пишет план прямо в ответе, обёрнутый
        // в <plan title="..." summary="...">…</plan>. Сохранение в файл
        // происходит в main/ipc/chat.ipc.ts (sendDone) после извлечения
        // <plan>-блока из ответа. Если модель всё же вызвала тул — вернём
        // подсказку, чтобы она перестала его вызывать.
        return { success: false, output: '', error: 'save_plan удалён. Пиши план прямо в ответе, обёрнутый в <plan title="..." summary="...">markdown плана</plan>. Не вызывай этот тул.' }
      }
      case 'ask_user': {
        const questions = (args.questions as import('../../shared/types').QuestionSpec[]) ?? []
        if (questions.length === 0) {
          return { success: false, output: '', error: 'ask_user: questions array is empty' }
        }
        if (!callbacks?.onQuestion) {
          return { success: false, output: '', error: 'ask_user: нет UI-обработчика (onQuestion). Действуй по разумным предположениям.' }
        }
        // Генерируем ID для вопросов без него — для маппинга ответов и showIf.
        const withIds = questions.map((q, i) => ({
          ...q,
          id: q.id || `q_${Date.now()}_${i}`,
        }))
        // Авто-detect типа: если type не указан, выводим из options.
        const typed = withIds.map(q => ({
          ...q,
          type: q.type || (q.options && q.options.length > 0 ? 'choice' : 'text'),
        }))
        try {
          const answers = await callbacks.onQuestion(typed)
          // Форматируем ответы как читаемый текст для модели + JSON для парсинга.
          const lines = answers.map(a => {
            const parts: string[] = []
            if (a.value !== undefined) parts.push(`ответ: ${a.value ? 'Да' : 'Нет'}`)
            if (a.values && a.values.length > 0) parts.push(`выбрано: ${a.values.join(', ')}`)
            if (a.text) parts.push(`текст: ${a.text}`)
            return `- [${a.id}] ${parts.join(' | ') || '(пропущено)'}`
          })
          return {
            success: true,
            output: `Пользователь ответил:\n${lines.join('\n')}\n\nJSON: ${JSON.stringify(answers)}`,
          }
        } catch (e: unknown) {
          return { success: false, output: '', error: `ask_user: ${String(e)}` }
        }
      }
      case 'get_main_chat_messages': {
        if (!callbacks?.onGetMainChatMessages) {
          return { success: false, output: '', error: 'get_main_chat_messages: нет доступа к основному чату' }
        }
        const limit = Math.min(Math.max((args.limit as number) ?? 15, 1), 50)
        const search = (args.search as string) || undefined
        const result = await callbacks.onGetMainChatMessages({ limit, search })
        return { success: true, output: result }
      }
      case 'list_extensions': {
        if (!callbacks?.onListExtensions) {
          return { success: false, output: '', error: 'list_extensions: нет доступа к расширениям' }
        }
        const report = await callbacks.onListExtensions()
        return { success: true, output: report }
      }
      case 'get_skill': {
        if (!callbacks?.onGetSkill) {
          return { success: false, output: '', error: 'get_skill: нет доступа к скиллам' }
        }
        const skillName = args.name as string
        if (!skillName) return { success: false, output: '', error: 'name обязательный параметр' }
        const instructions = await callbacks.onGetSkill(skillName)
        return { success: true, output: instructions }
      }
      default:
        // MCP-тулы: имя начинается с mcp__ — route через onMcpCall round-trip.
        if (name.startsWith('mcp__') && callbacks?.onMcpCall) {
          const result = await callbacks.onMcpCall(name, args)
          return result
        }
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
   * Возвращает копию undoStack — {path, contentBefore} для каждого файла,
   * изменённого в текущем turn'е. Используется для:
   *   - checkpoint/rewind (main-процесс сохраняет в file_snapshots)
   *   - error recovery (worker включает в error-message при падении)
   * contentBefore = null = файл был создан этим turn'ом.
   */
  getFileSnapshots(): Array<{ path: string; contentBefore: string | null }> {
    return this.undoStack.map(e => ({ path: e.path, contentBefore: e.originalContent }))
  }

  /**
   * Краткая выжимка прогресса для сообщения о достижении maxSteps.
   * Использует уже собранную статистику тулов, не парсит messages.
   */
  private _summarizeProgress(modifiedFiles: Set<string>): string {
    const parts: string[] = []
    if (modifiedFiles.size > 0) {
      parts.push(`изменено файлов: ${modifiedFiles.size} (${Array.from(modifiedFiles).slice(0, 5).join(', ')}${modifiedFiles.size > 5 ? '...' : ''})`)
    }
    if (this.commandsRun.length > 0) {
      parts.push(`выполнено команд: ${this.commandsRun.length}`)
    }
    const filesRead = this.fileMap.size
    if (filesRead > 0) {
      parts.push(`прочитано файлов: ${filesRead}`)
    }
    return parts.length > 0 ? parts.join('; ') : 'выполнена часть работы (см. лог тулов выше)'
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
      fileSnapshots: this.undoStack.map(e => ({ path: e.path, contentBefore: e.originalContent })),
    }
  }
}