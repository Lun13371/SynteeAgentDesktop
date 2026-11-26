import { memo, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import AgentOrb from '../AgentOrb/AgentOrb'
import { useSettingsStore } from '../../../store/settings.store'
import {
  ORCH_PHASE_LABEL,
  compareOrchestrationPhases,
  formatOrchestrationElapsed,
  orchestrationModelLabel,
  orchestrationModelTitle,
  type OrchestrationProgress,
  type OrchestrationProgressEntry,
} from '../../../utils/orchestrationProgress'
import './OrchestrationCard.css'

/** Статус всего рана (для истории приходит из сообщения, для live — из
 *  runStatusByChat). Отличает «остановлено»/«упало»/«завершено без
 *  подтверждения» от честного успеха. */
export type OrchestrationRunStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled' | null | undefined

interface OrchestrationCardProps {
  progress: OrchestrationProgress[]
  runStatus?: OrchestrationRunStatus
  /** Live-режим (идёт ран) — карточка развёрнута и тикает таймер. */
  live?: boolean
  /**
   * Продолжить прерванный ран: отправляет в чат сообщение-продолжение с тем же
   * выбором моделей. Показывается только когда ран не завершился успешно
   * (stopped/failed/unverified) и не идёт прямо сейчас.
   */
  onContinue?: () => void
  /** «Продолжить» уже нажали — кнопку не показываем (иначе второй ход). */
  continued?: boolean
}

type OverallStatus = 'running' | 'done' | 'stopped' | 'failed' | 'unverified'

function overallStatus(
  progress: OrchestrationProgress[],
  runStatus: OrchestrationRunStatus,
  live: boolean,
): OverallStatus {
  if (runStatus === 'cancelled') return 'stopped'
  if (runStatus === 'error') return 'failed'
  // Все фазы дошли до done → завершено. Иначе ран закончился, но часть фаз
  // осталась в running/blocked — «завершено без подтверждения» (не выдаём
  // это за успех: ревью могло быть заблокировано).
  const allDone = progress.length > 0 && progress.every(p => p.status === 'done')
  if (runStatus === 'done') return allDone ? 'done' : 'unverified'
  if (live || runStatus === 'running' || runStatus === 'queued') return 'running'
  return allDone ? 'done' : 'unverified'
}

const ORB_STATUS: Record<OverallStatus, 'running' | 'done' | 'error' | 'cancelled'> = {
  running: 'running',
  done: 'done',
  stopped: 'cancelled',
  failed: 'error',
  unverified: 'cancelled',
}

function statusText(status: OverallStatus, elapsedMs: number): string {
  const t = formatOrchestrationElapsed(elapsedMs)
  if (status === 'running') return `Running for ${t}`
  if (status === 'done') return `Finished in ${t}`
  if (status === 'stopped') return `Stopped after ${t}`
  if (status === 'failed') return `Failed after ${t}`
  return `Finished in ${t} · not confirmed`
}

function phaseDuration(p: OrchestrationProgress, now: number): number {
  const end = p.status === 'running' ? now : (p.updatedAt ?? now)
  return Math.max(0, end - (p.startedAt ?? end))
}

const PhaseRow = memo(function PhaseRow({ phase, now }: { phase: OrchestrationProgress; now: number }) {
  const dur = phaseDuration(phase, now)
  const modelLabel = orchestrationModelLabel(phase.model)
  return (
    <div className={`orch-c__row orch-c__row--${phase.status}`}>
      <div className="orch-c__rail">
        {phase.status === 'running' ? (
          <span className="orch-c__spin" />
        ) : phase.status === 'done' ? (
          <AppIcon name="check" size="xs" tone="success" />
        ) : (
          <AppIcon name="alertTriangle" size="xs" tone="warning" />
        )}
      </div>
      <div className="orch-c__rbody">
        <div className="orch-c__rhead">
          <span className="orch-c__phase">{ORCH_PHASE_LABEL[phase.phase] ?? phase.phase}</span>
          <span className="orch-c__sep">·</span>
          <span className="orch-c__model" title={orchestrationModelTitle(phase.model)}>{modelLabel}</span>
          {phase.model.reasoningValue && (
            <span className="orch-c__effort" title="Уровень мышления">{phase.model.reasoningValue}</span>
          )}
          <span className="orch-c__dur">{formatOrchestrationElapsed(dur)}</span>
          {phase.status === 'blocked' && <span className="orch-c__badge">blocked</span>}
        </div>
        {phase.detail && (
          <div className="orch-c__detail" title={phase.detail}>{phase.detail}</div>
        )}
      </div>
    </div>
  )
})

/**
 * Компактная карточка прогресса оркестрации одного рана — визуально тот же
 * приём, что у AgentCard (орб · заголовок · живой статус · раскрывающаяся
 * лента фаз). Это НЕ сабагент: карточка ничего не запрашивает по IPC, не
 * имеет своего id/панели и живёт только на данных `orchestration`.
 */
const OrchestrationCard = memo(function OrchestrationCard({ progress, runStatus, live, onContinue, continued }: OrchestrationCardProps) {
  const lang = useSettingsStore(s => (s.settings['language'] as 'ru' | 'en') ?? 'ru')
  const hasRunningPhase = progress.some(p => p.status === 'running')
  const isLive = live ?? hasRunningPhase
  const status = overallStatus(progress, runStatus, isLive)

  // Тик 1/с — только пока ран идёт (таймеры фаз + заголовок).
  const [, setTick] = useState(0)
  useEffect(() => {
    if (status !== 'running') return
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [status])
  const now = Date.now()

  // Список короткий (≤ ORCH_PHASES_MAX) — считаем на каждом рендере, без useMemo.
  // Якорь таймера — самый ранний startedAt: он сохраняется и после обрезки
  // списка (capOrchestrationPhases оставляет первую запись), поэтому
  // «Running for …» показывает время всего рана, а не последнего круга.
  const starts = progress.map(p => p.startedAt).filter(n => typeof n === 'number' && n > 0)
  const ends = progress.map(p => p.updatedAt).filter(n => typeof n === 'number' && n > 0)
  const startedAtMs = starts.length ? Math.min(...starts) : now
  const endedAtMs = status === 'running' ? now : (ends.length ? Math.max(...ends) : startedAtMs)
  const elapsedMs = Math.max(0, endedAtMs - startedAtMs)
  // Повтор фазы (второй круг) — отдельная запись: ключ включает startedAt/seq,
  // иначе React переиспользовал бы строку и лента теряла прошлый круг.
  const ordered = progress.slice().sort(compareOrchestrationPhases)

  const [expanded, setExpanded] = useState(isLive)
  // Живая карточка раскрыта; после завершения схлопывается в одну строку —
  // как AgentCard, чтобы завершённый ран не занимал пол-экрана.
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

  if (progress.length === 0) return null

  const phasesDone = progress.filter(p => p.status === 'done').length

  return (
    <div className={`orch-c orch-c--${status}${isLive ? ' orch-c--live' : ''}`} role="group" aria-label="Orchestration progress">
      <div className="orch-c__head">
        <button
          type="button"
          className="orch-c__toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(v => !v)}
        >
          <AgentOrb role={undefined} status={ORB_STATUS[status]} size={18} />
          <span className="orch-c__name">Orchestrator</span>
          <span className="orch-c__dot">·</span>
          <span className="orch-c__count">{phasesDone}/{progress.length} phases</span>
          <span className="orch-c__dot">·</span>
          <span className={`orch-c__status orch-c__status--${status}`}>{statusText(status, elapsedMs)}</span>
          <AppIcon
            name="chevronDown"
            size="xs"
            className={`orch-c__chevron${expanded ? '' : ' orch-c__chevron--closed'}`}
          />
        </button>
        {onContinue && !continued && !isLive && status !== 'done' && (
          <button
            type="button"
            className="orch-c__continue"
            onClick={onContinue}
            title={lang === 'en'
              ? 'Continue this run from where it stopped'
              : 'Продолжить ран с того места, где он остановился'}
          >
            <AppIcon name="refreshCw" size="xs" />
            <span>{lang === 'en' ? 'Continue' : 'Продолжить'}</span>
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            className="orch-c__body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
          >
            <div className="orch-c__body-inner">
              {ordered.map(p => (
                <PhaseRow
                  key={`${p.phase}@${p.startedAt ?? 0}#${(p as OrchestrationProgressEntry).seq ?? 0}`}
                  phase={p}
                  now={now}
                />
              ))}
              {status === 'stopped' && (
                <div className="orch-c__note">Остановлено пользователем — оставшиеся фазы не выполнялись.</div>
              )}
              {status === 'failed' && (
                <div className="orch-c__note orch-c__note--error">Ран завершился ошибкой — прогресс фаз не подтверждён.</div>
              )}
              {status === 'unverified' && (
                <div className="orch-c__note">Ран завершился, но не все фазы подтвердили успех.</div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
})

export default OrchestrationCard
