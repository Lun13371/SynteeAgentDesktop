import type Store from 'electron-store'
import { AIClient } from '../ai/AIClient'
import {
  runCommand, readFile, writeFile, listDirectory,
  getClipboard, setClipboard, searchWeb, getSystemInfo,
  TOOL_SCHEMAS, type ToolResult,
} from '../tools'

export interface AgentStep {
  type: 'thought' | 'tool_call' | 'tool_result' | 'answer'
  toolName?: string
  toolArgs?: Record<string, unknown>
  content: string
  success?: boolean
}

export interface AgentCallbacks {
  onStep: (step: AgentStep) => void
  onDone: (answer: string) => void
  onError: (err: Error) => void
}

const SYSTEM_PROMPT = `Ты Syntee — персональный AI-ассистент для Windows.
У тебя есть инструменты для работы с системой: запуск команд, чтение/запись файлов, поиск в интернете, буфер обмена.
Отвечай на русском языке. Будь кратким и точным.
Если задача требует нескольких шагов — используй инструменты последовательно.
При выполнении команд предпочитай PowerShell синтаксис для Windows.`

export class Agent {
  private store: Store
  private client: AIClient

  constructor(store: Store) {
    this.store = store
    this.client = new AIClient(store)
  }

  async run(userMessage: string, callbacks: AgentCallbacks, maxSteps = 8): Promise<void> {
    const messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }> = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ]

    const tavilyKey = (this.store.get('integrations') as { tavily?: { key: string } })?.tavily?.key

    for (let step = 0; step < maxSteps; step++) {
      try {
        const response = await this.client.chatWithTools(messages, TOOL_SCHEMAS)

        // Если нет tool_calls — финальный ответ
        if (!response.tool_calls?.length) {
          const answer = response.content || ''
          callbacks.onStep({ type: 'answer', content: answer })
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

          const result = await this.executeTool(fn.name, args, tavilyKey)

          callbacks.onStep({
            type: 'tool_result',
            toolName: fn.name,
            content: result.output || result.error || '',
            success: result.success,
          })

          messages.push({
            role: 'tool',
            tool_call_id: (call as { id: string }).id,
            name: fn.name,
            content: result.success
              ? result.output
              : `Ошибка: ${result.error}`,
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
      default:
        return { success: false, output: '', error: `Неизвестный инструмент: ${name}` }
    }
  }
}
