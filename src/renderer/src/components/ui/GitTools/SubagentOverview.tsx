import { useEffect, useId, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronDown } from 'lucide-react'
import type { SubagentOverviewItem } from '../../../../../shared/types/subagentOverview'
import AgentOrb from '../AgentOrb/AgentOrb'
import './SubagentOverview.css'

const isActive = ({ status }: SubagentOverviewItem): boolean => status === 'running' || status === 'pending'

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** Общая плавность раскрытия — та же пружина, что у меню панели. */
const COLLAPSE_TRANSITION = { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const }
const COLLAPSE_MOTION = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: COLLAPSE_TRANSITION,
}

function AgentRows({ items, live = false, lang }: {
  items: SubagentOverviewItem[]
  live?: boolean
  lang: 'ru' | 'en'
}) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [live])

  const labels = lang === 'ru'
    ? { pending: 'Запускается', running: 'Работает', done: 'Готово', error: 'Ошибка', cancelled: 'Отменён' }
    : { pending: 'Starting', running: 'Running', done: 'Done', error: 'Failed', cancelled: 'Cancelled' }
  const fallback = lang === 'ru' ? 'Саб-агент' : 'Subagent'

  return (
    <ul className="overview-agents-list">
      {items.map(agent => {
        const end = live ? now : agent.finishedAt
        const duration = end == null ? '—' : formatDuration(end - agent.createdAt)
        // Провал и отмена — время зачёркнуто; галочка только у реально
        // выполненного. Отменённый агент никогда не выглядит успешным.
        const unfinished = agent.status === 'error' || agent.status === 'cancelled'
        const task = agent.task.trim() || fallback
        return (
          <li className="overview-agent" key={agent.id}>
            <AgentOrb size={15} role={agent.role ?? undefined} status={agent.status} />
            <span className="overview-agent-task" title={task}>{task}</span>
            <span className="overview-agent-time" title={`${labels[agent.status]} · ${duration}`}>
              {unfinished ? <s>{duration}</s> : duration}
              {agent.status === 'done' && <Check size={12} className="overview-agent-check" aria-hidden="true" />}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

export default function SubagentOverview({ items, lang }: { items: SubagentOverviewItem[]; lang: 'ru' | 'en' }) {
  // Есть работающие агенты → блок раскрыт сам и показывает их; все
  // завершились → сворачивается. Ручной клик живёт до следующей смены этого
  // состояния, поэтому список завершённых не схлопывается на каждом апдейте.
  const auto = items.some(isActive)
  const [ui, setUI] = useState<{ auto: boolean; user: boolean | null; archive: boolean }>(
    { auto, user: null, archive: false },
  )
  if (ui.auto !== auto) setUI({ auto, user: null, archive: false })

  const bodyId = useId()
  const archiveId = useId()
  const expanded = ui.user ?? ui.auto
  const archiveOpen = expanded && ui.archive

  if (!items.length) return null

  const active = items.filter(isActive).sort((a, b) => a.createdAt - b.createdAt)
  const finished = items
    .filter(item => !isActive(item))
    .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt))

  return (
    <section className="overview-agents">
      <button
        type="button"
        className="overview-agents-toggle"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setUI(prev => ({ ...prev, user: !expanded }))}
      >
        <span className="overview-agents-title">{lang === 'ru' ? 'Саб-агенты' : 'Subagents'}</span>
        <span className="overview-agents-count">{items.length}</span>
        <ChevronDown size={12} className="overview-agents-chevron" aria-hidden="true" />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div id={bodyId} className="overview-agents-collapse" {...COLLAPSE_MOTION}>
            <div className="overview-agents-scroll">
              {active.length > 0 && <AgentRows items={active} live lang={lang} />}

              {finished.length > 0 && (
                <>
                  <button
                    type="button"
                    className="overview-agents-archive-toggle"
                    aria-expanded={archiveOpen}
                    aria-controls={archiveId}
                    onClick={() => setUI(prev => ({ ...prev, archive: !prev.archive }))}
                  >
                    <span>{lang === 'ru' ? 'Завершённые' : 'Finished'}</span>
                    <span className="overview-agents-archive-count">{finished.length}</span>
                    <ChevronDown size={11} className="overview-agents-chevron" aria-hidden="true" />
                  </button>
                  <AnimatePresence initial={false}>
                    {archiveOpen && (
                      <motion.div key="archive" className="overview-agents-collapse" {...COLLAPSE_MOTION}>
                        <div id={archiveId}>
                          <AgentRows items={finished} lang={lang} />
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}