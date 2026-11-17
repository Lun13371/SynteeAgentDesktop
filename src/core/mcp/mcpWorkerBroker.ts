import { randomUUID } from 'node:crypto'
import type { Worker } from 'node:worker_threads'

type McpResult = { success: boolean; output: string; error?: string }
type Message = Record<string, unknown>
type Send = (message: Message) => void

const cancelled: McpResult = { success: false, output: '', error: 'MCP-вызов отменён' }

export function requestMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  replies: Map<string, Send>,
  send: Send,
  signal: AbortSignal,
): Promise<McpResult> {
  if (signal.aborted) return Promise.resolve(cancelled)
  return new Promise(resolve => {
    const replyId = randomUUID()
    const finish = (result: McpResult) => {
      replies.delete(replyId)
      signal.removeEventListener('abort', abort)
      resolve(result)
    }
    const abort = () => {
      finish(cancelled)
      try { send({ type: 'mcp_call_cancel', replyId }) } catch { /* main has exited */ }
    }
    signal.addEventListener('abort', abort, { once: true })
    replies.set(replyId, reply => finish(reply.result as McpResult))
    try { send({ type: 'mcp_call', replyId, toolName, args }) }
    catch (error) { finish({ success: false, output: '', error: String(error) }) }
  })
}

export function attachMcpWorkerBroker(
  worker: Worker,
  execute: (toolName: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<McpResult>,
): void {
  const pending = new Map<string, AbortController>()
  const close = () => {
    worker.off('message', onMessage)
    worker.off('error', close)
    worker.off('exit', close)
    for (const controller of pending.values()) controller.abort()
    pending.clear()
  }
  const onMessage = async (message: Message) => {
    const { replyId, type, toolName, args } = message
    if (typeof replyId !== 'string') return
    if (type === 'mcp_call_cancel') {
      pending.get(replyId)?.abort()
      pending.delete(replyId)
      return
    }
    if (type !== 'mcp_call' || typeof toolName !== 'string' || pending.has(replyId)) return
    const controller = new AbortController()
    pending.set(replyId, controller)
    let result: McpResult
    try {
      result = await execute(toolName, args as Record<string, unknown>, controller.signal)
    } catch (error) {
      result = { success: false, output: '', error: error instanceof Error ? error.message : String(error) }
    }
    if (pending.get(replyId) !== controller) return
    pending.delete(replyId)
    try { worker.postMessage({ type: 'mcp_call_reply', replyId, result }) } catch { close() }
  }
  worker.on('message', onMessage)
  worker.once('exit', close)
  worker.once('error', close)
}
