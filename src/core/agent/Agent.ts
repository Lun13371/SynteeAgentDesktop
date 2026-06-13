import type Store from 'electron-store'
import { AIClient } from '../ai/AIClient'
import {
  runCommand, readFile, writeFile, listDirectory,
  getClipboard, setClipboard, searchWeb, getSystemInfo, generateImage,
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
  approvalMode?: ApprovalMode
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

  constructor(store: Store) {
    this.store = store
    this.client = new AIClient(store)
  }

  async run(userMessage: string, callbacks: AgentCallbacks, maxSteps = 8, signal?: AbortSignal, systemPrompt?: string): Promise<void> {
    const messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }> = [
      { role: 'system', content: systemPrompt ? `${systemPrompt}\n\n${SYSTEM_PROMPT}` : SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ]

    const tavilyKey = (this.store.get('integrations') as { tavily?: { key: string } })?.tavily?.key

    for (let step = 0; step < maxSteps; step++) {
      // Проверяем abort перед каждым шагом
      if (signal?.aborted) {
        callbacks.onDone('')
        return
      }
      try {
        const response = await this.client.chatWithTools(messages, TOOL_SCHEMAS, signal)

        // Abort во время запроса
        if (signal?.aborted) {
          callbacks.onDone('')
          return
        }

        // Если нет tool_calls — финальный ответ
        if (!response.tool_calls?.length) {
          const answer = response.content || ''

          // Reasoning от агентского запроса — шлём перед текстом
          if (response.reasoning) {
            callbacks.onStep({ type: 'thought', content: response.reasoning })
          }

          // Эмулируем стриминг по словам чтобы UI не мигал
          const words = answer.split(/(?<=\s)|(?=\s)/)
          for (const chunk of words) {
            if (signal?.aborted) {
              callbacks.onDone(answer)
              return
            }
            callbacks.onStep({ type: 'answer', content: chunk })
          }
          callbacks.onDone(answer)
          return
        }

        // Обрабатываем tool calls
        messages.push({ role: 'assistant', content: response.content || '', tool_calls: response.tool_calls })

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

          const result = await this.executeTool(fn.name, args, tavilyKey)

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
    tavilyKey?: string
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
      default:
        return { success: false, output: '', error: `Неизвестный инструмент: ${name}` }
    }
  }
}
