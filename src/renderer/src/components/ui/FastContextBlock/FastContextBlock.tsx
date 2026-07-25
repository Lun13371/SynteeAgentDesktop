import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, ChevronRight, Compass, FileCode, Clock, Layers, Check, Loader2, Sparkles } from 'lucide-react'
import './FastContextBlock.css'

export interface FastContextFile {
  path: string
  lineRanges: string
  why: string
}

export interface FastContextResultData {
  files: FastContextFile[]
  summary: string
  ms: number
  indexedFilesCount: number
  fallback?: boolean
}

interface Props {
  result: FastContextResultData
  /** Live progress {stage, detail} если тул ещё выполняется (из ChatLiveState.toolProgress). */
  liveProgress?: { stage: string; detail?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }> }
  onOpenFile?: (path: string, lineRange?: string) => void
}

const STAGES = [
  { id: 'indexing', label: 'Индексация', icon: Layers },
  { id: 'retrieving', label: 'Поиск', icon: Compass },
  { id: 'summarizing', label: 'Анализ LLM', icon: Sparkles },
  { id: 'done', label: 'Готово', icon: Check },
]

function stageIndex(stage: string): number {
  const i = STAGES.findIndex(s => s.id === stage)
  return i === -1 ? 0 : i
}

function shortPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/')
  if (parts.length <= 3) return p
  return '…/' + parts.slice(-2).join('/')
}

export default function FastContextBlock({ result, liveProgress, onOpenFile }: Props) {
  const [expanded, setExpanded] = useState(true)
  const [expandedFiles, setExpandedFiles] = useState<Set<number>>(new Set())
  const [showSummary, setShowSummary] = useState(true)

  const activeStage = liveProgress?.stage
  const activeIdx = activeStage ? stageIndex(activeStage) : 3
  const isLive = activeStage && activeStage !== 'done'

  // Live files from retrieving stage
  const liveFiles = (isLive && liveProgress?.filesFound) || []

  const toggleFile = (i: number) => {
    setExpandedFiles(prev => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const formatMs = (ms: number) => {
    if (ms < 1000) return `${ms}мс`
    return `${(ms / 1000).toFixed(1)}с`
  }

  // Auto-expand when live starts, auto-collapse when done
  const wasLiveRef = useRef(false)
  useEffect(() => {
    if (isLive) {
      wasLiveRef.current = true
      setExpanded(true)
    } else if (wasLiveRef.current && !isLive) {
      // Live закончился → auto-collapse через 1.5с
      const t = setTimeout(() => setExpanded(false), 1500)
      return () => clearTimeout(t)
    }
  }, [isLive])

  return (
    <div className={`fcb-wrap${isLive ? ' fcb-wrap--live' : ''}`}>
      {/* Header */}
      <div className="fcb-header" onClick={() => setExpanded(!expanded)}>
        <div className="fcb-header-left">
          <Compass size={14} className={`fcb-icon${isLive ? ' fcb-icon--spin' : ''}`} />
          <span className="fcb-title">Быстрый контекст проекта</span>
          {result.fallback && <span className="fcb-fallback-badge">fallback</span>}
        </div>
        <div className="fcb-header-right">
          {!isLive && (
            <span className="fcb-meta">
              <Clock size={11} />
              {formatMs(result.ms)} · {result.files.length} файлов
            </span>
          )}
          {!isLive && !expanded && result.files.length > 0 && (
            <span className="fcb-compact-files">
              {result.files.slice(0, 3).map(f => shortPath(f.path)).join(', ')}
              {result.files.length > 3 && ` +${result.files.length - 3}`}
            </span>
          )}
          <button className="fcb-chevron" onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}>
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            className="fcb-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          >
            {/* Stages timeline */}
            <div className="fcb-stages">
              {STAGES.map((stage, i) => {
                const StageIcon = stage.icon
                const isDone = !isLive || i < activeIdx
                const isActive = isLive && i === activeIdx
                const isPending = isLive && i > activeIdx
                return (
                  <motion.div
                    key={stage.id}
                    className={`fcb-stage ${isDone ? 'done' : ''} ${isActive ? 'active' : ''} ${isPending ? 'pending' : ''}`}
                    initial={false}
                    animate={{ scale: 1 }}
                    transition={{ duration: 0.15 }}
                  >
                    <div className="fcb-stage-dot">
                      {isDone && <Check size={11} className="fcb-stage-check" />}
                      {isActive && <span className="fcb-stage-pulse" />}
                    </div>
                    {isActive ? (
                      <Loader2 size={11} className="fcb-stage-icon fcb-stage-icon--spin" />
                    ) : (
                      <StageIcon size={11} className="fcb-stage-icon" />
                    )}
                    <span className="fcb-stage-label">{stage.label}</span>
                    {isActive && liveProgress?.detail && (
                      <span className="fcb-stage-detail">{liveProgress.detail}</span>
                    )}
                    {isActive && liveProgress?.filesTotal != null && liveProgress.filesTotal > 0 && (
                      <span className="fcb-stage-progress">
                        {liveProgress.filesProcessed ?? 0}/{liveProgress.filesTotal}
                      </span>
                    )}
                  </motion.div>
                )
              })}
            </div>

            {/* Progress bar during live */}
            {isLive && (
              <div className="fcb-progress-bar">
                <motion.div
                  className="fcb-progress-fill"
                  initial={{ width: `${(activeIdx / STAGES.length) * 100}%` }}
                  animate={{ width: `${((activeIdx + 1) / STAGES.length) * 100}%` }}
                  transition={{ type: 'spring', stiffness: 200, damping: 30 }}
                />
              </div>
            )}

            {/* Live file chips during retrieving */}
            {isLive && liveFiles.length > 0 && (
              <div className="fcb-live-chips">
                <div className="fcb-live-chips-label">Найденные файлы:</div>
                <div className="fcb-chips-row">
                  <AnimatePresence>
                    {liveFiles.map((f, i) => (
                      <motion.div
                        key={f.path}
                        className="fcb-chip"
                        initial={{ opacity: 0, x: -12, scale: 0.85 }}
                        animate={{ opacity: 1, x: 0, scale: 1 }}
                        transition={{
                          delay: i * 0.06,
                          type: 'spring',
                          stiffness: 500,
                          damping: 22,
                        }}
                        title={f.path}
                      >
                        <FileCode size={10} />
                        <span>{shortPath(f.path)}</span>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            )}

            {/* Shimmer during summarizing */}
            {isLive && activeStage === 'summarizing' && (
              <div className="fcb-shimmer-wrap">
                <div className="fcb-shimmer-line" />
                <div className="fcb-shimmer-line fcb-shimmer-line--short" />
                <div className="fcb-shimmer-line" />
              </div>
            )}

            {/* Summary (final) */}
            {result.summary && !isLive && (
              <div className="fcb-summary-wrap">
                <button
                  className="fcb-summary-toggle"
                  onClick={() => setShowSummary(!showSummary)}
                >
                  <ChevronRight size={11} className={showSummary ? 'rotated' : ''} />
                  <span>Summary</span>
                </button>
                {showSummary && (
                  <motion.p
                    className="fcb-summary"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                  >
                    {result.summary}
                  </motion.p>
                )}
              </div>
            )}

            {/* Files list (final) */}
            {result.files.length > 0 && !isLive && (
              <div className="fcb-files">
                <div className="fcb-files-header">
                  Найдено файлов: {result.files.length}
                </div>
                {result.files.map((file, i) => {
                  const isExpanded = expandedFiles.has(i)
                  return (
                    <motion.div
                      key={i}
                      className="fcb-file-row"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.04, type: 'spring', stiffness: 400, damping: 28 }}
                    >
                      <div className="fcb-file-head" onClick={() => toggleFile(i)}>
                        <ChevronRight size={11} className={`fcb-file-chevron ${isExpanded ? 'rotated' : ''}`} />
                        <FileCode size={12} className="fcb-file-icon" />
                        <button
                          className="fcb-file-path"
                          onClick={(e) => {
                            e.stopPropagation()
                            onOpenFile?.(file.path, file.lineRanges)
                          }}
                          title={file.path}
                        >
                          {file.path}
                        </button>
                        {file.lineRanges && (
                          <span className="fcb-file-lines">L{file.lineRanges}</span>
                        )}
                      </div>
                      {isExpanded && file.why && (
                        <motion.div
                          className="fcb-file-why"
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                        >
                          {file.why}
                        </motion.div>
                      )}
                    </motion.div>
                  )
                })}
              </div>
            )}

            {/* Empty state */}
            {!isLive && result.files.length === 0 && !result.fallback && (
              <div className="fcb-empty">
                Ничего не найдено по запросу. Возможно стоит уточнить или использовать read_file/search_code.
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
