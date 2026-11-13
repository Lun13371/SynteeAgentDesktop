import { useState, useEffect, useRef, memo, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon, { type IconName } from '../AppIcon/AppIcon'
import AgentOrb from '../AgentOrb/AgentOrb'
import { getSubagentRole } from '../../../../../shared/subagent-roles'
import { getToolMeta } from '../../../../../shared/toolMeta'
import './AgentCard.css'

export type AgentStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

export interface AgentCardData {
  id: string
  task: string
  status: AgentStatus
  model: string
  stepsCount: number
  currentStep?: string
  summary?: string
  error?: string
  createdAt: number
  finishedAt?: number
  role?: string
  steps?: Array<{ type: string; toolName?: string; toolArgs?: Record<string, unknown>; content: string; success?: boolean; timestamp: number }>
}

interface AgentCardProps {
  agent: AgentCardData
  onClick?: () => void
  /** Live-режим — принудительно развёрнут, крутит shimmer. */
  live?: boolean
}

// Qoder-style activity labels for the sub-agent feed. The reference card reads
// as a terse English log ("Thought", "Terminal command ran", "Search content",
// "Read file"); role names are already English (subagent-roles.nameEn).
const FEED_LABELS: Record<string, string> = {
  search_code: 'Search content',
  find_files: 'Search files',
  search_web: 'Search web',
  search_images: 'Search images',
  read_file: 'Read file',
  read_files: 'Read files',
  edit_file: 'Edit file',
  write_file: 'Write file',
  list_directory: 'List directory',
  get_fast_context: 'Fast context',
  get_diagnostics: 'Diagnostics',
  execute_code: 'Run code',
  fetch_page: 'Fetch page',
  generate_image: 'Generate image',
  analyze_image: 'Analyze image',
  spawn_agent: 'Spawn agent',
  get_agent_status: 'Agent status',
  update_todo: 'Update plan',
  recall_memory: 'Recall memory',
  save_memory: 'Save memory',
  update_working_memory: 'Update memory',
  ask_user: 'Ask user',
}

function humanize(name: string): string {
  const base = name.startsWith('mcp__') ? name.slice(name.lastIndexOf('__') + 2) : name
  const spaced = base.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function labelFor(name: string, done: boolean): string {
  if (name === 'run_command') return done ? 'Terminal command ran' : 'Running command'
  return FEED_LABELS[name] ?? humanize(name)
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function firstArg(args?: Record<string, unknown>): string {
  if (!args) return ''
  const v = Object.values(args)[0]
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length > n ? clean.slice(0, n) + '…' : clean
}

// File-backed tools render their target as a chip (reference: [fastContext.ipc.ts]).
function fileChips(name: string, args?: Record<string, unknown>): string[] | null {
  if (name === 'read_files') {
    const paths = args?.paths
    if (Array.isArray(paths)) return paths.filter((p): p is string => typeof p === 'string').map(basename)
    const fa = firstArg(args)
    return fa ? [basename(fa)] : null
  }
  if (name === 'read_file' || name === 'edit_file' || name === 'write_file') {
    const p = (args?.path ?? args?.file_path ?? args?.filePath) as string | undefined
    const target = typeof p === 'string' ? p : firstArg(args)
    return target ? [basename(target)] : null
  }
  return null
}

function previewFor(name: string, args?: Record<string, unknown>): { text: string; mono: boolean } {
  const fa = firstArg(args)
  if (name === 'run_command') return { text: String(args?.command ?? fa), mono: true }
  if (name === 'search_code' || name === 'find_files') {
    const pat = String(args?.pattern ?? args?.query ?? fa)
    const path = args?.path ? ` · ${String(args.path)}` : ''
    return { text: pat + path, mono: true }
  }
  if (name === 'list_directory') return { text: String(args?.path ?? fa), mono: true }
  if (name === 'get_fast_context') return { text: String(args?.query ?? args?.task ?? fa), mono: false }
  return { text: fa, mono: false }
}

type FeedItem =
  | { kind: 'thought'; key: string; text: string }
  | { kind: 'tool'; key: string; name: string; args?: Record<string, unknown>; done: boolean; failed: boolean; running: boolean }

// Pair tool_result back to its tool_call (sub-agents run tools sequentially,
// steps arrive in order) so each row knows whether it finished / failed / is
// still running. Thoughts pass through as their own rows.
function buildFeed(steps: AgentCardData['steps'], isLive: boolean): FeedItem[] {
  if (!steps?.length) return []
  const items: FeedItem[] = []
  const results = steps.filter(s => s.type === 'tool_result')
  const used = new Set<number>()
  steps.forEach((s, i) => {
    if (s.type === 'thought') {
      if (s.content?.trim()) items.push({ kind: 'thought', key: `th-${i}`, text: s.content })
    } else if (s.type === 'tool_call') {
      let done = false, failed = false
      for (let j = 0; j < results.length; j++) {
        if (used.has(j)) continue
        if (results[j].toolName === s.toolName) {
          used.add(j); done = true; failed = results[j].success === false
          break
        }
      }
      items.push({ kind: 'tool', key: `tc-${i}`, name: s.toolName ?? 'tool', args: s.toolArgs, done, failed, running: false })
    }
  })
  if (isLive) {
    for (let k = items.length - 1; k >= 0; k--) {
      const it = items[k]
      if (it.kind === 'tool') { if (!it.done) it.running = true; break }
    }
  }
  return items
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

// Ticking "Subagent running for Xs" — only the status span re-renders each
// second, not the whole card / feed.
const LiveStatus = memo(function LiveStatus({ status, createdAt, finishedAt }: {
  status: AgentStatus
  createdAt: number
  finishedAt?: number
}) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (status !== 'running' && status !== 'pending') return
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [status])
  const t = formatElapsed((finishedAt ?? Date.now()) - createdAt)
  if (status === 'running') return <span className="agent-c__status">Subagent running for {t}</span>
  if (status === 'pending') return <span className="agent-c__status">Subagent starting…</span>
  if (status === 'done') return <span className="agent-c__status">Subagent finished in {t}</span>
  if (status === 'error') return <span className="agent-c__status agent-c__status--error">Subagent failed</span>
  return <span className="agent-c__status">Subagent cancelled</span>
})

const FeedRow = memo(function FeedRow({ item }: { item: FeedItem }) {
  if (item.kind === 'thought') {
    return (
      <div className="agent-c__frow">
        <div className="agent-c__frail"><AppIcon name="brain" size="xs" /></div>
        <div className="agent-c__fbody">
          <span className="agent-c__flabel">Thought</span>
          <span className="agent-c__fsep">·</span>
          <span className="agent-c__fpreview">{truncate(item.text, 120)}</span>
        </div>
      </div>
    )
  }
  const meta = getToolMeta(item.name)
  const chips = fileChips(item.name, item.args)
  const preview = previewFor(item.name, item.args)
  return (
    <div className={`agent-c__frow${item.running ? ' agent-c__frow--running' : ''}${item.failed ? ' agent-c__frow--failed' : ''}`}>
      <div className="agent-c__frail">
        {item.running
          ? <span className="agent-c__fspin" />
          : <AppIcon name={meta.icon as IconName} size="xs" />}
      </div>
      <div className="agent-c__fbody">
        <span className="agent-c__flabel">{labelFor(item.name, item.done)}</span>
        <span className="agent-c__fsep">·</span>
        {chips ? (
          <span className="agent-c__fchips">
            {chips.map((c, i) => <span key={i} className="agent-c__chip" title={c}>{c}</span>)}
          </span>
        ) : preview.text ? (
          <span className={`agent-c__fpreview${preview.mono ? ' agent-c__fpreview--mono' : ''}`} title={preview.text}>
            {truncate(preview.text, 90)}
          </span>
        ) : null}
        {item.failed && <span className="agent-c__fbadge">error</span>}
      </div>
    </div>
  )
})

const AgentCard = memo(function AgentCard({ agent, onClick }: AgentCardProps) {
  const isLive = agent.status === 'running' || agent.status === 'pending'
  const [expanded, setExpanded] = useState(isLive)
  const roleName = agent.role ? getSubagentRole(agent.role).nameEn : 'Sub-agent'

  // Auto-expand while live; collapse shortly after the agent settles so the
  // finished card reads as a single tidy line (reference collapsed state).
  const wasLiveRef = useRef(isLive)
  useEffect(() => {
    if (isLive) {
      wasLiveRef.current = true
      setExpanded(true)
    } else if (wasLiveRef.current) {
      wasLiveRef.current = false
      const t = setTimeout(() => setExpanded(false), 1600)
      return () => clearTimeout(t)
    }
    return undefined
  }, [isLive])

  const feed = useMemo(() => buildFeed(agent.steps, isLive), [agent.steps, isLive])

  return (
    <div className={`agent-c agent-c--${agent.status}${isLive ? ' agent-c--live' : ''}`} role="group">
      <div className="agent-c__head">
        <button
          type="button"
          className="agent-c__toggle"
          aria-expanded={expanded}
          aria-label={`${roleName}: ${agent.task}`}
          onClick={() => setExpanded(v => !v)}
        >
          <AgentOrb role={agent.role} status={agent.status} size={18} />
          <span className="agent-c__name">{roleName}</span>
          <span className="agent-c__dot">·</span>
          <span className="agent-c__task" title={agent.task}>{agent.task}</span>
          <span className="agent-c__dot">·</span>
          <LiveStatus status={agent.status} createdAt={agent.createdAt} finishedAt={agent.finishedAt} />
          <AppIcon
            name="chevronDown"
            size="xs"
            className={`agent-c__chevron${expanded ? '' : ' agent-c__chevron--closed'}`}
          />
        </button>
        {onClick && (
          <button
            type="button"
            className="agent-c__open"
            title="Открыть в панели агентов"
            aria-label="Открыть в панели агентов"
            onClick={(e) => { e.stopPropagation(); onClick() }}
          >
            <AppIcon name="externalLink" size="xs" />
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            className="agent-c__feed"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.4, 0, 0.2, 1] }}
          >
            <div className="agent-c__feed-inner">
              {feed.map(item => <FeedRow key={item.key} item={item} />)}

              {isLive && feed.length === 0 && (
                <div className="agent-c__waiting">
                  <span className="agent-c__fspin" />
                  <span>Анализирую задачу…</span>
                </div>
              )}

              {agent.status === 'error' && agent.error && (
                <div className="agent-c__error">{agent.error}</div>
              )}

              {agent.status === 'done' && agent.summary && (
                <div className="agent-c__result">
                  <span className="agent-c__result-label">Result</span>
                  <span className="agent-c__result-text">{agent.summary}</span>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
})

export default AgentCard