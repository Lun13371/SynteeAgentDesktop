import { useState, useEffect, useRef, memo } from 'react'
import { ChevronDown, Compass, Clock, Check, Loader2, Sparkles, Database, FileSearch, FolderOpen } from 'lucide-react'
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
  snippets?: Array<{ path: string; lineRanges: string; code: string }>
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

function baseName(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const slash = norm.lastIndexOf('/')
  return slash === -1 ? norm : norm.slice(slash + 1)
}

function dirName(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const slash = norm.lastIndexOf('/')
  return slash === -1 ? '' : norm.slice(0, slash)
}

/** Короткий вид папки: последние 2 сегмента (полный путь — в title). */
function shortDir(dir: string): string {
  const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length === 0) return '/'
  if (parts.length <= 2) return parts.join('/')
  return '…/' + parts.slice(-2).join('/')
}

interface DirGroup {
  dir: string
  items: Array<{ file: FastContextFile; index: number }>
}

/** Группировка по папке — вместо плоского списка из 15 полных путей. */
function groupByDir(files: FastContextFile[]): DirGroup[] {
  const map = new Map<string, DirGroup>()
  files.forEach((file, index) => {
    const dir = dirName(file.path)
    const existing = map.get(dir)
    if (existing) existing.items.push({ file, index })
    else map.set(dir, { dir, items: [{ file, index }] })
  })
  return Array.from(map.values())
}

const FastContextBlock = memo(function FastContextBlock({ result, liveProgress, onOpenFile }: Props) {
  const [expanded, setExpanded] = useState(true)
  const [expandedFiles, setExpandedFiles] = useState<Set<number>>(new Set())
  const [showFiles, setShowFiles] = useState(false)

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
      return undefined
    }
    if (wasLiveRef.current) {
      const t = setTimeout(() => setExpanded(false), 1500)
      return () => clearTimeout(t)
    }
    return undefined
  }, [isLive])

  const groups = !isLive && result.files.length > 0 ? groupByDir(result.files) : []

  return (
    <div className={`fcb-wrap${isLive ? ' fcb-wrap--live' : ''}${expanded ? ' fcb-wrap--open' : ''}`}>
      <div className="fcb-header" onClick={() => setExpanded(!expanded)}>
        <Compass size={14} className={`fcb-icon${isLive ? ' fcb-icon--spin' : ''}`} />
        <span className="fcb-title">Быстрый контекст проекта</span>
        {result.fallback && <span className="fcb-fallback-badge">fallback</span>}
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
            <ChevronDown size={14} className={expanded ? '' : 'fcb-chevron--closed'} />
          </button>
        </div>
      </div>

      {/* Body: CSS grid 0fr→1fr вместо framer-motion height:auto */}
      <div className={`fcb-body-wrap${expanded ? ' fcb-body-wrap--open' : ''}`}>
        <div className="fcb-body">
          {/* Stages timeline — только во время работы: после завершения
              все этапы done и строка занимает место зря (мета в шапке уже
              показывает время и число файлов). */}
          {isLive && (
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
          )}

          {/* Progress bar — CSS opacity transition */}
          {isLive && (
            <div className="fcb-progress-bar">
              <div
                className="fcb-progress-fill"
                style={{ width: `${((activeIdx + 1) / STAGES.length) * 100}%` }}
              />
            </div>
          )}

          {/* Live file chips */}
          {isLive && liveFiles.length > 0 && (
            <div className="fcb-live-chips">
              <div className="fcb-live-chips-label">
                {activeStage === 'summarizing' ? 'LLM анализирует:' : 'Найденные файлы:'}
              </div>
              <div className="fcb-chips-row">
                {liveFiles.map((f, i) => (
                  <div
                    key={f.path}
                    className="fcb-chip fcb-chip--enter"
                    style={{ '--fcb-i': i } as React.CSSProperties}
                    title={f.path}
                  >
                    <span>{shortPath(f.path)}</span>
                  </div>
                ))}
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

          {/* Сводка — основной текст ответа. Это то, что пользователь читает;
              список файлов ниже спрятан под раскрывашку, чтобы плашка не
              занимала пол-экрана. */}
          {result.summary && !isLive && (
            <p className="fcb-summary">{result.summary}</p>
          )}

          {/* Файлы: компактная кнопка-раскрывашка + группы по папкам.
              Плоский список из 15 полных путей заменён на «папка → имена». */}
          {groups.length > 0 && (
            <div className="fcb-files">
              <button
                className={`fcb-files-toggle${showFiles ? ' fcb-files-toggle--open' : ''}`}
                onClick={() => setShowFiles(!showFiles)}
              >
                <ChevronDown size={11} className="fcb-files-toggle-chevron" />
                <span>{result.files.length} файлов</span>
              </button>
              {showFiles && (
                <div className="fcb-file-list">
                  {groups.map(group => (
                    <div key={group.dir} className="fcb-dir-group">
                      <div className="fcb-dir-head" title={group.dir || '/'}>
                        <FolderOpen size={11} className="fcb-dir-icon" />
                        <span className="fcb-dir-path">{shortDir(group.dir)}</span>
                        <span className="fcb-dir-count">{group.items.length}</span>
                      </div>
                      {group.items.map(({ file, index }) => {
                        const isExpandedFile = expandedFiles.has(index)
                        return (
                          <div
                            key={index}
                            className="fcb-file-row fcb-file-row--enter"
                            style={{ '--fcb-i': index } as React.CSSProperties}
                          >
                            <div className="fcb-file-head" onClick={() => toggleFile(index)}>
                              <ChevronDown size={11} className={`fcb-file-chevron ${isExpandedFile ? '' : 'fcb-file-chevron--closed'}`} />
                              <button
                                className="fcb-file-path"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  onOpenFile?.(file.path, file.lineRanges)
                                }}
                                title={file.path}
                              >
                                {baseName(file.path)}
                              </button>
                              {file.lineRanges && (
                                <span className="fcb-file-lines">L{file.lineRanges}</span>
                              )}
                            </div>
                            {isExpandedFile && file.why && (
                              <div className="fcb-file-why">{file.why}</div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Empty state */}
          {!isLive && result.files.length === 0 && !result.fallback && (
            <div className="fcb-empty">
              Ничего не найдено по запросу. Возможно стоит уточнить или использовать read_file/search_code.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}, (prev, next) =>
  prev.result === next.result &&
  prev.liveProgress === next.liveProgress &&
  prev.onOpenFile === next.onOpenFile
)

export default FastContextBlock
