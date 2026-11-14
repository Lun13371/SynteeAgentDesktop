import type { ChatMessage } from './contextManager'
import { estimateTokens } from '../tokens/usageTracker'
import { JANITOR_MARKER, CONSTITUTION_MARKER, BRIEFING_MARKER, type JanitorAction, type JanitorReport, type AssistantsSettings } from '../../shared/assistants'

interface ToolCallFingerprint {
  name: string
  argsKey: string
  indices: number[]
}

function fingerprintToolCalls(messages: ChatMessage[]): ToolCallFingerprint[] {
  const map = new Map<string, ToolCallFingerprint>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role !== 'assistant' || !msg.tool_calls?.length) continue
    for (const tc of msg.tool_calls) {
      const name = tc.function?.name ?? ''
      let argsKey = ''
      try { argsKey = JSON.stringify(JSON.parse(tc.function?.arguments ?? '{}')) } catch { argsKey = tc.function?.arguments ?? '' }
      const key = `${name}|${argsKey}`
      const existing = map.get(key)
      if (existing) existing.indices.push(i)
      else map.set(key, { name, argsKey, indices: [i] })
    }
  }
  return [...map.values()].filter(f => f.indices.length > 1)
}

function findRepeatedReads(messages: ChatMessage[]): Map<string, number[]> {
  const reads = new Map<string, number[]>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role !== 'assistant' || !msg.tool_calls?.length) continue
    for (const tc of msg.tool_calls) {
      if (tc.function?.name !== 'read_file' && tc.function?.name !== 'read_files') continue
      try {
        const args = JSON.parse(tc.function.arguments ?? '{}')
        const path = String(args.path ?? args.paths ?? '').toLowerCase().replace(/\//g, '\\')
        if (!path) continue
        const existing = reads.get(path)
        if (existing) existing.push(i)
        else reads.set(path, [i])
      } catch { /* skip malformed */ }
    }
  }
  return reads
}

function isPinned(msg: ChatMessage, index: number, total: number, coldThreshold: number): boolean {
  if (msg.role === 'system') return true
  if (index >= total - coldThreshold) return true
  if (typeof msg.content === 'string' && (msg.content.includes('[Пользователь написал') || msg.content.includes(JANITOR_MARKER) || msg.content.includes(CONSTITUTION_MARKER) || msg.content.includes(BRIEFING_MARKER))) return true
  if (msg.tool_calls?.some(tc => tc.function?.name === 'update_todo' || tc.function?.name === 'update_working_memory')) return true
  return false
}

/** Детерминированное структурное резюме tool-результата (пути/строки/ошибки).
 *  Используется и в ране (summarize_stale), и в персистентной компрессии БД. */
export function summarizeToolResult(toolName: string, content: string): string {
  const chars = content.length
  const lines = content.split('\n').length
  if (toolName === 'read_file' || toolName === 'read_files') {
    const fileMatch = content.match(/\[(?:Файл|File): ([^\]|]+)/)
    const file = fileMatch?.[1]?.trim() ?? '?'
    const body = content.replace(/\[(?:Файл|File):[^\]]*\]/g, '').trim()
    const head = body.slice(0, 160).replace(/\n/g, ' ')
    const tail = body.length > 240 ? ` … ${body.slice(-80).replace(/\n/g, ' ')}` : ''
    return `[read] ${file} (${lines} строк): ${head}${tail}`
  }
  if (toolName === 'run_command') {
    const errLines = content.split('\n').filter(l => /error|failed|exception|не найден|not found/i.test(l)).slice(0, 3)
    const tail = content.slice(-200).replace(/\n/g, ' ').trim()
    const errPart = errLines.length ? ` ошибки: ${errLines.join(' | ').slice(0, 200)};` : ''
    return `[cmd] ${lines} строк вывода;${errPart} хвост: ${tail}`
  }
  if (toolName === 'edit_file' || toolName === 'write_file') {
    const fileMatch = content.match(/([^\s]+\.[a-z]+)/i)
    return `[${toolName}] ${fileMatch?.[1] ?? '?'} (${chars} симв)`
  }
  return `[${toolName}] ${chars} симв, ${lines} строк: ${content.slice(0, 150).replace(/\n/g, ' ')}…`
}

export interface JanitorArchiveEntry {
  id: string
  originalMessages: ChatMessage[]
  summary: string
  ts: number
}

export class Janitor {
  private archive = new Map<string, JanitorArchiveEntry>()
  private archiveCounter = 0
  private lastScanRound = 0
  private settings: AssistantsSettings

  constructor(settings: AssistantsSettings) {
    this.settings = settings
  }

  updateSettings(settings: AssistantsSettings): void {
    this.settings = settings
  }

  shouldScan(currentRound: number): boolean {
    if (!this.settings.enabled || !this.settings.janitorEnabled) return false
    return currentRound - this.lastScanRound >= this.settings.janitorScanInterval
  }

  scan(messages: ChatMessage[], currentRound: number, mode: 'light' | 'deep' = 'deep'): JanitorReport {
    const start = Date.now()
    this.lastScanRound = currentRound
    const actions: JanitorAction[] = []
    const total = messages.length
    const cold = this.settings.janitorColdThreshold

    const duplicates = fingerprintToolCalls(messages)
    for (const dup of duplicates) {
      const keepIndex = dup.indices[dup.indices.length - 1]
      const removeIndices = dup.indices.slice(0, -1).filter(i => !isPinned(messages[i], i, total, cold))
      if (removeIndices.length === 0) continue
      const tokensSaved = removeIndices.reduce((sum, i) => sum + estimateTokens(messages[i].content ?? ''), 0)
      actions.push({
        kind: 'dedup_tool_call',
        messageIndices: removeIndices,
        description: `${dup.name} вызван ${dup.indices.length}× с одинаковыми аргументами — свёрнуто ${removeIndices.length} повтор(ов)`,
        tokensSaved,
      })
    }

    const reads = findRepeatedReads(messages)
    for (const [path, indices] of reads) {
      if (indices.length < 2) continue
      const removeIndices = indices.slice(0, -1).filter(i => !isPinned(messages[i], i, total, cold))
      if (removeIndices.length === 0) continue
      const tokensSaved = removeIndices.reduce((sum, i) => sum + estimateTokens(messages[i].content ?? ''), 0)
      actions.push({
        kind: 'collapse_reread',
        messageIndices: removeIndices,
        description: `${path} перечитан ${indices.length}× — оставлена последняя версия`,
        tokensSaved,
      })
    }

    // light-режим (Economist, ступень 1): только дедуп/перечитывания,
    // без свёртки старых результатов — бережём кэш и recall-архив.
    if (mode === 'deep') {
      for (let i = 0; i < total - cold; i++) {
        const msg = messages[i]
        if (isPinned(msg, i, total, cold)) continue
        if (msg.role !== 'tool') continue
        const content = msg.content ?? ''
        if (content.length < 1200) continue
        const toolName = msg.name ?? 'tool'
        const summary = summarizeToolResult(toolName, content)
        const tokensSaved = estimateTokens(content) - estimateTokens(summary)
        if (tokensSaved < 150) continue
        const archiveId = `jan-${++this.archiveCounter}-${Date.now()}`
        this.archive.set(archiveId, { id: archiveId, originalMessages: [{ ...msg }], summary, ts: Date.now() })
        actions.push({
          kind: 'summarize_stale',
          messageIndices: [i],
          description: `[${toolName}] ${content.length} симв → резюме (${tokensSaved} токенов сэкономлено)`,
          tokensSaved,
          archiveId,
        })
      }
    }

    const totalTokensSaved = actions.reduce((s, a) => s + a.tokensSaved, 0)
    return { actions, totalTokensSaved, scannedMessages: total, durationMs: Date.now() - start }
  }

  apply(messages: ChatMessage[], report: JanitorReport): ChatMessage[] {
    if (report.actions.length === 0) return messages
    const result = [...messages]
    const toRemove = new Set<number>()
    const toReplace = new Map<number, string>()

    for (const action of report.actions) {
      if (action.kind === 'dedup_tool_call' || action.kind === 'collapse_reread') {
        for (const idx of action.messageIndices) {
          toRemove.add(idx)
          const msg = result[idx]
          if (msg?.tool_calls?.length) {
            const names = msg.tool_calls.map(tc => tc.function?.name).join(', ')
            toReplace.set(idx, `${JANITOR_MARKER} ${action.description} (оригинал: ${names})`)
          }
        }
      } else if (action.kind === 'summarize_stale' && action.archiveId) {
        const entry = this.archive.get(action.archiveId)
        if (entry) {
          for (const idx of action.messageIndices) {
            toReplace.set(idx, `${JANITOR_MARKER} ${entry.summary} [recall:${action.archiveId}]`)
          }
        }
      }
    }

    const filtered: ChatMessage[] = []
    for (let i = 0; i < result.length; i++) {
      if (toRemove.has(i) && !toReplace.has(i)) continue
      if (toReplace.has(i)) {
        filtered.push({ ...result[i], content: toReplace.get(i)!, tool_calls: undefined })
      } else {
        filtered.push(result[i])
      }
    }
    return filtered
  }

  recall(archiveId: string): ChatMessage[] | null {
    return this.archive.get(archiveId)?.originalMessages ?? null
  }

  getArchiveSize(): number {
    return this.archive.size
  }

  pruneArchive(maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs
    for (const [id, entry] of this.archive) {
      if (entry.ts < cutoff) this.archive.delete(id)
    }
  }
}