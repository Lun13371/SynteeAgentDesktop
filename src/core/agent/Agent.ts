import type Store from 'electron-store'
import { AIClient } from '../ai/AIClient'
import {
  runCommand, readFile, writeFile, listDirectory,
  getClipboard, setClipboard, searchWeb, getSystemInfo, generateImage,
  readFiles, searchCode, analyzeProject,
  TOOL_SCHEMAS, type ToolResult,
} from '../tools'
import type { ApprovalMode } from '../../shared/types'

export interface AgentStep {
  type: 'thought' | 'tool_call' | 'tool_result' | 'answer'
  toolName?: string
  toolArgs?: Record<string, unknown>
  content: string
  success?: boolean
  imageUrl?: string
}

export interface AgentCallbacks {
  onStep: (step: AgentStep) => void
  onDone: (answer: string) => void
  onError: (err: Error) => void
  onConfirm?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>
  approvalMode?: string
  onSpawnAgent?: (opts: { id: string; task: string; parallel: boolean; model?: string }) => Promise<{ summary: string; error?: string }>
  onWaitAgents?: (agentIds: string[]) => Promise<Array<{ summary: string; error?: string }>>
  onGetAgentStatus?: (agentId: string) => { status: string; currentStep?: string; stepsCount: number } | null
}

const SYSTEM_PROMPT = `Ты Syntee — персональный AI-ассистент для Windows.
У тебя есть инструменты для работы с системой: запуск команд, чтение/запись файлов, поиск в интернете, буфер обмена.
Отвечай на русском языке. Будь кратким и точным.
Если задача требует нескольких шагов — используй инструменты последовательно.

## Форматирование ответов

### Диаграммы (Mermaid)
Для любых схем, графов, flowchart, sequence диаграмм, архитектуры — используй mermaid блок:
\`\`\`mermaid
flowchart TD
  A[Начало] --> B[Шаг]
\`\`\`
Поддерживаются: flowchart, sequenceDiagram, classDiagram, gantt, pie, gitGraph.

### Цветные блоки (Admonitions)
Для выделения важной информации используй:
:::note Заголовок
Текст заметки
:::

:::tip Совет
Полезный совет
:::

:::warning Внимание
Предупреждение
:::

:::danger Опасность
Критическое предупреждение
:::

:::info Информация
Информационный блок
:::

### Diff (изменения кода)
Для показа изменений в коде используй diff блок:
\`\`\`diff
- старая строка
+ новая строка
  без изменений
\`\`\`

### Таблицы
Используй markdown таблицы для структурированных данных:
| Колонка 1 | Колонка 2 |
|-----------|-----------|
| Значение  | Значение  |

### Математика
Для формул используй LaTeX: inline \`$E=mc^2$\`, блочный \`$$\\frac{a}{b}$$\`.

### Код
Всегда указывай язык в блоках кода: \`\`\`python, \`\`\`typescript, \`\`\`bash и т.д.
При выполнении команд предпочитай PowerShell синтаксис для Windows.`

export class Agent {
  private store: Store
  private client: AIClient
  private role: 'main' | 'subagent'

  constructor(store: Store, role: 'main' | 'subagent' = 'main') {
    this.store = store
    this.role = role
    this.client = new AIClient(store)
  }

  async run(userMessage: string, callbacks: AgentCallbacks, maxSteps = 8, signal?: AbortSignal, systemPrompt?: string): Promise<void> {
    const messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }> = [
      { role: 'system', content: systemPrompt ? `${systemPrompt}\n\n${SYSTEM_PROMPT}` : SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ]

    const tavilyKey = (this.store.get('integrations') as { tavily?: { key: string } })?.tavily?.key

    // Трекаем параллельные агенты — ждём их перед финальным ответом
    const pendingParallelAgents = new Set<string>()

    for (let step = 0; step < maxSteps; step++) {
      // Проверяем abort перед каждым шагом
      if (signal?.aborted) {
        callbacks.onDone('')
        return
      }
      try {
        const response = await this.client.chatWithTools(
          messages,
          TOOL_SCHEMAS,
          signal,
          this.role,
          (token) => callbacks.onStep({ type: 'answer', content: token }),
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
          // hadStreamedTokens=true значит onToken уже всё отдал
          if (!(response as typeof response & { hadStreamedTokens?: boolean }).hadStreamedTokens) {
            const words = answer.split(/(?<=\s)|(?=\s)/)
            for (const chunk of words) {
              if (signal?.aborted) { callbacks.onDone(answer); return }
              callbacks.onStep({ type: 'answer', content: chunk })
            }
          }

          callbacks.onDone(answer)
          return
        }

        // Есть tool_calls — сохраняем в messages
        // content НЕ стримился (hasToolCalls=true в AIClient), так и должно быть
        messages.push({ role: 'assistant', content: response.content || '', tool_calls: response.tool_calls })

        // Все tool_calls этой итерации — выполняем последовательно
        for (const call of response.tool_calls) {
          const fn = (call as { function: { name: string; arguments: string } }).function
          let args: Record<string, unknown> = {}
          try { args = JSON.parse(fn.arguments) } catch {}

          callbacks.onStep({ type: 'tool_call', toolName: fn.name, toolArgs: args, content: fn.name })

          // Проверка режима подтверждения
          const mode = callbacks.approvalMode || 'auto'
          if (mode === 'ask' && callbacks.onConfirm) {
            const approved = await callbacks.onConfirm(fn.name, args)
            if (!approved) {
              messages.push({
                role: 'tool',
                tool_call_id: (call as { id: string }).id,
                name: fn.name,
                content: 'Действие отклонено пользователем.',
              })
              callbacks.onStep({ type: 'tool_result', toolName: fn.name, content: 'Отклонено пользователем', success: false })
              continue
            }
          }

          const result = await this.executeTool(fn.name, args, tavilyKey, callbacks, pendingParallelAgents)

          // Если tool вернул [IMAGE:path] — вытаскиваем путь, не кидаем в контекст AI
          const imageMatch = result.output?.match(/^\[IMAGE:(.+)\]$/)
          const imageUrl = imageMatch ? imageMatch[1] : undefined
          const contentForAI = imageUrl
            ? 'Изображение успешно сгенерировано и показано пользователю.'
            : (result.success ? result.output : `Ошибка: ${result.error}`)

          callbacks.onStep({
            type: 'tool_result',
            toolName: fn.name,
            content: imageUrl ? 'Изображение сгенерировано' : (result.output || result.error || ''),
            success: result.success,
            imageUrl,
          })

          messages.push({
            role: 'tool',
            tool_call_id: (call as { id: string }).id,
            name: fn.name,
            content: contentForAI,
          })
        }
      } catch (err) {
        callbacks.onError(err instanceof Error ? err : new Error(String(err)))
        return
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
      case 'run_command':
        return runCommand(args.command as string, args.cwd as string | undefined)
      case 'read_file':
        return readFile(args.path as string)
      case 'write_file':
        return writeFile(args.path as string, args.content as string)
      case 'list_directory':
        return listDirectory(args.path as string)
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
        const status = callbacks.onGetAgentStatus(agentId)
        if (!status) return { success: false, output: '', error: `Агент ${agentId} не найден` }
        return {
          success: true,
          output: `Агент ${agentId}: статус=${status.status}, шагов=${status.stepsCount}${status.currentStep ? `, текущий шаг=${status.currentStep}` : ''}`,
        }
      }
      default:
        return { success: false, output: '', error: `Неизвестный инструмент: ${name}` }
    }
  }
}
