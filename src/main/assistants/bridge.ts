import { Watcher, type WatcherTrigger, type Capability, prefilterCapabilities, scoreCapabilitiesSemantic, hashContext } from '../../core/agent/watcher'
import { DEFAULT_ASSISTANTS_SETTINGS, type AssistantsSettings, type AssistantsWeights, type HintCandidate, type AssistantLogEntry, type AgentStatsMap, ASSISTANTS_LOG_MAX_ENTRIES, ASSISTANTS_LOG_RETENTION_MS } from '../../shared/assistants'
import { log } from '../../core/logger'
import { judgeRelevance, judgeDrift, distillSession, extractConstraints, summarizeTool, judgeCapability } from './llmClient'
import { getServerState } from './llmServer'
import { saveMemoryItem, decayAutoFacts } from '../../core/memory/MemoryStore'
import { sidecarSemanticSearch, resolveSemanticModelPaths } from '../../core/sidecar/sidecarClient'
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
  controller: AbortController
}

const active = new Map<string, ActiveAssistant>()
function isCurrent(a: ActiveAssistant): boolean {
  return active.get(a.chatId) === a && !a.controller.signal.aborted && a.settings.enabled
}
const assistantLog: AssistantLogEntry[] = []
// W1 feedback: веса источников и последние инжектированные хинты per chat.
const sourceWeights = new Map<string, number>()
const capabilityWeights = new Map<string, number>()
const injectedHints = new Map<string, Array<{ id: string; source: string; capId?: string; content: string }>>()

// Дедуп хинтов по тексту per chat: navigator/capability шлют одно и то же
// («Возвращайся к цели: X») каждые N раундов — для модели шум, для контекста
// мусор. Нормализованный текст не инжектится повторно в пределах чата
// (пересекает и следующие запросы — watcher/Agent свежие, а мост живой).
const recentHintTexts = new Map<string, Set<string>>()
function normalizeHintText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120)
}
/** true — текст впервые (можно инжектить), false — дубль. */
function markHintText(chatId: string, content: string): boolean {
  let set = recentHintTexts.get(chatId)
  if (!set) set = new Set()
  recentHintTexts.delete(chatId)
  recentHintTexts.set(chatId, set)
  if (recentHintTexts.size > 128) {
    const oldestChat = recentHintTexts.keys().next().value
    if (oldestChat) recentHintTexts.delete(oldestChat)
  }
  const key = normalizeHintText(content)
  if (set.has(key)) return false
  set.add(key)
  if (set.size > 40) {
    const oldest = set.values().next().value
    if (oldest) set.delete(oldest)
  }
  return true
}

// Персист W1-весов: без него feedback-петля обнуляется каждым рестартом.
let persistWeightsFn: ((w: AssistantsWeights) => void) | null = null
function clampWeight(v: number): number { return Math.min(1.5, Math.max(0.5, v)) }
function persistWeights(): void {
  if (!persistWeightsFn) return
  try { persistWeightsFn({ sources: Object.fromEntries(sourceWeights), capabilities: Object.fromEntries(capabilityWeights) }) } catch { /* не критично */ }
}

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

export function initAssistants(opts: { load: () => Partial<AssistantsSettings> | undefined; persist: (s: AssistantsSettings) => void; dbPath: () => string; loadStats?: () => AgentStatsMap | undefined; persistStats?: (s: AgentStatsMap) => void; loadWeights?: () => AssistantsWeights | undefined; persistWeights?: (w: AssistantsWeights) => void }): void {
  const saved = opts.load()
  if (saved) globalSettings = { ...DEFAULT_ASSISTANTS_SETTINGS, ...saved }
  persistFn = opts.persist
  dbPathResolver = opts.dbPath
  const savedStats = opts.loadStats?.()
  if (savedStats) Object.assign(agentStats, savedStats)
  persistStatsFn = opts.persistStats ?? null
  const savedWeights = opts.loadWeights?.()
  if (savedWeights) {
    for (const [k, v] of Object.entries(savedWeights.sources ?? {})) if (typeof v === 'number') sourceWeights.set(k, clampWeight(v))
    for (const [k, v] of Object.entries(savedWeights.capabilities ?? {})) if (typeof v === 'number') capabilityWeights.set(k, clampWeight(v))
  }
  persistWeightsFn = opts.persistWeights ?? null
  if (globalSettings.enabled) {
    applyModelSize()
  }
}

export function setAssistantsDbPathResolver(resolver: () => string): void {
  dbPathResolver = resolver
}

export function getAssistantsSettings(): AssistantsSettings {
  return globalSettings
}

export function updateAssistantsSettings(patch: Partial<AssistantsSettings>): AssistantsSettings {
  const previous = globalSettings
  const wasEnabled = globalSettings.enabled
  globalSettings = { ...globalSettings, ...patch }
  // Retire pending advisory work even if a role/source is re-enabled before it finishes.
  const advisorySettingsChanged = previous.watcherEnabled !== globalSettings.watcherEnabled
    || previous.navigatorEnabled !== globalSettings.navigatorEnabled
    || previous.janitorEnabled !== globalSettings.janitorEnabled
    || previous.sources?.memory !== globalSettings.sources?.memory
    || previous.sources?.skills !== globalSettings.sources?.skills
  persistFn?.(globalSettings)
  for (const a of active.values()) {
    a.settings = globalSettings
    if (!globalSettings.enabled || advisorySettingsChanged) a.controller.abort()
    if (globalSettings.enabled && a.controller.signal.aborted) a.controller = new AbortController()
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
  // Контекст — аргумент запуска сервера: применяем здесь же, чтобы смена
  // настройки не ждала следующего рестарта.
  localModels.setCtxSetting(globalSettings.ctxSize)
  // Устройство (auto/cpu/gpu) — тоже аргумент запуска; смена рестартит сервер.
  localModels.setDevice(globalSettings.device)
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
  if (!globalSettings.enabled) return false
  if (getServerState() === 'ready') return true
  void localModels.ensureReady()
  return false
}

// Ожидание холодного старта: serverReady() лениво запускает ensureReady после
// idle-выгрузки или на старте приложения. Раньше мы не ждали и сразу уходили
// в fallback — инжектили сырые memory-хинты без LLM-судьи (главный источник
// мусора у watcher'а). Несколько секунд ожидания для advisory-события ничего
// не блокируют, а хинт всё равно consumed на следующей границе раунда.
const SERVER_WAKE_TIMEOUT_MS = 12_000
async function serverReadyOrWake(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false
  if (serverReady()) return true
  const deadline = Date.now() + SERVER_WAKE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!globalSettings.enabled || signal?.aborted) return false
    // 'error' — сервер упал окончательно (исчерпал рестарты): ждём зря.
    if (localModels.getState() === 'error') return false
    await new Promise(r => setTimeout(r, 400))
    if (!signal?.aborted && serverReady()) return true
  }
  return false
}

export function attachAssistants(chatId: string, worker: Worker, opts: { projectWorkdir?: string; projectId?: string } = {}): void {
  if (!globalSettings.enabled) {
    log('[Assistants] attach skipped (disabled) chat=%s', chatId)
    return
  }
  const dbPath = dbPathResolver?.() ?? ''
  const watcher = new Watcher(globalSettings, dbPath, opts)
  // W1 feedback: веса источников (корректируются в onRunDone) влияют на
  // отбор memory-хинтов — «расстроенный» источник замолкает.
  watcher.setSourceWeightProvider((src) => sourceWeights.get(src) ?? 1)
  active.get(chatId)?.controller.abort()
  const a: ActiveAssistant = { watcher, chatId, worker, settings: globalSettings, capabilities: [], projectWorkdir: opts.projectWorkdir, lastHash: '', lastErrorHash: '', controller: new AbortController() }
  active.set(chatId, a)
  worker.once('exit', () => { if (active.get(chatId) === a) detachAssistants(chatId, true) })
  worker.postMessage({ type: 'assistants_settings', settings: globalSettings })
  log('[Assistants] attached to chat %s (watcher=%s janitor=%s)', chatId, globalSettings.watcherEnabled, globalSettings.janitorEnabled)
}

export function detachAssistants(chatId: string, preserveHintHistory = false): void {
  const a = active.get(chatId)
  a?.controller.abort()
  if (a) a.worker = null
  active.delete(chatId)
  if (!preserveHintHistory) recentHintTexts.delete(chatId)
  injectedHints.delete(chatId)
}

export async function onAgentEvent(chatId: string, trigger: WatcherTrigger): Promise<void> {
  const a = active.get(chatId)
  if (!a || !a.settings.enabled || !a.settings.watcherEnabled) {
    log('[Assistants] watcher skip chat=%s attached=%s enabled=%s', chatId, !!a, a?.settings.enabled)
    return
  }
  const signal = a.controller.signal
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
    const ready = await serverReadyOrWake(signal)
    if (signal.aborted || !isCurrent(a) || !a.settings.watcherEnabled) return
    if (ready) {
      // Local memory retrieval also runs with the LLM router online. It uses
      // E5 only (no extra generation) and shares the normal novelty gate.
      const memoryHints = await a.watcher.onTrigger(trigger, [], true)
      if (signal.aborted || !isCurrent(a) || !a.settings.watcherEnabled) return
      for (const hint of memoryHints.slice(0, 1)) {
        if (!markHintText(chatId, hint.content)) continue
        a.worker?.postMessage({ type: 'hint', hint })
        appendLog({ ts: Date.now(), role: 'watcher', kind: 'hint_injected', detail: `[memory] ${hint.content.slice(0, 80)}` })
        bump('watcher', 'fired')
      }
      // Capability router: prefilter каталога → точный структурный вердикт.
      let caps = prefilterCapabilities(a.capabilities, ctx, 10)
      if (caps.length === 0 && a.capabilities.length > 0) {
        // Keyword-overlap пуст (RU-запрос против EN-имён скиллов). Семантический
        // скоринг вместо «первых 10 по порядку» — порядок кандидатов для судьи.
        const semantic = await scoreCapabilitiesSemantic(a.capabilities, ctx, signal)
        caps = semantic.filter(s => s.score >= 0.1).slice(0, 10).map(s => s.cap)
      }
      const verdict = await judgeCapability(ctx, caps.sort((x, y) => (capabilityWeights.get(y.id) ?? 1) - (capabilityWeights.get(x.id) ?? 1)), signal)
      if (signal.aborted || !isCurrent(a) || !a.settings.watcherEnabled) return
      if (verdict.helpful && verdict.confidence >= 0.6) {
        const cap = a.capabilities.find(c => c.id === verdict.id)
        const hint: HintCandidate = { id: `cap-${verdict.id}-${Date.now()}`, source: 'capability', content: verdict.action, score: verdict.confidence, title: cap?.name ?? verdict.id }
        if (markHintText(chatId, hint.content)) {
          a.worker?.postMessage({ type: 'hint', hint })
          const inj = injectedHints.get(chatId) ?? []
          inj.push({ id: hint.id, source: hint.source, capId: verdict.id, content: hint.content.slice(0, 400) })
          injectedHints.set(chatId, inj.slice(-20))
          appendLog({ ts: Date.now(), role: 'watcher', kind: 'hint_injected', detail: `[capability:${hint.title}] ${hint.content.slice(0, 80)}` })
          bump('watcher', 'fired')
        } else {
          appendLog({ ts: Date.now(), role: 'watcher', kind: 'skip', detail: `дубль текста хинта — не инжектится: ${hint.content.slice(0, 60)}` })
          bump('watcher', 'skipped')
        }
      } else {
        appendLog({ ts: Date.now(), role: 'watcher', kind: 'skip', detail: 'нет уверенной рекомендации — пропуск' })
        bump('watcher', 'skipped')
      }
    } else {
      // Fallback без LLM: память/скиллы, не более одной подсказки.
      const hints = await a.watcher.onTrigger(trigger)
      if (signal.aborted || !isCurrent(a) || !a.settings.watcherEnabled) return
      for (const hint of hints.slice(0, 1)) {
        if (!markHintText(chatId, hint.content)) { bump('watcher', 'skipped'); continue }
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

// Детерминированная классификация факта Archivist: 0.8–1.2B модели часто
// пишут мусорный kind, а от него зависит тип записи в памяти. Эвристика по
// формулировке — приоритетнее вердикта модели.
function classifyFact(content: string, modelKind: string): 'project' | 'feedback' | 'user' {
  if (/(?:пользовател[ья]?|юзер|\buser\b)[^.\n]{0,60}(?:просит|просил|предпочитает|хочет|сказал)|я (?:предпочитаю|всегда)/i.test(content)) return 'user'
  if (/(?:в проекте|у нас) (?:принято|используется)|конвенц|convention|правило проекта|всегда используем|always use/i.test(content)) return 'feedback'
  return (['project', 'feedback', 'user'] as const).includes(modelKind as 'project') ? modelKind as 'project' : 'project'
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
  const kind = String(evt.kind ?? '')
  // Bookkeeping must never wake/download a local LLM or wait behind startup.
  switch (kind) {
    case 'capabilities': a.capabilities = (evt.capabilities as Capability[]) ?? []; return
    case 'watcher_trigger': {
      const trigger = evt.trigger as WatcherTrigger | undefined
      if (trigger) await onAgentEvent(chatId, trigger)
      return
    }
    case 'economist': bump('economist', 'fired'); return
    case 'briefing': bump('briefing', 'fired'); return
    case 'janitor_skip': bump('janitor', 'skipped'); return
  }
  if ((kind === 'navigator' && !s.navigatorEnabled) || (kind === 'archivist' && !s.archivistEnabled) || (kind === 'janitor_refine' && !s.janitorEnabled)) return
  if (!['navigator', 'archivist', 'constitution_extract', 'janitor_refine'].includes(kind)) return
  // Archivist intentionally outlives the worker: it persists durable memory
  // emitted just before the terminal event. Other advisory jobs are run-bound.
  const signal = kind === 'archivist' ? undefined : a.controller.signal
  const ready = await serverReadyOrWake(signal)
  if (!ready || !globalSettings.enabled || (signal && (signal.aborted || !isCurrent(a)))) return
  const post = (hint: HintCandidate): boolean => {
    if (signal?.aborted || !isCurrent(a) || (hint.source === 'navigator' && !a.settings.navigatorEnabled)) return false
    const role: AssistantLogEntry['role'] = (hint.source === 'memory' || hint.source === 'skill' || hint.source === 'constitution' || hint.source === 'capability') ? 'watcher' : (hint.source as AssistantLogEntry['role'])
    if (!markHintText(chatId, hint.content)) {
      appendLog({ ts: Date.now(), role, kind: 'skip', detail: `дубль текста хинта — не инжектится: ${hint.content.slice(0, 60)}` })
      return false
    }
    a.worker?.postMessage({ type: 'hint', hint })
    appendLog({ ts: Date.now(), role, kind: 'hint_injected', detail: `[${hint.source}] ${hint.content.slice(0, 80)}` })
    return true
  }
  try {
    switch (kind) {
      case 'navigator': {
        if (!s.navigatorEnabled || !ready) return
        const verdict = await judgeDrift(String(evt.objective ?? ''), String(evt.transcript ?? ''), Array.isArray(evt.constraints) ? evt.constraints as string[] : [], String(evt.todo ?? ''), signal)
        if (verdict.drift || verdict.violation) {
          const content = verdict.violation
            ? `Нарушаешь ограничение: ${verdict.reason || 'соблюдай закреплённые правила.'}`
            : `Возвращайся к цели: ${verdict.reason || 'текущие шаги уходят в сторону.'}`
          if (post({ id: `nav-${Date.now()}`, source: 'navigator', content, score: 1 })) bump('navigator', 'fired')
          else bump('navigator', 'skipped')
        } else {
          bump('navigator', 'skipped')
        }
        break
      }
      case 'archivist': {
        if (!s.archivistEnabled || !ready) return
        const transcript = String(evt.transcript ?? '')
        // Короткий ран (ответ «готово» без работы) — дистилляции там взяться
        // неоткуда, не тратим слот локальной модели.
        if (transcript.trim().length < 250) {
          appendLog({ ts: Date.now(), role: 'archivist', kind: 'skip', detail: `транскрипт слишком короткий (${transcript.trim().length} симв.) — дистилляция не запускалась` })
          bump('archivist', 'skipped')
          break
        }
        const files = Array.isArray(evt.modifiedFiles) ? (evt.modifiedFiles as unknown[]).filter((f): f is string => typeof f === 'string').slice(0, 10) : []
        const facts = await distillSession(transcript, files)
        if (!globalSettings.enabled || !globalSettings.archivistEnabled) return
        let savedCount = 0
        for (const f of facts) {
          if (await isE5Duplicate(f.content, evt.projectId as string | undefined)) {
            appendLog({ ts: Date.now(), role: 'archivist', kind: 'dedup', detail: `E5-дубль пропущен: ${f.content.slice(0, 60)}` })
            continue
          }
          const kindMap: Record<string, 'project_decision' | 'convention' | 'user_fact'> = { project: 'project_decision', feedback: 'convention', user: 'user_fact' }
          await saveMemoryItem({
            title: f.content.slice(0, 60), content: f.content, kind: kindMap[classifyFact(f.content, f.kind)] ?? 'project_decision',
            scope: evt.projectId ? 'project' : 'global', projectId: (evt.projectId as string) ?? undefined,
            chatId: (evt.chatId as string) ?? undefined, source: 'auto_extract', importance: 0.6,
          })
          savedCount++
        }
        if (savedCount) {
          appendLog({ ts: Date.now(), role: 'archivist', kind: 'distilled', detail: `сохранено ${savedCount} фактов в память` })
          bump('archivist', 'fired')
        } else {
          // Пустой результат больше не молчаливый: сырой вывод модели виден
          // в debug.log ([LlmClient] distill: ...), здесь — причина в UI-логе.
          appendLog({ ts: Date.now(), role: 'archivist', kind: 'skip', detail: '0 фактов: модель вернула пустоту/мусор (детали в debug.log) или все E5-дубли' })
          bump('archivist', 'skipped')
        }
        maybeDecay()
        break
      }
      case 'constitution_extract': {
        if (!ready) return
        const items = await extractConstraints(String(evt.text ?? ''), signal)
        if (items.length && !signal?.aborted && isCurrent(a)) a.worker?.postMessage({ type: 'constitution', items })
        break
      }
      case 'janitor_refine': {
        if (!ready) return
        const summary = await summarizeTool(String(evt.toolName ?? 'tool'), String(evt.content ?? ''), signal)
        if (summary && !signal?.aborted && isCurrent(a) && a.settings.janitorEnabled) a.worker?.postMessage({ type: 'janitor_refined', archiveId: evt.archiveId, summary })
        break
      }
    }
  } catch (err) {
    log('[Assistants] agent %s error chat=%s: %s', kind, chatId, (err as Error).message)
  }
}

/** W1 feedback: после рана спрашиваем судью, какие хинты помогли, и корректируем веса.
 *  `invoked` — реально вызванные тулы/скиллы рана (из collectedSteps): точный
 *  сигнал «возможность использована» вместо хрупкого includes по транскрипту. */
export async function onRunDone(chatId: string, transcriptTail: string, invoked?: { tools: string[]; skills: string[] }): Promise<void> {
  const inj = injectedHints.get(chatId) ?? []
  injectedHints.delete(chatId)
  if (inj.length === 0 || !globalSettings.enabled || !serverReady()) return
  try {
    const list = inj.map(h => h.content).join('; ')
    const verdict = await judgeRelevance(`session transcript: ${transcriptTail.slice(0, 400)}`, `hints used: ${list}`)
    // Простая эвристика: если судья считает контекст релевантным — поднимаем веса источников.
    const invokedSet = new Set([...(invoked?.tools ?? []), ...(invoked?.skills ?? [])])
    for (const h of inj) {
      const w = sourceWeights.get(h.source) ?? 1
      sourceWeights.set(h.source, clampWeight(w + (verdict.relevant ? 0.05 : -0.05)))
      if (h.capId) {
        // Точный сигнал — формальный вызов (get_skill с именем скилла / тул
        // возможности); includes по транскрипту остаётся фолбэком: модель
        // может последовать скиллу, не упоминая его имя в шагах.
        const used = invokedSet.has(h.capId) || transcriptTail.includes(h.capId)
        const cw = capabilityWeights.get(h.capId) ?? 1
        capabilityWeights.set(h.capId, clampWeight(cw + (used ? 0.1 : -0.05)))
      }
    }
    persistWeights()
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
