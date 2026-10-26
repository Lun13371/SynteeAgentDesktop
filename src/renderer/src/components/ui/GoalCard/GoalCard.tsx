import { useRef, useState, useId, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import type { ChatGoal, GoalStatus } from '../../../../../shared/types/goal'

/**
 * Карточка цели (`/goal`) — семантика Claude Code: одно УСЛОВИЕ завершения,
 * вердикты независимого оценщика (ходы/токены/последняя причина), управление
 * паузой и снятием. Критерии/ограничения старой версии больше не задаются
 * руками — вместо них работает оценщик (см. goalEvaluator.ts).
 */
type GoalEdit = Pick<ChatGoal, 'objective' | 'maxSteps'>
const statuses: Record<GoalStatus, string> = {
  running: 'В работе', paused: 'На паузе', blocked: 'Невыполнима', completed: 'Достигнута',
  unverified: 'Без вердикта', stopped: 'Снята', limit: 'Лимит раундов',
}
const MAX_CONDITION_CHARS = 4000
const RESUMABLE: GoalStatus[] = ['running', 'paused', 'unverified', 'limit']

function formatDuration(from: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - from) / 60_000))
  if (minutes < 1) return 'меньше минуты'
  if (minutes < 60) return `${minutes} мин`
  return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`
}

function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)
}

export default function GoalCard({ goal, running, onCommand, onSave }: {
  goal: ChatGoal; running: boolean
  onCommand: (command: string) => Promise<void>
  onSave: (patch: GoalEdit) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [objective, setObjective] = useState('')
  const [maxSteps, setMaxSteps] = useState(goal.maxSteps)
  const dialogRef = useRef<HTMLDivElement>(null)
  const editRef = useRef<HTMLButtonElement>(null)
  const busyRef = useRef(busy)
  useEffect(() => { busyRef.current = busy }, [busy])
  const titleId = useId()
  const reduceMotion = useReducedMotion()
  useEffect(() => {
    if (!editing) return
    const dialog = dialogRef.current
    dialog?.querySelector<HTMLElement>('textarea')?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!busyRef.current) setEditing(false)
      } else if (event.key === 'Tab') {
        const elements = Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)') ?? [])
        const first = elements[0]
        const last = elements.at(-1)
        if (!first) { event.preventDefault(); dialog?.focus(); return }
        if (!dialog?.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
          event.preventDefault()
          ;(event.shiftKey ? last : first)?.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKey, true)
    return () => document.removeEventListener('keydown', handleKey, true)
  }, [editing])
  const execute = async (command: string) => {
    setBusy(true); setError('')
    try { await onCommand(command) } catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }
  const canResume = !running && RESUMABLE.includes(goal.status)
  const active = goal.status === 'running' || goal.status === 'paused'
  const verdicts = goal.evidence
  return <section className={`chat-goal-banner${expanded ? ' is-expanded' : ''}`} aria-label="Цель чата">
    <div className="goal-heading">
      <AppIcon name="compass" size="xs" tone="accent" aria-hidden="true" />
      <strong title={goal.objective}>{goal.objective}</strong>
      <span role="status">{statuses[goal.status]} · ходов {goal.turnsEvaluated}</span>
      <AnimatePresence initial={false} mode="popLayout">
        {expanded && <motion.div className="goal-controls" initial={{ opacity: 0, scale: 0.94, x: 8 }} animate={{ opacity: 1, scale: 1, x: 0 }} exit={{ opacity: 0, scale: 0.94, x: 8 }} transition={{ type: 'spring', stiffness: 440, damping: 28 }}>
            {running
              ? <button disabled={busy} onClick={() => void execute('/goal-pause')}>Пауза</button>
              : <button disabled={busy || !canResume} onClick={() => void execute('/goal-resume')}>Продолжить</button>}
            <button ref={editRef} disabled={busy || running} onClick={() => {
              setObjective(goal.objective); setMaxSteps(goal.maxSteps); setError(''); setEditing(true)
            }}>Изменить</button>
            <button disabled={busy} onClick={() => void execute('/goal-stop')}>Снять</button>
          </motion.div>}
      </AnimatePresence>
      <motion.button type="button" className="goal-expand-toggle" aria-expanded={expanded} aria-controls="goal-details" aria-label={expanded ? 'Свернуть цель' : 'Развернуть цель'} onClick={() => setExpanded(value => !value)} whileHover={reduceMotion ? undefined : { scale: 1.1 }} whileTap={reduceMotion ? undefined : { scale: 0.9 }}>
        <motion.span className="goal-chevron" aria-hidden="true" animate={{ rotate: expanded ? 180 : 0 }} transition={{ type: 'spring', stiffness: 500, damping: 25 }}>
          <AppIcon name="chevronDown" size="md" tone="accent" strokeWidth={2.4} />
        </motion.span>
      </motion.button>
    </div>
    <AnimatePresence initial={false} mode="wait">
      {!expanded && goal.lastReason && <motion.p className="goal-compact-progress" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: reduceMotion ? 0 : 0.16 }}><b>Вердикт:</b> {goal.lastReason}</motion.p>}
      {expanded && <motion.div id="goal-details" className="goal-expanded-content" initial={reduceMotion ? false : { opacity: 0, height: 0, y: -6 }} animate={{ opacity: 1, height: 'auto', y: 0 }} exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, y: -6 }} transition={{ height: { type: 'spring', stiffness: 420, damping: 34 }, opacity: { duration: 0.16 }, y: { duration: 0.2 } }}>
      <p className="goal-stats">
        {active ? <>Идёт: <b>{formatDuration(goal.startedAt)}</b> · </> : null}
        Ходов оценено: <b>{goal.turnsEvaluated}</b> · ~<b>{formatTokens(goal.tokensSpent)}</b> токенов
        {goal.maxSteps > 0 ? <> · раундов: <b>{goal.steps}/{goal.maxSteps}</b></> : <> · раундов: <b>{goal.steps}</b> (без лимита)</>}
      </p>
      {goal.lastReason && <p><b>Последний вердикт:</b> {goal.lastReason}</p>}
      {goal.blocker && <p className="goal-blocker"><b>Причина:</b> {goal.blocker}</p>}
      <details open><summary>Условие · {verdicts.length} вердиктов · {goal.progress.length} записей прогресса</summary>
        <motion.div initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: reduceMotion ? 0 : 0.08 }}>
          <b>Условие завершения</b><p className="goal-condition">{goal.objective}</p>
          <small>Вердикт выносит отдельная быстрая модель по транскрипту после каждого хода: условие либо держится, либо нет. Слова агента о готовности доказательством не считаются — проверка должна быть видна в переписке.</small>
          {verdicts.length > 0 && <><b>Вердикты оценщика</b><ul>{verdicts.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
          {goal.progress.length > 0 && <><b>Прогресс</b><ul>{goal.progress.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
        </motion.div>
      </details>
      </motion.div>}
    </AnimatePresence>
    {error && !editing && <p role="alert">{error}</p>}
    {createPortal(<AnimatePresence onExitComplete={() => editRef.current?.focus()}>
      {editing && <motion.div className="goal-edit-backdrop" role="presentation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.18 }} onMouseDown={event => { if (event.target === event.currentTarget && !busy) setEditing(false) }}>
        <motion.div ref={dialogRef} className="goal-edit-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
          initial={reduceMotion ? false : { opacity: 0, y: 18, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduceMotion ? { opacity: 1 } : { opacity: 0, y: 12, scale: 0.98 }} transition={{ type: 'spring', stiffness: 380, damping: 30 }}>
      <form onSubmit={async event => {
        event.preventDefault()
        const condition = objective.trim()
        if (!condition || condition.length > MAX_CONDITION_CHARS || !Number.isInteger(maxSteps) || maxSteps < 0 || maxSteps > 500) {
          setError(`Условие обязательно (до ${MAX_CONDITION_CHARS} символов); лимит раундов — целое 0…500 (0 = без лимита)`); return
        }
        setBusy(true); setError('')
        try { await onSave({ objective: condition, maxSteps }); setEditing(false) }
        catch (e) { setError(String(e)) } finally { setBusy(false) }
      }}>
        <h3 id={titleId}>Условие цели</h3>
        <label>Условие завершения<textarea autoFocus required maxLength={MAX_CONDITION_CHARS} rows={4} value={objective} disabled={busy} onChange={e => setObjective(e.target.value)} /></label>
        <p>Пиши проверяемое условие — такое, которое видно в переписке: «npm test выходит с кодом 0», «в CHANGELOG.md есть запись для каждого PR», «git status чист». Проверяет его отдельная модель после каждого хода. Границы задаются клаузой в самом условии («…или остановись после 20 ходов»).</p>
        <label>Максимум раундов (0 — без лимита)<input type="number" min={0} max={500} step={1} required value={maxSteps} disabled={busy} onChange={e => setMaxSteps(Number(e.target.value))} /></label>
        {error && <p role="alert">{error}</p>}
        <div className="goal-controls"><button type="button" disabled={busy} onClick={() => setEditing(false)}>Отмена</button><button type="submit" disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить'}</button></div>
        </form>
        </motion.div>
      </motion.div>}
    </AnimatePresence>, document.body)}
  </section>
}