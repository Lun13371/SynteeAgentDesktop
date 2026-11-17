import { sidecarSemanticSearch, resolveSemanticModelPaths, type SidecarSemanticHit } from '../sidecar/sidecarClient'
import { getSkillManager } from '../skills/skillManager'
import { getEmbedder, cosineSimilarity, type Embedding } from '../context/embeddings'
import type { HintCandidate, AssistantsSettings } from '../../shared/assistants'
import { log } from '../logger'
import { getMemorySettings } from '../memory/globalMemorySettings'

export type WatcherTrigger =
  | { kind: 'user_message'; text: string }
  | { kind: 'tool_error'; toolName: string; error: string }
  | { kind: 'tool_repeat'; toolName: string; count: number }
  | { kind: 'plan_change'; text: string }
  | { kind: 'task_start'; text: string }
  | { kind: 'periodic'; text: string }
  | { kind: 'stuck'; text: string }
  | { kind: 'capability_gap'; toolName: string; text: string }

/** Возможность, доступная в ране: тул / MCP / plugin / скилл. */
export interface Capability {
  id: string
  kind: 'tool' | 'mcp' | 'plugin' | 'skill'
  name: string
  desc: string
}

/**
 * Дешёвый детерминированный prefilter: overlap ключевых слов контекста и описания.
 * Пустой результат (RU-запрос против EN-имён скиллов — типовой случай, overlap
 * не находится) — сигнал вызвать семантический скоринг scoreCapabilitiesSemantic.
 */
export function prefilterCapabilities(caps: Capability[], query: string, limit = 10): Capability[] {
  const kw = extractKeywords(query)
  if (kw.length === 0) return []
  const scored = caps.map(c => {
    const hay = `${c.name} ${c.desc}`.toLowerCase()
    const hits = kw.filter(k => hay.includes(k)).length
    return { c, hits }
  })
  scored.sort((a, b) => b.hits - a.hits)
  return scored.filter(s => s.hits > 0).slice(0, limit).map(s => s.c)
}

// Кэш эмбеддингов каталога: скиллы меняются редко, а prefilter ходит на каждый
// триггер. Ключ — id+имя+описание, переименование/правка сбрасывают запись.
const capEmbeddingCache = new Map<string, Embedding>()
// MCP catalogues can contain hundreds of tools. A 200-entry FIFO cache
// recomputed an entire 488-tool catalogue on every pass as it evicted itself.
const MAX_CAP_EMBEDDINGS = 4096

/**
 * Семантический скоринг каталога (fallback, когда keyword-overlap пуст —
 * RU-запрос против EN-имён скиллов). TF-IDF/MiniLM косинус; для LLM-судьи
 * важен порядок кандидатов, а не абсолютная величина скоринга.
 */
export async function scoreCapabilitiesSemantic(caps: Capability[], query: string, signal?: AbortSignal): Promise<Array<{ cap: Capability; score: number }>> {
  if (caps.length === 0) return []
  try {
    signal?.throwIfAborted()
    const embedder = await getEmbedder()
    const qv = await embedder.embed(query)
    const scored: Array<{ cap: Capability; score: number }> = []
    for (const cap of caps) {
      signal?.throwIfAborted()
      const key = `${embedder.mode}|${embedder.dim}|${cap.id}|${cap.name}|${cap.desc}`
      let cv = capEmbeddingCache.get(key)
      if (cv) capEmbeddingCache.delete(key)
      if (!cv) {
        cv = await embedder.embed(`${cap.name} ${cap.desc}`)
        signal?.throwIfAborted()
      }
      capEmbeddingCache.set(key, cv)
      if (capEmbeddingCache.size > MAX_CAP_EMBEDDINGS) {
        const oldest = capEmbeddingCache.keys().next().value
        if (oldest) capEmbeddingCache.delete(oldest)
      }
      scored.push({ cap, score: cosineSimilarity(qv, cv) })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored
  } catch (err) {
    log('[Watcher] semantic capability scoring failed: %s', (err as Error).message)
    return []
  }
}

/** Простой хэш контекста для novelty-gate (не криптостойкий, только дедуп). */
export function hashContext(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0 }
  return String(h)
}

const MAX_HINTS_PER_TRIGGER = 2
// E5-cosine: 0.55–0.65 набирает почти любой текст «на похожую тему» — раньше
// планка 0.55 была главным источником мусорных memory-хинтов. 0.65 отсекает
// маргинальную корреляцию, осмысленные совпадения у e5 обычно 0.7+.
const MIN_E5_SCORE = 0.65
const SKILL_KEYWORD_MIN_MATCH = 2

function buildQuery(trigger: WatcherTrigger): string {
  switch (trigger.kind) {
    case 'user_message': return trigger.text.slice(0, 300)
    case 'tool_error': return `${trigger.toolName} error: ${trigger.error.slice(0, 200)}`
    case 'tool_repeat': return `${trigger.toolName} repeated ${trigger.count} times, alternative approach`
    case 'plan_change': return trigger.text.slice(0, 300)
    case 'task_start': return trigger.text.slice(0, 300)
    case 'periodic': return trigger.text.slice(0, 300)
    case 'stuck': return trigger.text.slice(0, 300)
    case 'capability_gap': return `${trigger.toolName} unavailable: ${trigger.text.slice(0, 200)}`
  }
}

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 12)
}

async function searchMemory(query: string, settings: AssistantsSettings, dbPath: string, projectId?: string): Promise<HintCandidate[]> {
  if (!settings.sources.memory) return []
  const memory = getMemorySettings()
  if (!memory.enabled || (!memory.global && !memory.project && !memory.chat)) return []
  const paths = resolveSemanticModelPaths()
  if (!paths) return []
  try {
    const hits: SidecarSemanticHit[] = await sidecarSemanticSearch(
      {
        dbPath,
        query,
        limit: 5,
        sources: ['memory'],
        scope: 'all',
        projectId: projectId ?? null,
        crossProject: false,
        kind: null,
        memoryEnabled: memory.enabled,
        memoryGlobal: memory.global,
        memoryProject: memory.project,
        memoryChat: memory.chat,
      },
      paths,
    )
    const current = getMemorySettings()
    // A user may disable a scope while the sidecar is still searching.
    if (!current.enabled || current.global !== memory.global || current.project !== memory.project || current.chat !== memory.chat) return []
    return hits
      .filter(h => h.score >= MIN_E5_SCORE)
      .slice(0, MAX_HINTS_PER_TRIGGER)
      .map(h => ({
        id: `mem-${h.sourceId}`,
        source: 'memory' as const,
        content: h.content.slice(0, 500),
        score: h.score,
        title: h.chatTitle ?? undefined,
      }))
  } catch (err) {
    log('[Watcher] E5 search failed: %s', (err as Error).message)
    return []
  }
}

function searchSkills(query: string, settings: AssistantsSettings, opts: { projectWorkdir?: string; projectId?: string }): HintCandidate[] {
  if (!settings.sources.skills) return []
  try {
    const manager = getSkillManager()
    const skills = manager.getActiveSkillsForChat(opts)
    const keywords = extractKeywords(query)
    if (keywords.length === 0) return []

    const scored: Array<{ skill: typeof skills[0]; score: number }> = []
    for (const skill of skills) {
      const haystack = `${skill.name} ${skill.description} ${skill.instructions.slice(0, 400)}`.toLowerCase()
      const matches = keywords.filter(k => haystack.includes(k)).length
      if (matches >= SKILL_KEYWORD_MIN_MATCH) {
        scored.push({ skill, score: matches / keywords.length })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, MAX_HINTS_PER_TRIGGER).map(({ skill, score }) => ({
      id: `skill-${skill.id}`,
      source: 'skill' as const,
      content: skill.instructions.slice(0, 500),
      score,
      title: skill.name,
    }))
  } catch (err) {
    log('[Watcher] skill search failed: %s', (err as Error).message)
    return []
  }
}

export class Watcher {
  private settings: AssistantsSettings
  private dbPath: string
  private projectOpts: { projectWorkdir?: string; projectId?: string }
  private recentIds = new Set<string>()
  private lastTriggerTs = 0
  private minIntervalMs = 3000
  /** W1 feedback: вес источника из bridge (0.5–1.5, корректируется после ранов). 1 = без коррекции. */
  private sourceWeightFn: (source: string) => number = () => 1

  constructor(settings: AssistantsSettings, dbPath: string, projectOpts: { projectWorkdir?: string; projectId?: string } = {}) {
    this.settings = settings
    this.dbPath = dbPath
    this.projectOpts = projectOpts
  }

  updateSettings(settings: AssistantsSettings): void {
    this.settings = settings
  }

  setSourceWeightProvider(fn: (source: string) => number): void {
    this.sourceWeightFn = fn
  }

  updateProject(opts: { projectWorkdir?: string; projectId?: string }): void {
    this.projectOpts = opts
  }

  async onTrigger(trigger: WatcherTrigger, extraQueries: string[] = [], memoryOnly = false): Promise<HintCandidate[]> {
    if (!this.settings.enabled || !this.settings.watcherEnabled) return []
    const now = Date.now()
    if (now - this.lastTriggerTs < this.minIntervalMs) return []
    this.lastTriggerTs = now

    const queries = [buildQuery(trigger), ...extraQueries.slice(0, 2)]
    const projectId = this.projectOpts.projectId
    const memoryBatches = await Promise.all(queries.map(q => searchMemory(q, this.settings, this.dbPath, projectId)))
    if (!this.settings.enabled || !this.settings.watcherEnabled || projectId !== this.projectOpts.projectId) return []
    const skillHints = memoryOnly ? [] : searchSkills(queries[0], this.settings, this.projectOpts)
    const seen = new Set<string>()
    const memoryHints: HintCandidate[] = []
    for (const batch of memoryBatches) {
      if (!this.settings.sources.memory) break
      for (const h of batch) {
        if (seen.has(h.id)) continue
        seen.add(h.id)
        memoryHints.push(h)
      }
    }

    const all = [...memoryHints, ...skillHints]
      .filter(h => !this.recentIds.has(h.id))
      // Feedback-петля в деле: вес источника умножается на скор. Для memory это
      // поднимает E5-планку у «расстроенного» источника (0.5 → нужен скор ≥1.3,
      // т.е. фактически замолкает). На skill порог не распространяем — его
      // keyword-score несравним с E5-cosine.
      .filter(h => h.source !== 'memory' || h.score * this.sourceWeightFn('memory') >= MIN_E5_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_HINTS_PER_TRIGGER)

    for (const h of all) {
      this.recentIds.add(h.id)
      if (this.recentIds.size > 100) {
        const first = this.recentIds.values().next().value
        if (first) this.recentIds.delete(first)
      }
    }

    if (all.length > 0) {
      log('[Watcher] trigger=%s → %d hints (top score=%.2f)', trigger.kind, all.length, all[0].score)
    }
    return all
  }
}
