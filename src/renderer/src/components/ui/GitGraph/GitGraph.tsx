/**
 * Git Graph — отдельное окно с графом всех веток.
 *
 * Раскладку дорожек считает main (src/main/git/graph.ts): здесь только
 * отрисовка. На каждую строку приходят before/after (занятость дорожек сверху
 * и снизу) + mergeLanes/parentLanes, поэтому вертикальные линии всегда
 * стыкуются между строками, даже когда на merge-строке вставляется дорожка.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Copy, GitMerge, Loader2, RefreshCw, X } from 'lucide-react'
import type { GitGraphCommit, GitGraphRefKind } from '../../../../../shared/types/gitGraph'
import './GitGraph.css'

const LANE_W = 13
const ROW_H = 30

/** Палитра дорожек: 8 цветов, дальше по кругу — так соседние ветки различимы. */
const LANE_COLORS = ['#4f9cf9', '#a78bfa', '#f472b6', '#fbbf24', '#34d399', '#fb923c', '#38bdf8', '#c084fc']

const laneColor = (i: number): string => LANE_COLORS[((i % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length]

const REF_LABEL: Record<GitGraphRefKind, string> = {
  head: 'HEAD',
  branch: 'branch',
  remote: 'remote',
  tag: 'tag',
}

function LaneGraph({ row, laneCount }: { row: GitGraphCommit; laneCount: number }) {
  const lanes = Math.max(laneCount, row.lane + 1, row.before.length, row.after.length)
  const width = lanes * LANE_W + 6
  const mid = ROW_H / 2
  const x = (i: number): number => i * LANE_W + LANE_W / 2 + 3
  const parts: React.ReactNode[] = []

  for (let i = 0; i < Math.max(row.before.length, row.after.length); i++) {
    const up = row.before[i]
    const down = row.after[i]
    const involved = i === row.lane || row.mergeLanes.includes(i) || row.parentLanes.includes(i)
    const color = laneColor(i)
    if (up && down && !involved) {
      parts.push(<line key={`v${i}`} x1={x(i)} y1={0} x2={x(i)} y2={ROW_H} stroke={color} strokeWidth={1.6} />)
    } else {
      if (up) parts.push(<line key={`u${i}`} x1={x(i)} y1={0} x2={x(i)} y2={mid} stroke={color} strokeWidth={1.6} />)
      if (down) parts.push(<line key={`d${i}`} x1={x(i)} y1={mid} x2={x(i)} y2={ROW_H} stroke={color} strokeWidth={1.6} />)
    }
  }

  for (const i of row.mergeLanes) {
    parts.push(<line key={`m${i}`} x1={x(i)} y1={mid} x2={x(row.lane)} y2={mid} stroke={laneColor(i)} strokeWidth={1.6} />)
  }
  for (const i of row.parentLanes) {
    parts.push(<line key={`p${i}`} x1={x(row.lane)} y1={mid} x2={x(i)} y2={mid} stroke={laneColor(i)} strokeWidth={1.6} />)
  }

  return (
    <svg className="git-graph-lanes" width={width} height={ROW_H} viewBox={`0 0 ${width} ${ROW_H}`} aria-hidden="true">
      {parts}
      <circle
        cx={x(row.lane)}
        cy={mid}
        r={3.6}
        fill={laneColor(row.lane)}
        stroke="var(--bg-base, #0a0a0f)"
        strokeWidth={1.5}
      />
    </svg>
  )
}

interface GitGraphProps {
  workdir: string
  lang: 'ru' | 'en'
  onClose: () => void
}

export default function GitGraph({ workdir, lang, onClose }: GitGraphProps) {
  const t = (ru: string, en: string): string => (lang === 'en' ? en : ru)

  const [commits, setCommits] = useState<GitGraphCommit[]>([])
  const [maxLanes, setMaxLanes] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [limit, setLimit] = useState(200)
  const [selected, setSelected] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const res = await window.syntee.git.graph({ workdir, limit })
      if (res?.success) {
        setCommits((res.commits ?? []) as GitGraphCommit[])
        setMaxLanes(res.maxLanes ?? 1)
      } else {
        setError(res?.error ?? t('Не удалось загрузить граф', 'Failed to load graph'))
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setLoading(false)
    }
  }, [workdir, limit, lang])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (commits.length > 0 && !commits.some(c => c.hash === selected)) setSelected(commits[0].hash)
  }, [commits, selected])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 14,
  })

  const current = useMemo(() => commits.find(c => c.hash === selected) ?? null, [commits, selected])
  const graphWidth = Math.min(Math.max(maxLanes, 1), 16) * LANE_W + 10

  const copyHash = async (): Promise<void> => {
    if (!current) return
    try {
      await navigator.clipboard.writeText(current.hash)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard недоступен — молча игнорируем */
    }
  }

  return createPortal(
    <motion.div
      className="git-graph-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <motion.div
        className="git-graph-window"
        role="dialog"
        aria-label={t('Граф Git', 'Git Graph')}
        initial={{ opacity: 0, y: 14, scale: 0.975 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 460, damping: 36 }}
      >
        <header className="git-graph-titlebar">
          <GitMerge size={15} />
          <span className="git-graph-title">{t('Граф Git', 'Git Graph')}</span>
          <span className="git-graph-subtitle">{t(`${commits.length} коммитов`, `${commits.length} commits`)}</span>
          <div className="git-graph-titlebar-actions">
            <select
              className="git-graph-limit"
              value={limit}
              onChange={e => setLimit(Number(e.target.value))}
              title={t('Сколько коммитов показать', 'How many commits to load')}
            >
              <option value={100}>100</option>
              <option value={200}>200</option>
              <option value={500}>500</option>
            </select>
            <button className="git-graph-icon-btn" onClick={() => void load()} title={t('Обновить', 'Refresh')}>
              <RefreshCw size={14} className={loading ? 'is-spinning' : undefined} />
            </button>
            <button className="git-graph-icon-btn" onClick={onClose} title={t('Закрыть', 'Close')}>
              <X size={15} />
            </button>
          </div>
        </header>

        <div className="git-graph-header" style={{ gridTemplateColumns: `${graphWidth}px minmax(0, 1fr) 88px 132px 74px` }}>
          <span />
          <span>{t('Описание', 'Description')}</span>
          <span>{t('Дата', 'Date')}</span>
          <span>{t('Автор', 'Author')}</span>
          <span>{t('Коммит', 'Commit')}</span>
        </div>

        <div className="git-graph-scroll" ref={scrollRef}>
          {loading && commits.length === 0 && (
            <div className="git-graph-state">
              <Loader2 size={16} className="is-spinning" />
              <span>{t('Загружаем граф…', 'Loading graph…')}</span>
            </div>
          )}
          {!loading && error && <div className="git-graph-state git-graph-state--error">{error}</div>}
          {!loading && !error && commits.length === 0 && (
            <div className="git-graph-state">{t('Коммитов пока нет', 'No commits yet')}</div>
          )}

          {commits.length > 0 && (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map(item => {
                const row = commits[item.index]
                const isSelected = row.hash === selected
                return (
                  <div
                    key={row.hash}
                    className={`git-graph-row${isSelected ? ' is-selected' : ''}`}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: ROW_H,
                      transform: `translateY(${item.start}px)`,
                      gridTemplateColumns: `${graphWidth}px minmax(0, 1fr) 88px 132px 74px`,
                    }}
                    onClick={() => setSelected(row.hash)}
                  >
                    <div className="git-graph-cell git-graph-cell--graph">
                      <LaneGraph row={row} laneCount={maxLanes} />
                    </div>
                    <div className="git-graph-cell git-graph-cell--subject">
                      {row.refs.map(ref => (
                        <span key={`${row.hash}-${ref.kind}-${ref.name}`} className={`git-graph-ref git-graph-ref--${ref.kind}`} title={REF_LABEL[ref.kind]}>
                          {ref.name}
                        </span>
                      ))}
                      <span className="git-graph-subject" title={row.subject}>{row.subject}</span>
                    </div>
                    <div className="git-graph-cell git-graph-cell--muted">{row.date}</div>
                    <div className="git-graph-cell git-graph-cell--muted" title={row.author}>{row.author}</div>
                    <div className="git-graph-cell git-graph-cell--hash">{row.shortHash}</div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {current && (
          <footer className="git-graph-details">
            <div className="git-graph-details-row">
              <span className="git-graph-details-label">{t('Тема', 'Subject')}</span>
              <span className="git-graph-details-value git-graph-details-value--strong">{current.subject}</span>
            </div>
            <div className="git-graph-details-row">
              <span className="git-graph-details-label">{t('Коммит', 'Commit')}</span>
              <button className="git-graph-details-value git-graph-details-hash" onClick={() => void copyHash()} title={t('Скопировать хеш', 'Copy hash')}>
                <span>{current.hash}</span>
                <Copy size={11} className={copied ? 'git-graph-copy is-copied' : 'git-graph-copy'} />
              </button>
            </div>
            <div className="git-graph-details-row">
              <span className="git-graph-details-label">{t('Автор', 'Author')}</span>
              <span className="git-graph-details-value">{current.author}</span>
            </div>
            <div className="git-graph-details-row">
              <span className="git-graph-details-label">{t('Дата', 'Date')}</span>
              <span className="git-graph-details-value">{current.date}</span>
            </div>
            <div className="git-graph-details-row">
              <span className="git-graph-details-label">{t('Родители', 'Parents')}</span>
              <span className="git-graph-details-value git-graph-details-parents">
                {current.parents.length === 0
                  ? t('нет (корневой коммит)', 'none (root commit)')
                  : current.parents.map(p => (
                      <button key={p} className="git-graph-parent" onClick={() => setSelected(p)}>
                        {p.slice(0, 7)}
                      </button>
                    ))}
              </span>
            </div>
          </footer>
        )}
      </motion.div>
    </motion.div>,
    document.body,
  )
}
