import type { Message } from '../../shared/types'
import type { ChatMessage } from '../../core/context/contextManager'

/**
 * Разворачивает Message с toolSteps в массив полноценных OpenAI-совместимых
 * сообщений: assistant (с tool_calls) + tool (с результатами).
 *
 * Раньше toolSteps сжимались в компактный текстовый trace (400 симв. на шаг),
 * из-за чего агент терял результаты предыдущих tool-вызовов (содержимое
 * файлов, результаты команд) и был вынужден перечитывать всё заново.
 * Теперь полная история tool-вызовов передаётся в нативном формате API.
 */
export function messageToContextMessages(message: Message): ChatMessage[] {
  // План — как раньше, просто текст
  if (message.planData) {
    return [{
      role: message.role as ChatMessage['role'],
      content: `[ПЛАН: "${message.planData.title}"]\n${message.planData.content}\n[Файл: ${message.planData.filePath}]`,
    }]
  }

  const steps = message.toolSteps ?? []

  // Нет toolSteps — обычное текстовое сообщение
  if (message.role !== 'assistant' || steps.length === 0) {
    // Даже для текстового сообщения без toolSteps — если есть todo,
    // инжектим его (user-роль, после assistant) чтобы AI видел свой
    // незавершённый план из прошлой итерации. Без этого AI не знает
    // что todo сохраняется между сообщениями и не может продолжить.
    if (message.role === 'assistant' && message.todo?.length) {
      return [
        { role: 'assistant' as const, content: message.content },
        { role: 'user' as const, content: formatTodoForContext(message.todo) },
      ]
    }
    return [{ role: message.role as ChatMessage['role'], content: message.content }]
  }

  // Группируем steps по итерациям: каждая итерация = assistant с tool_calls
  // + последующие tool results. Сохраняем текст между итерациями.
  type Iteration = {
    textBefore?: string
    calls: Array<{ callId: string; toolName: string; toolArgs: Record<string, unknown> }>
    results: Map<string, { content: string; success?: boolean; toolName?: string }>
  }

  const iterations: Iteration[] = []
  let currentIter: Iteration | null = null
  let pendingCall: { callId: string; toolName: string; toolArgs: Record<string, unknown> } | null = null

  for (const step of steps) {
    if (step.type === 'tool_call') {
      if (!currentIter || currentIter.calls.length > 0 || currentIter.results.size > 0) {
        // Новая итерация
        currentIter = { calls: [], results: new Map() }
        iterations.push(currentIter)
      }
      const callId = step.callId || `call_${iterations.length}_${currentIter.calls.length}`
      currentIter.calls.push({
        callId,
        toolName: step.toolName || 'tool',
        toolArgs: step.toolArgs || {},
      })
      pendingCall = { callId, toolName: step.toolName || 'tool', toolArgs: step.toolArgs || {} }
    } else if (step.type === 'tool_result') {
      if (!currentIter) {
        currentIter = { calls: [], results: new Map() }
        iterations.push(currentIter)
      }
      const callId = step.callId || pendingCall?.callId || `call_${iterations.length}_${currentIter.results.size}`
      currentIter.results.set(callId, {
        content: step.content || '',
        success: step.success,
        toolName: step.toolName || pendingCall?.toolName,
      })
      pendingCall = null
    }
  }

  // Если итераций нет — просто текст (но мог быть todo)
  if (iterations.length === 0) {
    if (message.todo?.length) {
      return [
        { role: 'assistant' as const, content: message.content },
        { role: 'user' as const, content: formatTodoForContext(message.todo) },
      ]
    }
    return [{ role: 'assistant', content: message.content }]
  }

  // Если есть content до первой итерации и он непустой — добавляем как отдельное сообщение
  const result: ChatMessage[] = []
  const contentBefore = message.content || ''
  const hasContentBefore = contentBefore.trim().length > 0

  for (let i = 0; i < iterations.length; i++) {
    const iter = iterations[i]

    // Assistant сообщение с tool_calls (включает текст ответа перед тулаами)
    const assistantContent = (i === 0 && hasContentBefore) ? contentBefore : ''
    const toolCalls = iter.calls.map(c => ({
      id: c.callId,
      type: 'function' as const,
      function: {
        name: c.toolName,
        arguments: JSON.stringify(c.toolArgs),
      },
    }))

    result.push({
      role: 'assistant',
      content: assistantContent,
      tool_calls: toolCalls,
    })

    // Tool результаты для каждого call
    for (const call of iter.calls) {
      const toolResult = iter.results.get(call.callId)
      result.push({
        role: 'tool',
        content: toolResult?.content ?? '',
        tool_call_id: call.callId,
        name: call.toolName,
      })
    }
  }

  // Если у assistant-сообщения есть todo — добавляем user-напоминание
  // ПОСЛЕ всей цепочки assistant(tool_calls)→tool results. User-роль
  // работает со всеми провайдерами (system в середине некоторые
  // прокси отбрасывают). AI видит свой незавершённый план и может
  // продолжить работу по нему в следующем ответе.
  if (message.role === 'assistant' && message.todo?.length) {
    result.push({ role: 'user' as const, content: formatTodoForContext(message.todo) })
  }

  return result
}

// Форматирует todo-список для инъекции в контекст истории.
// Используется в messageToContextMessages — AI видит это как user-сообщение
// после своего прошлого ответа, чтобы понимать что осталось сделать.
export function formatTodoForContext(todo: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>): string {
  const lines = todo.map(t => {
    const mark = t.status === 'done' ? '[x]'
      : t.status === 'in_progress' ? '[~]'
      : t.status === 'skipped' ? '[-]'
      : '[ ]'
    return `${mark} ${t.text}`
  })
  const unfinished = todo.filter(t => t.status === 'pending' || t.status === 'in_progress').length
  const suffix = unfinished > 0
    ? `\n\nЭто твой незавершённый план из предыдущего ответа (${unfinished} пункт(ов) осталось). Продолжи работу по нему — не создавай новый план, если этот ещё актуален.`
    : '\n\nЭто твой завершённый план из предыдущего ответа (все пункты выполнены).'
  return `[АКТУАЛЬНЫЙ ПЛАН ЗАДАЧИ — состояние на момент предыдущего сообщения]\n${lines.join('\n')}${suffix}`
}
