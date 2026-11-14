import { sidecarSemanticSearch, resolveSemanticModelPaths, type SidecarSemanticHit } from '../sidecar/sidecarClient'
import { getSkillManager } from '../skills/skillManager'
import type { HintCandidate, AssistantsSettings } from '../../shared/assistants'
import { log } from '../logger'

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

/** Дешёвый детерминированный prefilter: overlap ключевых слов контекста и описания. */
export function prefilterCapabilities(caps: Capability[], query: string, limit = 10): Capability[] {
  const kw = extractKeywords(query)
  if (kw.length === 0) return caps.slice(0, limit)
  const scored = caps.map(c => {
    const hay = `${c.name} ${c.desc}`.toLowerCase()
    const hits = kw.filter(k => hay.includes(k)).length
    return { c, hits }
  })
  scored.sort((a, b) => b.hits - a.hits)
  return scored.filter(s => s.hits > 0).slice(0, limit).map(s => s.c)
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

async function searchMemory(query: string, settings: AssistantsSettings, dbPath: string): Promise<HintCandidate[]> {
  if (!settings.sources.memory) return []
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
        projectId: null,
        crossProject: false,
        kind: null,
        memoryEnabled: true,
        memoryGlobal: true,
        memoryProject: true,
        memoryChat: true,
      },
      paths,
    )
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

  async onTrigger(trigger: WatcherTrigger, extraQueries: string[] = []): Promise<HintCandidate[]> {
    if (!this.settings.enabled || !this.settings.watcherEnabled) return []
    const now = Date.now()
    if (now - this.lastTriggerTs < this.minIntervalMs) return []
    this.lastTriggerTs = now

    const queries = [buildQuery(trigger), ...extraQueries.slice(0, 2)]
    const memoryBatches = await Promise.all(queries.map(q => searchMemory(q, this.settings, this.dbPath)))
    const skillHints = searchSkills(queries[0], this.settings, this.projectOpts)
    const seen = new Set<string>()
    const memoryHints: HintCandidate[] = []
    for (const batch of memoryBatches) {
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