import type { FileCacheEntry } from '../context/fileCacheTypes'
import type { QuestionSpec, QuestionAnswer } from '../../shared/types'

export interface AgentStep {
  // tool_call_pending — модель только начала генерировать этот вызов (имя
  // уже известно, аргументы ещё стримятся) — ранний сигнал для UI, чтобы
  // блок тула появлялся сразу, а не после долгой генерации большого diff/content.
  type: 'thought' | 'tool_call_pending' | 'tool_call' | 'tool_result' | 'answer'
  toolName?: string
  toolArgs?: Record<string, unknown>
  content: string
  success?: boolean
  imageUrl?: string
  diff?: string
  callId?: string
  hidden?: boolean
  /** Имя MCP-сервера (для MCP-тулов mcp__server__tool). */
  serverName?: string
  // Связывает финальный tool_call с более ранним tool_call_pending той же
  // генерации (см. onToolCallStarted) — фронтенд заменяет pending-карточку
  // на настоящую вместо создания второго блока.
  pendingCallId?: string
}

export interface AgentCallbacks {
  onStep: (step: AgentStep) => void
  onDone: (answer: string, details?: AgentSummaryDetails) => void
  onError: (error: Error) => void
  onStatus?: (text: string) => void
  onRateLimit?: (waitSec: number) => void
  onRetry?: (attempt: number, reason: string, waitSec?: number) => void
  onContextUpdate?: (tokens: number) => void
  onUsage?: (promptTokens: number, completionTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number) => void
  onConfirm?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>
  approvalMode?: 'auto' | 'ask'
  onSpawnAgent?: (opts: { id: string; task: string; model?: string; approvalMode?: 'auto' | 'ask' | 'full'; isolation?: 'auto' | 'worktree' | 'none' }) => Promise<{ summary: string; error?: string }>
  /**
   * Персистентный shell (§1 GAP_ANALYSIS.md) — если задан, run_command
   * выполняется через живую shell-сессию в main-процессе вместо
   * одноразового exec(). cd/env переживают между вызовами. Не используется
   * суб-агентами (короткоживущие — общий shell создал бы гонки).
   */
  onShellExec?: (command: string, cwd: string | undefined, timeoutSec: number) => Promise<{ output: string; exitCode: number; timedOut?: boolean }>
  onGetAgentStatus?: (agentId: string) => Promise<{ status: string; currentStep?: string; stepsCount: number } | null>
  onContextCounted?: (promptTokens: number) => void
  onTodoUpdate?: (items: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>) => void
  onThinkingToken?: (token: string) => void
  onThinkingDone?: (ms: number) => void
  // Side-chat-only: запросить сообщения основного чата из БД (в worker
  // нет доступа к БД, поэтому идёт round-trip через main-процесс).
  onGetMainChatMessages?: (params: { limit?: number; search?: string }) => Promise<string>
  /**
   * Вызов MCP-тула (round-trip в main-процесс, где живёт McpManager).
   * fullToolName = mcp__serverName__toolName. Возвращает {success, output, error?}.
   */
  onMcpCall?: (fullToolName: string, args: Record<string, unknown>) => Promise<{ success: boolean; output: string; error?: string }>
  /**
   * Проверка, нужно ли подтверждение для MCP-тула. Если вернёт true —
   * агент запросит одобрение через onConfirm (как для опасных тулов).
   */
  onMcpRequiresApproval?: (fullToolName: string) => boolean
  /**
   * Запрос списка установленных расширений (MCP-серверы + skills).
   * Round-trip в main-процесс, где есть доступ к McpManager и SkillManager.
   * Возвращает текстовый отчёт для агента.
   */
  onListExtensions?: () => Promise<string>
  /**
   * Получить инструкции скила по имени. Round-trip в main-процесс.
   * Возвращает текст инструкций.
   */
  onGetSkill?: (name: string) => Promise<string>
  /**
   * ask_user-тул: задать уточняющие вопросы пользователю через UI-панель.
   * Round-trip через main-процесс → renderer (QuestionPanel). Блокирует
   * агент до ответа пользователя. Возвращает ответы по каждому вопросу.
   */
  onQuestion?: (questions: QuestionSpec[]) => Promise<QuestionAnswer[]>
  /**
   * Progress callback для долгих тулов (например get_fast_context):
   * транслирует stage-прогресс в main для live-индикации этапов в UI.
   */
  onToolProgress?: (p: { toolName: string; stage: string; detail?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }> }) => void
  /** AbortSignal для долгих тулов — позволяет отменить get_fast_context и т.п. */
  signal?: AbortSignal
}

export interface AgentSummaryDetails {
  modifiedFiles: string[]
  diffs: Array<{ file: string; summary: string }>
  commandsRun: Array<{ command: string; exitCode?: string; success: boolean }>
  filesRead: string[]
  // §1.8 — снимок undoStack на конец turn'а: {path, contentBefore} для каждого
  // изменённого файла. contentBefore = null = файл был создан этим turn'ом.
  // Перегоняется в file_snapshots (DB) на main-стороне для checkpoint/rewind.
  fileSnapshots: Array<{ path: string; contentBefore: string | null }>
}

export type AgentMessage = {
  role: string
  content: string
  tool_calls?: unknown[]
  tool_call_id?: string
  name?: string
}

export type NormalizedToolCall = {
  call: unknown
  callId: string
  fn: { name: string; arguments: string }
  args: Record<string, unknown>
  isHiddenTool: boolean
  pendingCallId: string
}

export type AgentRuntimeOptions = {
  autoMemoryInterval?: number
  readFileCache?: boolean
  maxRepeatedToolCalls?: number
  maxRepeatedErrors?: number
  fileCacheSnapshot?: Record<string, FileCacheEntry>
}

export type AgentToolCallFingerprint = {
  toolName: string
  argsKey: string
}

export type ToolRound = {
  assistantIndex: number
  toolIndices: number[]
  toolNames: string[]
}
