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
import type { ApprovalMode } from '../../shared/types'
import { truncateToolResult, getContextSettings } from '../context/contextManager'

export interface AgentStep {
  type: 'thought' | 'tool_call' | 'tool_result' | 'answer'
  toolName?: string
  toolArgs?: Record<string, unknown>
  content: string
  success?: boolean
  imageUrl?: string
  diff?: string
  callId?: string
  hidden?: boolean  // скрытые тулы (think, update_working_memory) — не показываются в UI
}

export interface AgentCallbacks {
  onStep: (step: AgentStep) => void
  onDone: (answer: string) => void
  onError: (error: Error) => void
  onPlanSaved?: (plan: { title: string; content: string; summary: string; filePath: string }) => void
  onStatus?: (text: string) => void
  onRateLimit?: (waitSec: number) => void
  onRetry?: (attempt: number, reason: string, waitSec?: number) => void
  onConfirm?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>
  approvalMode?: 'auto' | 'ask'
  onSpawnAgent?: (opts: { id: string; task: string; parallel?: boolean; model?: string }) => Promise<{ summary: string; error?: string }>
  onWaitAgents?: (agentIds: string[]) => Promise<Array<{ summary: string; error?: string }>>
  onGetAgentStatus?: (agentId: string) => Promise<{ status: string; currentStep?: string; stepsCount: number } | null>
  onContextCounted?: (promptTokens: number) => void  // tiktoken подсчёт реального запроса перед каждым раундом
}

const SYSTEM_PROMPT = `Ты Syntee — автономный AI-агент для Windows. Решаешь задачи через инструменты: файлы, команды, поиск, система.

## Режим работы

Ты агент, не чат-бот. Получив задачу — действуй, не объясняй что собираешься делать.

**Перед первым действием используй think** — набрось план: что нужно понять, какие файлы прочитать, какой порядок шагов. Это занимает 0 токенов у пользователя но резко улучшает качество.

**Правила выполнения:**
- Параллельность — ВСЕГДА. Нужно прочитать 3 файла? Вызывай все три одновременно, не по очереди.
- Независимые команды — запускай параллельно. Зависимые (B нужен результат A) — последовательно.
- Не спрашивай разрешения на очевидные шаги. Просто делай.
- Не пиши "Сейчас я сделаю X" — просто сделай X.
- После выполнения — краткий итог что сделано. Не пересказывай каждый шаг.

**При ошибке тула:**
- Прочитай error внимательно — там обычно есть подсказка.
- Не повторяй ту же команду. Исправь причину ошибки.
- Если файл не найден — сначала найди его через find_files.
- Если edit_file не нашёл old_str — прочитай файл заново, old_str мог устареть.

**При работе с кодом:**
- Сначала используй think чтобы понять архитектуру.
- Читай только нужные части файлов (offset/limit), не весь файл целиком.
- После изменения файла — diff уже в ответе тула, не нужно читать файл снова.
- Изменяй только то что нужно. Не переписывай файл целиком если можно edit_file.

**Рабочая память:**
- В конце сложной сессии с изменениями файлов — вызови update_working_memory.
- Пиши компактно: что изменил, в каком состоянии проект, что осталось.

## Форматирование ответов

**Диаграммы (Mermaid)** — для схем, графов, архитектуры:
\`\`\`mermaid
flowchart TD
  A[Начало] --> B[Шаг]
\`\`\`
Типы: flowchart, sequenceDiagram, classDiagram, gantt, pie, gitGraph.

**Цветные блоки:**
:::note / :::tip / :::warning / :::danger / :::info

**Diff** — для показа изменений:
\`\`\`diff
- старая строка
+ новая строка
\`\`\`

**Таблицы** — markdown для структурированных данных.
**Математика** — LaTeX: \`$E=mc^2$\`, \`$$\\frac{a}{b}$$\`.
**Код** — всегда указывай язык: \`\`\`typescript, \`\`\`bash, \`\`\`python.

## Система (Windows 10)

- Команды: PowerShell по умолчанию. Unix-команды (ls, cat, grep) тоже работают.
- Пути: \`C:\\Users\\....\` или \`/c/Users/...\` — оба формата OK.
- Переменные: \`$env:USERPROFILE\`, \`$env:APPDATA\`.`

// Нормализация имени тула — убирает любые префиксы/суффиксы которые провайдеры добавляют
// Берёт актуальные имена из переданных схем динамически
// Например: u_read_file -> read_file, hermes_run_command -> run_command
function normalizeToolName(name: string, schemas: Array<{ function: { name: string } }>): string {
  const knownNames = schemas.map(s => s.function.name)
  // Точное совпадение
  if (knownNames.includes(name)) return name
  // Убираем любой префикс до первого _ и проверяем остаток
  // Работает с любым префиксом: u_, hermes_, tools_, custom_, etc.
  const parts = name.split('_')
  for (let i = 1; i < parts.length; i++) {
    const candidate = parts.slice(i).join('_')
    if (knownNames.includes(candidate)) return candidate
  }
  // Убираем любой суффикс после последнего _ и проверяем
  for (let i = parts.length - 1; i > 0; i--) {
    const candidate = parts.slice(0, i).join('_')
    if (knownNames.includes(candidate)) return candidate
  }
  // Substring match — имя тула содержится как подстрока
  for (const known of knownNames) {
    if (name.includes(known)) return known
  }
  // Не распознали — возвращаем как есть
  return name
}

// Подсказки агенту при ошибках тулов — помогают исправить без лишних итераций
function getToolErrorHint(toolName: string, error: string): string {
  const e = error.toLowerCase()
  if (toolName === 'edit_file' || toolName === 'multi_edit_file') {
    if (e.includes('old_str не найден') || e.includes('not found')) {
      return '\n\n[Hint: old_str не найден. Используй read_file чтобы получить актуальное содержимое файла, потом повтори edit_file с точным фрагментом.]'
    }
  }
  if (toolName === 'read_file' || toolName === 'write_file') {
    if (e.includes('no such file') || e.includes('не найден') || e.includes('enoent')) {
      return '\n\n[Hint: файл не найден. Используй find_files чтобы найти правильный путь.]'
    }
  }
  if (toolName === 'run_command') {
    if (e.includes('not recognized') || e.includes('не является') || e.includes('command not found')) {
      return '\n\n[Hint: команда не найдена. Проверь что инструмент установлен, или используй альтернативную команду.]'
    }
    if (e.includes('permission') || e.includes('access denied') || e.includes('доступ запрещён')) {
      return '\n\n[Hint: нет прав доступа. Попробуй с правами администратора или измени путь.]'
    }
  }
  return ''
}

export class Agent {
  private store: Store
  private client: AIClient
  private role: 'main' | 'subagent'
  chatId?: string
  onUpdateWorkingMemory?: (chatId: string, content: string, mode: 'replace' | 'append') => void
  onGetWorkingMemory?: (chatId: string) => string
  pendingDiffEntries: DiffEntry[] = []
  // Кэш read_file — сбрасывается при каждом run() — избегает повторных чтений
  private readFileCache = new Map<string, string>()
  // File map — файлы которые AI трогал в этом run
  private fileMap = new Map<string, { reads: number; writes: number; note: string }>()

  constructor(store: Store, role: 'main' | 'subagent' = 'main') {
    this.store = store
    this.role = role
    this.client = new AIClient(store)
  }

  async run(userMessage: string, callbacks: AgentCallbacks, maxSteps = 8, signal?: AbortSignal, systemPrompt?: string, history?: Array<{ role: string; content: string }>, toolSchemas?: typeof TOOL_SCHEMAS, options?: { autoMemoryInterval?: number; readFileCache?: boolean; toolSummarization?: boolean }): Promise<void> {
    const messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }> = [
      { role: 'system', content: systemPrompt || SYSTEM_PROMPT },
      // История как нормальные role: user/assistant сообщения
      ...(history ?? []).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMessage },
    ]

    const tavilyKey = (this.store.get('integrations') as { tavily?: { key: string } })?.tavily?.key

    // Трекаем параллельные агенты — ждём их перед финальным ответом
    const pendingParallelAgents = new Set<string>()

    // Трекаем изменённые файлы для авто-обновления рабочей памяти
    const modifiedFiles = new Set<string>()
    let toolCallCount = 0
    // Кэш прочитанных файлов (можно отключить через настройки)
    const useCache = options?.readFileCache !== false
    const readFileCache = useCache ? new Map<string, string>() : new Map<string, string>()
    this.readFileCache = useCache ? readFileCache : new Map()
    this.pendingDiffEntries = []
    this.fileMap = new Map()
    const autoMemInterval = options?.autoMemoryInterval ?? 5
    const useSummarization = options?.toolSummarization !== false
    // Фикс 4: вынести getContextSettings из цикла — читаем store один раз
    const ctxSettings = getContextSettings(this.store.get('contextSettings') as Partial<import('../context/contextManager').ContextSettings> ?? {})

    for (let step = 0; step < maxSteps; step++) {
      // Проверяем abort перед каждым шагом
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

        // Abort во время запроса
        if (signal?.aborted) { callbacks.onDone(''); return }

        // Если нет tool_calls — финальный ответ
        if (!response.tool_calls?.length) {
          const answer = response.content || ''

          // Ждём параллельных суб-агентов
          if (pendingParallelAgents.size > 0 && callbacks.onWaitAgents) {
            const results = await callbacks.onWaitAgents(Array.from(pendingParallelAgents))
            pendingParallelAgents.clear()
            const summaries = results.map((r, i) => `Суб-агент ${i + 1}: ${r.summary || r.error || 'нет результата'}`).join('\n')
            messages.push({ role: 'user', content: `Результаты параллельных суб-агентов:\n${summaries}\n\nПродолжи и дай финальный ответ.` })
            continue
          }

          // Reasoning
          if (response.reasoning) {
            callbacks.onStep({ type: 'thought', content: response.reasoning })
          }

          // Если токены уже отстримились через onToken — не дублируем
          if (!response.hadStreamedTokens) {
            const words = answer.split(/(?<=\s)|(?=\s)/)
            for (const chunk of words) {
              if (signal?.aborted) { callbacks.onDone(answer); return }
              callbacks.onStep({ type: 'answer', content: chunk })
            }
          }

          callbacks.onDone(answer)

          // Авто-обновление рабочей памяти если были изменения файлов
          if (modifiedFiles.size > 0 && this.chatId && this.onUpdateWorkingMemory && this.role === 'main') {
            const ctxS = getContextSettings(this.store.get('contextSettings') as Partial<import('../context/contextManager').ContextSettings> ?? {})

            const existing = this.onGetWorkingMemory ? this.onGetWorkingMemory(this.chatId) : ''
            console.log('[agent] updating structured memory, files:', Array.from(modifiedFiles).join(', '))
            const structured = updateStructuredMemory(existing, {
              lastTask: answer.slice(0, 200),
              modifiedFiles: Array.from(modifiedFiles),
              diffEntries: ctxS.diffJournalEnabled ? this.pendingDiffEntries : [],
              fileMap: ctxS.fileMapEnabled ? this.fileMap : undefined,
            })
            this.pendingDiffEntries = []
            this.onUpdateWorkingMemory(this.chatId, structured, 'replace')
          }

          return
        }

        // Есть tool_calls — сохраняем в messages
        // content НЕ стримился (hasToolCalls=true в AIClient), так и должно быть
        messages.push({ role: 'assistant', content: response.content || '', tool_calls: response.tool_calls })

        // Все tool_calls этой итерации — выполняем параллельно
        const resultMap = new Map<string, { contentForAI: string; callId: string; name: string }>()
        // Мутации state (cache, fileMap, modifiedFiles) — применяем после Promise.all чтобы избежать race condition
        const pendingMutations: Array<() => void> = []

        await Promise.all(response.tool_calls.map(async (call) => {
          const fn = (call as { function: { name: string; arguments: string } }).function
          const callId = (call as { id: string }).id
          // Нормализуем имя тула — фикс для провайдеров которые добавляют префиксы (u_, hermes_ и т.д.)
          const rawName = fn.name
          const activeSchemas = (toolSchemas ?? TOOL_SCHEMAS) as Array<{ function: { name: string } }>
          fn.name = normalizeToolName(rawName, activeSchemas)
          if (fn.name !== rawName) {
            console.warn(`[Agent] Auto-repaired tool name: '${rawName}' -> '${fn.name}'`)
          }
          let args: Record<string, unknown> = {}
          try { args = JSON.parse(fn.arguments) } catch {}

          // Скрытые тулы (think, update_working_memory) — не показываем в UI
          const isHiddenTool = fn.name === 'think' || fn.name === 'update_working_memory'

          callbacks.onStep({ type: 'tool_call', toolName: fn.name, toolArgs: args, content: fn.name, callId, hidden: isHiddenTool })

          const mode = (callbacks.approvalMode || 'auto') as 'auto' | 'ask' | 'full'
          const approval = needsApproval(fn.name, args, mode)

          // Скрытые тулы (think, update_working_memory) никогда не спрашиваем
          const effectiveApproval = isHiddenTool
            ? { confirm: false, block: false, reason: '' }
            : approval

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

          // Трекаем изменённые файлы — через pendingMutations (race condition safe)
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
                  diffSummary = fn.name === 'write_file' ? 'создан/перезаписан' : `изменён (${fn.name})`
                }
              }
              const fnNameCopy = fn.name
              pendingMutations.push(() => {
                modifiedFiles.add(p)
                // Инвалидируем кэш
                for (const key of Array.from(this.readFileCache.keys())) {
                  if (key.startsWith(p + ':')) this.readFileCache.delete(key)
                }
                if (ctxSettings.diffJournalEnabled && diffSummary) {
                  console.log('[agent] diff journal:', p, '->', diffSummary)
                  this.pendingDiffEntries.push({ file: p, summary: diffSummary })
                }
                if (ctxSettings.fileMapEnabled) {
                  const existing = this.fileMap.get(p)
                  this.fileMap.set(p, { reads: existing?.reads ?? 0, writes: (existing?.writes ?? 0) + 1, note: existing?.note ?? fnNameCopy })
                }
              })
            }
          }
          // File Map — трекаем read_file
          if (result.success && fn.name === 'read_file') {
            const p = args.path as string | undefined
            if (p && ctxSettings.fileMapEnabled) {
              pendingMutations.push(() => {
                const existing = this.fileMap.get(p)
                this.fileMap.set(p, { reads: (existing?.reads ?? 0) + 1, writes: existing?.writes ?? 0, note: existing?.note ?? '' })
              })
            }
          }

          const imageMatch = result.output?.match(/^\[IMAGE:(.+)\]$/)
          const imageUrl = imageMatch ? imageMatch[1] : undefined

          // Tool result truncation — используем ctxSettings из внешнего scope
          const rawContent = imageUrl
            ? 'Изображение успешно сгенерировано и показано пользователю.'
            : (result.success ? result.output : `Ошибка: ${result.error}`)

          // При ошибке тула — добавляем подсказку агенту как исправить
          const errorHint = !result.success ? getToolErrorHint(fn.name, result.error ?? '') : ''
          const contentForAI = (!imageUrl && ctxSettings.toolTruncEnabled)
            ? truncateToolResult((rawContent || '') + errorHint, ctxSettings.toolMaxChars)
            : ((rawContent || '') + errorHint)

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
          toolCallCount++
        }))

        // Применяем мутации state после всех параллельных тулов — race condition safe
        for (const mutation of pendingMutations) mutation()

        // Авто-память каждые N тулвызовов — сохраняем прогресс
        if (autoMemInterval > 0 && toolCallCount > 0 && toolCallCount % autoMemInterval === 0 &&
            this.chatId && this.onUpdateWorkingMemory) {
          const recentActions = Array.from(resultMap.values())
            .slice(-autoMemInterval)
            .filter(r => !r.contentForAI.startsWith('[кэш]'))  // фикс 7: не пишем кэш-хиты в память
            .map(r => `- ${r.name}: ${r.contentForAI.slice(0, 100)}`)
            .join('\n')
          this.onUpdateWorkingMemory(
            this.chatId,
            `[авто, шаг ${toolCallCount}] Последние действия:\n${recentActions}`,
            'append'
          )
        }

        // Пушим tool results в том же порядке что и tool_calls — важно для провайдеров
        for (const call of response.tool_calls) {
          const callId = (call as { id: string }).id
          const fn = (call as { function: { name: string; arguments: string } }).function
          const r = resultMap.get(callId)
          messages.push({
            role: 'tool',
            tool_call_id: callId,
            name: fn.name,
            content: r?.contentForAI ?? '',
          })
        }

        // Tool result summarization — сжимаем старые раунды если messages > 12
        // Оставляем system + history + user + последние 3 раунда полными
        const KEEP_FULL_ROUNDS = 3
        const toolMsgCount = messages.filter(m => m.role === 'tool' || (m.role === 'assistant' && (m as { tool_calls?: unknown[] }).tool_calls?.length)).length
        if (useSummarization && toolMsgCount > KEEP_FULL_ROUNDS * 2) {
          // Находим первый assistant с tool_calls (начало старых раундов)
          let oldRoundsCompressed = 0
          const compressed: string[] = []
          const toRemove = new Set<number>()
          for (let i = 0; i < messages.length; i++) {
            const m = messages[i]
            const asst = m as { role: string; tool_calls?: Array<{ function: { name: string } }> }
            if (asst.role === 'assistant' && asst.tool_calls?.length && oldRoundsCompressed < toolMsgCount - KEEP_FULL_ROUNDS * 2) {
              // Сжимаем этот раунд
              const names = asst.tool_calls.map(tc => tc.function.name).join(', ')
              // Ищем tool results после этого assistant
              let j = i + 1
              const results: string[] = []
              while (j < messages.length && messages[j].role === 'tool') {
                const content = (messages[j].content as string) ?? ''
                results.push(content.slice(0, 400))  // фикс 2: было 60, теперь 400
                toRemove.add(j)
                j++
              }
              compressed.push(`[${names}]: ${results.join(' | ')}`)
              toRemove.add(i)
              oldRoundsCompressed++
            }
          }
          if (compressed.length > 0) {
            const summaryMsg = { role: 'assistant' as const, content: `[Предыдущие действия]\n${compressed.join('\n')}` }
            const newMessages = messages.filter((_, i) => !toRemove.has(i))
            // Фикс 3: вставляем summary ПЕРЕД user message, не после
            const insertIdx = newMessages.findIndex(m => m.role === 'user')
            const safeIdx = insertIdx === -1 ? newMessages.length : insertIdx
            newMessages.splice(safeIdx, 0, summaryMsg)
            messages.length = 0
            messages.push(...newMessages)
          }
        }
      } catch (err) {
        const error = err as { name?: string; status?: number; message?: string }
        // AbortError — тихо выходим
        if (error?.name === 'AbortError' || signal?.aborted) {
          callbacks.onDone('')
          return
        }
        // Фатальная API ошибка (4xx кроме 429) — сообщаем и выходим
        const status = error?.status ?? 0
        if (status >= 400 && status < 500 && status !== 429) {
          callbacks.onError(err instanceof Error ? err : new Error(`API ошибка ${status}: ${error?.message}`))
          return
        }
        // Превышено число попыток в chatWithTools — сообщаем
        if (error?.message?.includes('превышено число попыток')) {
          callbacks.onError(new Error(`Не удалось получить ответ от AI после нескольких попыток. Проверь соединение и провайдера.`))
          return
        }
        // Остальные ошибки (сетевые, таймаут) — логируем в step и продолжаем если есть шаги
        callbacks.onStep({ type: 'tool_result', toolName: '_error', content: `Ошибка: ${error?.message || String(err)}`, success: false })
        if (step >= maxSteps - 1) {
          callbacks.onError(new Error(`Агент завершился с ошибкой: ${error?.message || String(err)}`))
          return
        }
        // Даём агенту знать об ошибке и продолжаем
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
          return { success: false, output: '', error: `run_command: поле "command" не передано. Получены аргументы: ${JSON.stringify(args)}` }
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
        if (result.success) this.readFileCache.set(cacheKey, result.output)
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
          return { success: false, output: '', error: 'spawn_agent не поддерживается в этом контексте' }
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
        // Трекаем параллельных — будем ждать перед финальным ответом
        if (isParallel) pendingParallelAgents.add(agentId)
        return {
          success: true,
          output: isParallel
            ? `[AGENT:${agentId}] Суб-агент запущен параллельно: "${args.task}"`
            : `[AGENT:${agentId}] Суб-агент завершил: ${result.summary}`,
        }
      }
      case 'get_agent_status': {
        if (!callbacks?.onGetAgentStatus) {
          return { success: false, output: '', error: 'get_agent_status не поддерживается' }
        }
        const agentId = args.agent_id as string
        const status = await callbacks.onGetAgentStatus(agentId)
        if (!status) return { success: false, output: '', error: `Агент ${agentId} не найден` }
        return {
          success: true,
          output: `Агент ${agentId}: статус=${status.status}, шагов=${status.stepsCount}${status.currentStep ? `, текущий шаг=${status.currentStep}` : ''}`,
        }
      }
      default:
        return { success: false, output: '', error: `Неизвестный инструмент: ${name}` }

      case 'update_working_memory': {
        const content = args.content as string
        const mode = (args.mode as 'replace' | 'append') ?? 'replace'
        if (!content) return { success: false, output: '', error: 'content обязателен' }
        if (this.chatId && this.onUpdateWorkingMemory) {
          this.onUpdateWorkingMemory(this.chatId, content, mode)
          return { success: true, output: `Рабочая память обновлена (${mode}, ${content.length} символов)`, error: '', hidden: true }
        }
        return { success: false, output: '', error: 'chatId не установлен — update_working_memory недоступен' }
      }

      case 'think': {
        const thought = args.thought as string
        if (!thought) return { success: false, output: '', error: 'thought обязателен' }
        return { success: true, output: `OK. Продолжай по плану.`, error: '', hidden: true }
      }
      case 'save_plan': {
        const { savePlan } = await import('../tools/index')
        const result = savePlan(args as { title: string; content: string; summary: string })
        if (result.success && callbacks.onPlanSaved) {
          callbacks.onPlanSaved({
            title: args.title as string,
            content: args.content as string,
            summary: args.summary as string,
            filePath: result.output,
          })
        }
        return { success: true, output: `План сохранён: ${args.title}` }
      }
    }
  }
}
