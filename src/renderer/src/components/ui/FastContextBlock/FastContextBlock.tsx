import { useState, useEffect, useRef, memo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Compass, FileCode, Clock, Check, Loader2, Sparkles, Database, FileSearch } from 'lucide-react'
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
  liveProgress?: { stage: string; detail?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }> }
  onOpenFile?: (path: string, lineRange?: string) => void
}

const STAGES = [
  { id: 'indexing', label: 'Индексация', icon: Database },
  { id: 'retrieving', label: 'Поиск', icon: FileSearch },
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

const FastContextBlock = memo(function FastContextBlock({ result, liveProgress, onOpenFile }: Props) {
  const [expanded, setExpanded] = useState(true)
  const [expandedFiles, setExpandedFiles] = useState<Set<number>>(new Set())
  const [showSummary, setShowSummary] = useState(true)

  const activeStage = liveProgress?.stage
  const activeIdx = activeStage ? stageIndex(activeStage) : 3
  const isLive = !!activeStage && activeStage !== 'done'

  // Сохраняем filesFound — они приходят во время retrieving, но должны
  // показываться и во время summarizing (иначе пропадают)
  const savedFilesRef = useRef<Array<{ path: string; score: number; why: string }>>([])
  if (isLive && liveProgress?.filesFound && liveProgress.filesFound.length > 0) {
    savedFilesRef.current = liveProgress.filesFound
  }
  if (!isLive) savedFilesRef.current = []
  const liveFiles = isLive ? savedFilesRef.current : []

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

  const wasLiveRef = useRef(false)
  useEffect(() => {
    if (isLive) {
      wasLiveRef.current = true
      setExpanded(true)
    } else if (wasLiveRef.current && !isLive) {
      const t = setTimeout(() => setExpanded(false), 1500)
      return () => clearTimeout(t)
    }
  }, [isLive])

  return (
    <div className={`fcb-wrap${isLive ? ' fcb-wrap--live' : ''}`}>
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
            {expanded ? <ChevronDown size={14} /> : <ChevronDown size={14} style={{ transform: 'rotate(-90deg)' }} />}
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
            transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }}
          >
            {/* Stages timeline */}
            <div className="fcb-stages">
              {STAGES.map((stage, i) => {
                const StageIcon = stage.icon
                const isDone = !isLive || i < activeIdx
                const isActive = isLive && i === activeIdx
                return (
                  <div key={stage.id} style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                    <div className={`fcb-stage ${isDone ? 'done' : ''} ${isActive ? 'active' : ''}`}>
                      <div className="fcb-stage-dot">
                        {isDone ? (
                          <Check size={10} className="fcb-stage-check" />
                        ) : isActive ? (
                          <Loader2 size={10} className="fcb-stage-icon--spin" />
                        ) : (
                          <StageIcon size={10} className="fcb-stage-icon" />
                        )}
                      </div>
                      <span className="fcb-stage-label">{stage.label}</span>
                      {isActive && liveProgress?.detail && (
                        <span className="fcb-stage-detail">{liveProgress.detail}</span>
                      )}
                      {isActive && liveProgress?.filesTotal != null && liveProgress.filesTotal > 0 && (
                        <span className="fcb-stage-progress">
                          {liveProgress.filesProcessed ?? 0}/{liveProgress.filesTotal}
                        </span>
                      )}
                    </div>
                    {i < STAGES.length - 1 && <span className="fcb-stage-arrow">›</span>}
                  </div>
                )
              })}
            </div>

            {/* Progress bar — плавный fill */}
            <AnimatePresence>
              {isLive && (
                <motion.div
                  className="fcb-progress-bar"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 2 }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.3 }}
                >
                  <motion.div
                    className="fcb-progress-fill"
                    initial={{ width: `${(activeIdx / STAGES.length) * 100}%` }}
                    animate={{ width: `${((activeIdx + 1) / STAGES.length) * 100}%` }}
                    transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
                  />
                </motion.div>
              )}
            </AnimatePresence>

            {/* Live file chips — плавное появление */}
            <AnimatePresence>
              {isLive && liveFiles.length > 0 && (
                <motion.div
                  className="fcb-live-chips"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.3 }}
                >
                  <div className="fcb-live-chips-label">
                    {activeStage === 'summarizing' ? 'LLM анализирует:' : 'Найденные файлы:'}
                  </div>
                  <div className="fcb-chips-row">
                    <AnimatePresence>
                      {liveFiles.map((f, i) => (
                        <motion.div
                          key={f.path}
                          className="fcb-chip"
                          initial={{ opacity: 0, y: 6, scale: 0.9 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.9 }}
                          transition={{
                            delay: i * 0.05,
                            duration: 0.3,
                            type: 'spring',
                            stiffness: 400,
                            damping: 25,
                          }}
                          title={f.path}
                        >
                          <FileCode size={10} />
                          <span>{shortPath(f.path)}</span>
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Shimmer during summarizing — плавный */}
            <AnimatePresence>
              {isLive && activeStage === 'summarizing' && (
                <motion.div
                  className="fcb-shimmer-wrap"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.4 }}
                >
                  <div className="fcb-shimmer-line" />
                  <div className="fcb-shimmer-line fcb-shimmer-line--short" />
                  <div className="fcb-shimmer-line" />
                </motion.div>
              )}
            </AnimatePresence>

            {/* Summary — плавное появление */}
            <AnimatePresence>
              {result.summary && !isLive && (
                <motion.div
                  className="fcb-summary-wrap"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.4, delay: 0.1 }}
                >
                  <button
                    className="fcb-summary-toggle"
                    onClick={() => setShowSummary(!showSummary)}
                  >
                    <ChevronDown size={11} style={{ transform: showSummary ? '' : 'rotate(-90deg)', transition: 'transform 0.2s' }} />
                    <span>Summary</span>
                  </button>
                  <AnimatePresence initial={false}>
                    {showSummary && (
                      <motion.p
                        className="fcb-summary"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                      >
                        {result.summary}
                      </motion.p>
                    )}
                  </AnimatePresence>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Files list — плавное появление */}
            <AnimatePresence>
              {result.files.length > 0 && !isLive && (
                <motion.div
                  className="fcb-files"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.4, delay: 0.15 }}
                >
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
                        transition={{ delay: i * 0.03, duration: 0.25 }}
                      >
                        <div className="fcb-file-head" onClick={() => toggleFile(i)}>
                          <ChevronDown size={11} className={`fcb-file-chevron ${isExpanded ? '' : 'fcb-file-chevron--closed'}`} />
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
                        <AnimatePresence initial={false}>
                          {isExpanded && file.why && (
                            <motion.div
                              className="fcb-file-why"
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                            >
                              {file.why}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    )
                  })}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Empty state */}
            <AnimatePresence>
              {!isLive && result.files.length === 0 && !result.fallback && (
                <motion.div
                  className="fcb-empty"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.4 }}
                >
                  Ничего не найдено по запросу. Возможно стоит уточнить или использовать read_file/search_code.
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
})

export default FastContextBlock
