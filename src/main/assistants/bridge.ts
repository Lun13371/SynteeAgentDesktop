import { Watcher, type WatcherTrigger, type Capability, prefilterCapabilities, hashContext } from '../../core/agent/watcher'
import { DEFAULT_ASSISTANTS_SETTINGS, type AssistantsSettings, type HintCandidate, type AssistantLogEntry, type AgentStatsMap, ASSISTANTS_LOG_MAX_ENTRIES, ASSISTANTS_LOG_RETENTION_MS } from '../../shared/assistants'
import { log } from '../../core/logger'
import { judgeRelevance, judgeDrift, distillSession, extractConstraints, summarizeTool, judgeCapability } from './llmClient'
import { getServerState } from './llmServer'
import { saveMemoryItem, decayAutoFacts } from '../../core/memory/MemoryStore'
import { sidecarSemanticSearch, resolveSemanticModelPaths } from '../../core/context/fastContext/sidecarClient'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { localModels, type SetupProgress } from '../localModels/LocalModelManager'
import { detectModelSize, type ModelSize } from './modelManager'
import type { Worker } from 'worker_threads'

interface ActiveAssistant {
  watcher: Watcher
  chatId: string
  worker: Worker | null
  settings: AssistantsSettings
  capabilities: Capability[]
  projectWorkdir?: string
  lastHash: string
  lastErrorHash: string
}

const active = new Map<string, ActiveAssistant>()
const assistantLog: AssistantLogEntry[] = []
// W1 feedback: веса источников и последние инжектированные хинты per chat.
const sourceWeights = new Map<string, number>()
const capabilityWeights = new Map<string, number>()
const injectedHints = new Map<string, Array<{ id: string; source: string; capId?: string }>>()

let globalSettings: AssistantsSettings = { ...DEFAULT_ASSISTANTS_SETTINGS }
let dbPathResolver: (() => string) | null = null
let persistFn: ((s: AssistantsSettings) => void) | null = null

// Мини-статистика агентов (сработал/пропустил/сэкономил) — персистится в store.
const agentStats: AgentStatsMap = {}
let persistStatsFn: ((s: AgentStatsMap) => void) | null = null
let statsPersistTimer: NodeJS.Timeout | null = null
function scheduleStatsPersist(): void {
  if (!persistStatsFn || statsPersistTimer) return
  statsPersistTimer = setTimeout(() => { statsPersistTimer = null; persistStatsFn?.(agentStats) }, 2000)
}
function bump(role: string, kind: 'fired' | 'skipped'): void {
  const st = agentStats[role] ?? (agentStats[role] = { fired: 0, skipped: 0, saved: 0 })
  st[kind]++
  scheduleStatsPersist()
}
function bumpSaved(role: string, tokens: number): void {
  const st = agentStats[role] ?? (agentStats[role] = { fired: 0, skipped: 0, saved: 0 })
  st.saved += tokens
  scheduleStatsPersist()
}
export function getAgentStats(): AgentStatsMap { return agentStats }

export function initAssistants(opts: { load: () => Partial<AssistantsSettings> | undefined; persist: (s: AssistantsSettings) => void; dbPath: () => string; loadStats?: () => AgentStatsMap | undefined; persistStats?: (s: AgentStatsMap) => void }): void {
  const saved = opts.load()
  if (saved) globalSettings = { ...DEFAULT_ASSISTANTS_SETTINGS, ...saved }
  persistFn = opts.persist
  dbPathResolver = opts.dbPath
  const savedStats = opts.loadStats?.()
  if (savedStats) Object.assign(agentStats, savedStats)
  persistStatsFn = opts.persistStats ?? null
  if (globalSettings.enabled) {
    applyModelSize()
    void localModels.ensureReady()
  }
}

export function setAssistantsDbPathResolver(resolver: () => string): void {
  dbPathResolver = resolver
}

export function getAssistantsSettings(): AssistantsSettings {
  return globalSettings
}

export function updateAssistantsSettings(patch: Partial<AssistantsSettings>): AssistantsSettings {
  const wasEnabled = globalSettings.enabled
  globalSettings = { ...globalSettings, ...patch }
  persistFn?.(globalSettings)
  for (const a of active.values()) {
    a.settings = globalSettings
    a.watcher.updateSettings(globalSettings)
    a.worker?.postMessage({ type: 'assistants_settings', settings: globalSettings })
  }
  if (globalSettings.enabled && !wasEnabled) {
    applyModelSize()
    void localModels.ensureReady()
  } else if (!globalSettings.enabled && wasEnabled) {
    localModels.shutdown()
  } else if (globalSettings.enabled) {
    applyModelSize()
  }
  return globalSettings
}

function applyModelSize(): void {
  const size: ModelSize = globalSettings.modelSize === 'auto' ? detectModelSize() : globalSettings.modelSize
  localModels.setModelSize(size)
}

export type { SetupProgress }

export function onSetupProgress(fn: (p: SetupProgress) => void): () => void {
  return localModels.onProgress(fn)
}

export async function downloadAndStart(): Promise<{ ok: boolean; error?: string }> {
  applyModelSize()
  const ok = await localModels.ensureReady()
  return { ok, error: ok ? undefined : localModels.getStatus().lastError }
}

export { getServerState } from './llmServer'
export { detectModelSize, isModelDownloaded, getModelPath } from './modelManager'

// После idle-выгрузки сервер поднимается лениво на первом же событии агента.
function serverReady(): boolean {
  if (getServerState() === 'ready') return true
  void localModels.ensureReady()
  return false
}

export function attachAssistants(chatId: string, worker: Worker, opts: { projectWorkdir?: string; projectId?: string } = {}): void {
  if (!globalSettings.enabled) {
    log('[Assistants] attach skipped (disabled) chat=%s', chatId)
    return
  }
  const dbPath = dbPathResolver?.() ?? ''
  const watcher = new Watcher(globalSettings, dbPath, opts)
  active.set(chatId, { watcher, chatId, worker, settings: globalSettings, capabilities: [], projectWorkdir: opts.projectWorkdir, lastHash: '', lastErrorHash: '' })
  worker.postMessage({ type: 'assistants_settings', settings: globalSettings })
  log('[Assistants] attached to chat %s (watcher=%s janitor=%s)', chatId, globalSettings.watcherEnabled, globalSettings.janitorEnabled)
}

export function detachAssistants(chatId: string): void {
  active.delete(chatId)
}

export async function onAgentEvent(chatId: string, trigger: WatcherTrigger): Promise<void> {
  const a = active.get(chatId)
  if (!a || !a.settings.enabled || !a.settings.watcherEnabled) {
    log('[Assistants] watcher skip chat=%s attached=%s enabled=%s', chatId, !!a, a?.settings.enabled)
    return
  }
  try {
    const ctx = buildTriggerContext(trigger, a.projectWorkdir)
    // Novelty-gate: нет новой информации — нет повода говорить (кроме старта).
    const h = hashContext(ctx)
    if (trigger.kind !== 'task_start' && h === a.lastHash) return
    a.lastHash = h
    if (trigger.kind === 'tool_error') {
      const eh = hashContext(trigger.error)
      if (eh === a.lastErrorHash) return
      a.lastErrorHash = eh
    }
    appendLog({ ts: Date.now(), role: 'watcher', kind: 'trigger', detail: `${trigger.kind}: оценка возможностей` })
    const ready = serverReady()
    if (ready) {
      // Capability router: prefilter каталога → точный структурный вердикт.
      const caps = prefilterCapabilities(a.capabilities, ctx, 10)
        .sort((x, y) => (capabilityWeights.get(y.id) ?? 1) - (capabilityWeights.get(x.id) ?? 1))
      const verdict = await judgeCapability(ctx, caps)
      if (verdict.helpful && verdict.confidence >= 0.6) {
        const cap = a.capabilities.find(c => c.id === verdict.id)
        const hint: HintCandidate = { id: `cap-${verdict.id}-${Date.now()}`, source: 'capability', content: verdict.action, score: verdict.confidence, title: cap?.name ?? verdict.id }
        a.worker?.postMessage({ type: 'hint', hint })
        const inj = injectedHints.get(chatId) ?? []
        inj.push({ id: hint.id, source: hint.source, capId: verdict.id })
        injectedHints.set(chatId, inj.slice(-20))
        appendLog({ ts: Date.now(), role: 'watcher', kind: 'hint_injected', detail: `[capability:${hint.title}] ${hint.content.slice(0, 80)}` })
        bump('watcher', 'fired')
      } else {
        appendLog({ ts: Date.now(), role: 'watcher', kind: 'skip', detail: 'нет уверенной рекомендации — пропуск' })
        bump('watcher', 'skipped')
      }
    } else {
      // Fallback без LLM: память/скиллы, не более одной подсказки.
      const hints = await a.watcher.onTrigger(trigger)
      for (const hint of hints.slice(0, 1)) {
        a.worker?.postMessage({ type: 'hint', hint })
        appendLog({ ts: Date.now(), role: 'watcher', kind: 'hint_injected', detail: `[${hint.source}] ${hint.title ?? hint.id}: ${hint.content.slice(0, 80)}` })
        bump('watcher', 'fired')
      }
      if (hints.length === 0) bump('watcher', 'skipped')
    }
  } catch (err) {
    log('[Assistants] watcher error for chat %s: %s', chatId, (err as Error).message)
  }
}

const groundingCache = new Map<string, string>()
function readGrounding(workdir?: string): string {
  if (!workdir) return ''
  if (groundingCache.has(workdir)) return groundingCache.get(workdir)!
  let text = ''
  for (const rel of ['AGENTS.md', '.syntee/instructions.md', 'QODER.md']) {
    try {
      const p = join(workdir, rel)
      if (existsSync(p)) { text = readFileSync(p, 'utf8').slice(0, 300); break }
    } catch { /* ok */ }
  }
  groundingCache.set(workdir, text)
  return text
}

function buildTriggerContext(trigger: WatcherTrigger, workdir?: string): string {
  let base: string
  switch (trigger.kind) {
    case 'tool_error': base = `tool ${trigger.toolName} error: ${trigger.error}`; break
    case 'capability_gap': base = `tool ${trigger.toolName} unavailable: ${trigger.text}`; break
    case 'tool_repeat': base = `tool ${trigger.toolName} repeated ${trigger.count} times`; break
    default: base = trigger.text
  }
  const g = readGrounding(workdir)
  return g ? `${base}\nProject rules: ${g}` : base
}

export function onJanitorAction(chatId: string, kind: string, description: string, tokensSaved: number): void {
  appendLog({ ts: Date.now(), role: 'janitor', kind, detail: description, tokensSaved })
  if (tokensSaved > 0) { bump('janitor', 'fired'); bumpSaved('janitor', tokensSaved) }
  else bump('janitor', 'skipped')
}

// E5-дедуп Archivist: почти-дубль уже в памяти (cosine ≥ 0.9) → не плодим записи.
async function isE5Duplicate(content: string, projectId?: string): Promise<boolean> {
  const paths = resolveSemanticModelPaths()
  const dbPath = dbPathResolver?.()
  if (!paths || !dbPath) return false
  try {
    const hits = await sidecarSemanticSearch(
      { dbPath, query: content, limit: 1, sources: ['memory'], scope: 'all', projectId: projectId ?? null, crossProject: false, kind: null, memoryEnabled: true, memoryGlobal: true, memoryProject: true, memoryChat: true },
      paths,
    )
    return (hits[0]?.score ?? 0) >= 0.9
  } catch { return false }
}

// Decay авто-фактов — не чаще раза в сутки, по реальному сигналу (конец рана).
let lastDecayAt = 0
function maybeDecay(): void {
  if (Date.now() - lastDecayAt < 24 * 3600 * 1000) return
  lastDecayAt = Date.now()
  try {
    const n = decayAutoFacts()
    if (n > 0) appendLog({ ts: Date.now(), role: 'archivist', kind: 'decay', detail: `понижена importance у ${n} старых авто-фактов` })
  } catch { /* decay не критичен */ }
}

/** Диспетчер LLM-зависимых мини-агентов (события из worker). Все advisory. */
export async function onAssistantEvent(chatId: string, evt: Record<string, unknown>): Promise<void> {
  const a = active.get(chatId)
  if (!a || !a.settings.enabled) return
  const s = a.settings
  const ready = serverReady()
  const kind = String(evt.kind ?? '')
  const post = (hint: HintCandidate) => {
    a.worker?.postMessage({ type: 'hint', hint })
    const role: AssistantLogEntry['role'] = (hint.source === 'memory' || hint.source === 'skill' || hint.source === 'constitution' || hint.source === 'capability') ? 'watcher' : (hint.source as AssistantLogEntry['role'])
    appendLog({ ts: Date.now(), role, kind: 'hint_injected', detail: `[${hint.source}] ${hint.content.slice(0, 80)}` })
  }
  try {
    switch (kind) {
      case 'capabilities': {
        a.capabilities = (evt.capabilities as Capability[]) ?? []
        break
      }
      case 'watcher_trigger': {
        const t = evt.trigger as WatcherTrigger | undefined
        if (t) await onAgentEvent(chatId, t)
        break
      }
      case 'navigator': {
        if (!s.navigatorEnabled || !ready) return
        const verdict = await judgeDrift(String(evt.objective ?? ''), String(evt.transcript ?? ''), Array.isArray(evt.constraints) ? evt.constraints as string[] : [])
        if (verdict.drift || verdict.violation) {
          const content = verdict.violation
            ? `Нарушаешь ограничение: ${verdict.reason || 'соблюдай закреплённые правила.'}`
            : `Возвращайся к цели: ${verdict.reason || 'текущие шаги уходят в сторону.'}`
          post({ id: `nav-${Date.now()}`, source: 'navigator', content, score: 1 })
          bump('navigator', 'fired')
        } else {
          bump('navigator', 'skipped')
        }
        break
      }
      case 'archivist': {
        if (!s.archivistEnabled || !ready) return
        const facts = await distillSession(String(evt.transcript ?? ''))
        let savedCount = 0
        for (const f of facts) {
          if (await isE5Duplicate(f.content, evt.projectId as string | undefined)) {
            appendLog({ ts: Date.now(), role: 'archivist', kind: 'dedup', detail: `E5-дубль пропущен: ${f.content.slice(0, 60)}` })
            continue
          }
          const kindMap: Record<string, 'project_decision' | 'convention' | 'user_fact'> = { project: 'project_decision', feedback: 'convention', user: 'user_fact' }
          await saveMemoryItem({
            title: f.content.slice(0, 60), content: f.content, kind: kindMap[f.kind] ?? 'project_decision',
            scope: evt.projectId ? 'project' : 'global', projectId: (evt.projectId as string) ?? undefined,
            chatId: (evt.chatId as string) ?? undefined, source: 'auto_extract', importance: 0.6,
          })
          savedCount++
        }
        if (savedCount) {
          appendLog({ ts: Date.now(), role: 'archivist', kind: 'distilled', detail: `сохранено ${savedCount} фактов в память` })
          bump('archivist', 'fired')
        } else {
          bump('archivist', 'skipped')
        }
        maybeDecay()
        break
      }
      case 'constitution_extract': {
        if (!ready) return
        const items = await extractConstraints(String(evt.text ?? ''))
        if (items.length) a.worker?.postMessage({ type: 'constitution', items })
        break
      }
      case 'janitor_refine': {
        if (!ready) return
        const summary = await summarizeTool(String(evt.toolName ?? 'tool'), String(evt.content ?? ''))
        if (summary) a.worker?.postMessage({ type: 'janitor_refined', archiveId: evt.archiveId, summary })
        break
      }
      case 'economist': bump('economist', 'fired'); break
      case 'briefing': bump('briefing', 'fired'); break
      case 'janitor_skip': bump('janitor', 'skipped'); break
    }
  } catch (err) {
    log('[Assistants] agent %s error chat=%s: %s', kind, chatId, (err as Error).message)
  }
}

/** W1 feedback: после рана спрашиваем судью, какие хинты помогли, и корректируем веса. */
export async function onRunDone(chatId: string, transcriptTail: string): Promise<void> {
  const inj = injectedHints.get(chatId) ?? []
  injectedHints.delete(chatId)
  if (inj.length === 0 || !globalSettings.enabled || !serverReady()) return
  try {
    const list = inj.map(h => h.id).join(', ')
    const verdict = await judgeRelevance(`session transcript: ${transcriptTail.slice(0, 400)}`, `hints used: ${list}`)
    // Простая эвристика: если судья считает контекст релевантным — поднимаем веса источников.
    for (const h of inj) {
      const w = sourceWeights.get(h.source) ?? 1
      sourceWeights.set(h.source, Math.min(1.5, Math.max(0.5, w + (verdict.relevant ? 0.05 : -0.05))))
      if (h.capId) {
        const used = transcriptTail.includes(h.capId)
        const cw = capabilityWeights.get(h.capId) ?? 1
        capabilityWeights.set(h.capId, Math.min(1.5, Math.max(0.5, cw + (used ? 0.1 : -0.05))))
      }
    }
  } catch { /* feedback не критичен */ }
}

function appendLog(entry: AssistantLogEntry): void {
  assistantLog.push(entry)
  if (assistantLog.length > ASSISTANTS_LOG_MAX_ENTRIES) {
    assistantLog.splice(0, assistantLog.length - ASSISTANTS_LOG_MAX_ENTRIES)
  }
}

export function getAssistantLog(since?: number): AssistantLogEntry[] {
  const cutoff = Date.now() - ASSISTANTS_LOG_RETENTION_MS
  const filtered = assistantLog.filter(e => e.ts >= cutoff && (!since || e.ts >= since))
  return filtered
}

export function pruneAssistantLog(): void {
  const cutoff = Date.now() - ASSISTANTS_LOG_RETENTION_MS
  const before = assistantLog.length
  for (let i = assistantLog.length - 1; i >= 0; i--) {
    if (assistantLog[i].ts < cutoff) assistantLog.splice(i, 1)
  }
  if (assistantLog.length !== before) log('[Assistants] pruned %d log entries', before - assistantLog.length)
}

export function getActiveAssistantChats(): string[] {
  return [...active.keys()]
}