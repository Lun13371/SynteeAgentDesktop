// ── DotCard: карточка Dot'а в списке (стиль сайдбара) ─────────────────────
import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import AppIcon from '../../components/ui/AppIcon/AppIcon'
import { useDotsStore } from '../../store/dots.store'
import type { Dot } from '../../../../shared/types'
import { DotBlob } from './DotBlob'

function fmtNext(ts?: number): string {
  if (!ts) return ''
  const diff = ts - Date.now()
  if (diff <= 0) return 'сейчас'
  const min = Math.round(diff / 60_000)
  if (min < 60) return `через ${min} мин`
  const h = Math.floor(min / 60)
  if (h < 24) return `через ${h} ч`
  return `через ${Math.floor(h / 24)} д`
}

function fmtLast(ts?: number): string {
  if (!ts) return 'ещё не просыпался'
  const diff = Date.now() - ts
  const min = Math.round(diff / 60_000)
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин назад`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} ч назад`
  return `${Math.floor(h / 24)} д назад`
}

/** Иконка статуса Dot'а. */
function StatusIcon({ status }: { status: Dot['state']['status'] }) {
  if (status === 'running') return <AppIcon name="zap" size="xs" tone="accent" />
  if (status === 'error') return <AppIcon name="alertTriangle" size="xs" tone="danger" />
  if (status === 'disabled') return <AppIcon name="power" size="xs" tone="muted" />
  return <AppIcon name="moonStar" size="xs" tone="muted" />
}

export function DotCard({
  dot,
  selected,
  onSelect,
  onWake,
  onEdit,
  onDelete,
}: {
  dot: Dot
  selected: boolean
  onSelect: () => void
  onWake: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const s = dot.state
  const [confirmDelete, setConfirmDelete] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Эффективная модель: персональная → глобальная Dots → основная (main).
  const dotsSettings = useDotsStore(s => s.settings)
  const modelId = dot.modelId ?? dotsSettings?.modelId ?? ''
  const modelTitle = dot.modelId
    ? `Персональная модель: ${dot.modelId}`
    : dotsSettings?.modelId
      ? `Модель Dots: ${dotsSettings.modelId}`
      : 'Основная модель чата (main)'

  // Автосброс подтверждения удаления через 3с
  useEffect(() => {
    if (confirmDelete) {
      confirmTimer.current = setTimeout(() => setConfirmDelete(false), 3000)
    }
    return () => { if (confirmTimer.current) clearTimeout(confirmTimer.current) }
  }, [confirmDelete])

  const statusText =
    s.status === 'running' ? 'работает'
    : s.status === 'error' ? 'ошибка'
    : s.status === 'disabled' ? 'выключен'
    : s.nextRunAt ? `спит · ${fmtNext(s.nextRunAt)}`
    : 'спит'

  const metaText = s.status !== 'running' && s.lastRunAt ? ` · ${fmtLast(s.lastRunAt)}` : ''

  return (
    <motion.div
      className={[
        'dot-card',
        selected ? 'dot-card--selected' : '',
        !dot.enabled ? 'dot-card--disabled' : '',
      ].filter(Boolean).join(' ')}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter') onSelect() }}
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.18 }}
    >
      <DotBlob color={dot.color} icon={dot.icon} status={s.status} />
      <div className="dot-card-info">
        <div className="dot-card-name">{dot.name}</div>
        <div
          className={[
            'dot-card-meta',
            s.status === 'running' ? 'dot-card-meta--running' : '',
            s.status === 'error' ? 'dot-card-meta--error' : '',
          ].filter(Boolean).join(' ')}
        >
          <StatusIcon status={s.status} />
          <span>{statusText}{metaText}</span>
          <span className="dot-card-model" title={modelTitle}>{modelId || 'осн.'}</span>
        </div>
      </div>
      <div className="dot-card-actions" onClick={e => e.stopPropagation()}>
        <button
          type="button"
          className="dot-card-action"
          title={s.status === 'running' ? 'Dot уже работает' : 'Разбудить сейчас'}
          disabled={s.status === 'running' || !dot.enabled}
          onClick={onWake}
        >
          <AppIcon name="zap" size="xs" />
        </button>
        <button type="button" className="dot-card-action" title="Настроить" onClick={onEdit}>
          <AppIcon name="settings" size="xs" />
        </button>
        {confirmDelete ? (
          <button
            type="button"
            className="dot-card-action dot-card-action--confirm"
            title="Точно удалить"
            onClick={() => { setConfirmDelete(false); onDelete() }}
          >
            <AppIcon name="check" size="xs" />
          </button>
        ) : (
          <button
            type="button"
            className="dot-card-action dot-card-action--danger"
            title="Удалить Dot’а"
            onClick={() => setConfirmDelete(true)}
          >
            <AppIcon name="trash" size="xs" />
          </button>
        )}
      </div>
    </motion.div>
  )
}
