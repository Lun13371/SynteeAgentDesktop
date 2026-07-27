import { useState, useEffect, useRef, memo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Paperclip, FileText, Image as ImageIcon, Clock, Check, Loader2, AlertCircle, FileWarning } from 'lucide-react'
import type { AttachmentProcessingResult, AttachmentProcessingFile } from '../../../../../shared/types'
import './AttachmentProcessingBlock.css'

interface Props {
  /** Сохранённый результат (из message.attachmentResult) — для отображения
   *  после рестарта. Если только live — передать пустой результат. */
  result: AttachmentProcessingResult
  /** Live-прогресс из toolProgress['process_attachments']. Когда stage !==
   *  'done' — блок в live-режиме (показывает stages + спиннер + прогресс-бар). */
  liveProgress?: {
    stage: string
    detail?: string
    filesProcessed?: number
    filesTotal?: number
    ts: number
  }
}

// Стадии обработки — показываются как roadmap в live-режиме.
// index → retrieving/summarizing в FastContext; тут свои:
//   start → processing → analyzing_image → done
const STAGES = [
  { id: 'start', label: 'Старт', icon: Paperclip },
  { id: 'processing', label: 'Чтение файлов', icon: FileText },
  { id: 'analyzing_image', label: 'Анализ изображений', icon: ImageIcon },
  { id: 'done', label: 'Готово', icon: Check },
]

function stageIndex(stage: string): number {
  const i = STAGES.findIndex(s => s.id === stage)
  return i === -1 ? 0 : i
}

// Иконка статуса файла для финального списка
function FileStatusIcon({ status }: { status: AttachmentProcessingFile['status'] }): JSX.Element {
  if (status === 'text_inlined') return <FileText size={12} />
  if (status === 'image_described') return <ImageIcon size={12} />
  if (status === 'binary_path') return <FileText size={12} />
  if (status === 'error') return <AlertCircle size={12} />
  return <FileWarning size={12} />
}

function statusLabel(status: AttachmentProcessingFile['status']): string {
  switch (status) {
    case 'text_inlined': return 'Содержимое инлайнено'
    case 'image_described': return 'Описание от vision-модели'
    case 'binary_path': return 'Только путь'
    case 'error': return 'Ошибка'
    case 'skipped': return 'Пропущен'
  }
}

function formatSize(size: number | undefined): string {
  if (size === undefined) return ''
  if (size < 1024) return `${size}B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`
  return `${(size / 1024 / 1024).toFixed(1)}MB`
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}мс`
  return `${(ms / 1000).toFixed(1)}с`
}

const AttachmentProcessingBlock = memo(function AttachmentProcessingBlock({ result, liveProgress }: Props) {
  const [expanded, setExpanded] = useState(true)
  const [expandedFiles, setExpandedFiles] = useState<Set<number>>(new Set())

  const activeStage = liveProgress?.stage
  const activeIdx = activeStage ? stageIndex(activeStage) : 3
  // isLive — активная обработка (spinner + shimmer + progress bar).
  // isLiveDone — обработка завершена (stage==='done'), но стрим токенов
  // ещё может идти. Показываем roadmap "всё готово" без file list
  // (result появится только в persisted-фазе после CHAT_STREAM_DONE).
  const isLive = !!activeStage && activeStage !== 'done'
  const isLiveDone = activeStage === 'done'
  const hasLive = isLive || isLiveDone

  const toggleFile = (i: number) => {
    setExpandedFiles(prev => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  // Авто-сворачивание через 1.5с после завершения live-фазы
  const wasLiveRef = useRef(false)
  useEffect(() => {
    if (hasLive) {
      wasLiveRef.current = true
      setExpanded(true)
    } else if (wasLiveRef.current && !hasLive) {
      const t = setTimeout(() => setExpanded(false), 1500)
      return () => clearTimeout(t)
    }
  }, [hasLive])

  // Live-прогресс
  const liveTotal = liveProgress?.filesTotal ?? 0
  const liveProcessed = liveProgress?.filesProcessed ?? 0
  const livePct = liveTotal > 0 ? Math.round((liveProcessed / liveTotal) * 100) : 0

  // Финальный результат
  const files = result.files ?? []
  const totalFiles = files.length
  const totalProcessed = result.totalProcessed ?? 0
  const totalErrors = result.totalErrors ?? 0
  const totalImages = result.totalImages ?? 0

  return (
    <div className={`apb-wrap${hasLive ? ' apb-wrap--live' : ''}`}>
      <div className="apb-header" onClick={() => setExpanded(!expanded)}>
        <div className="apb-header-left">
          <Paperclip size={14} className={`apb-icon${isLive ? ' apb-icon--spin' : ''}`} />
          <span className="apb-title">Обработка вложений</span>
          {result.hasErrors && <span className="apb-error-badge">ошибки</span>}
          {totalImages > 0 && !hasLive && (
            <span className="apb-images-badge">{totalImages} изобр.</span>
          )}
        </div>
        <div className="apb-header-right">
          {!hasLive && (
            <span className="apb-meta">
              <Clock size={11} />
              {formatMs(result.ms)} · {totalProcessed} файлов
            </span>
          )}
          {isLive && liveTotal > 0 && (
            <span className="apb-meta apb-meta--live">
              {liveProcessed}/{liveTotal}
            </span>
          )}
          {isLiveDone && (
            <span className="apb-meta apb-meta--live">
              <Check size={11} />
              Готово
            </span>
          )}
          <motion.span
            className="apb-chevron"
            animate={{ rotate: expanded ? 0 : -90 }}
            transition={{ type: 'spring', stiffness: 400, damping: 25 }}
          >
            <ChevronDown size={14} />
          </motion.span>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            className="apb-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 32 }}
          >
            {/* Live-режим: stages roadmap + progress bar.
                isLive — активная обработка (spinner на текущей стадии).
                isLiveDone — все стадии завершены, стрим токенов ещё идёт. */}
            {hasLive && (
              <>
                <div className="apb-stages">
                  {STAGES.map((stage, i) => {
                    // isLiveDone — все стадии отмечены как done (включая 'done')
                    const isDone = isLiveDone ? i <= activeIdx : i < activeIdx
                    const isActive = isLive ? i === activeIdx : false
                    const StageIcon = stage.icon
                    return (
                      <div
                        key={stage.id}
                        className={`apb-stage${isDone ? ' done' : ''}${isActive ? ' active' : ''}`}
                      >
                        <div className={`apb-stage-icon${isActive ? ' apb-stage-icon--spin' : ''}`}>
                          {isDone ? <Check size={12} /> : <StageIcon size={12} />}
                        </div>
                        <span className="apb-stage-label">{stage.label}</span>
                      </div>
                    )
                  })}
                </div>

                {isLive && liveProgress?.detail && (
                  <div className="apb-stage-detail">
                    <Loader2 size={11} className="apb-detail-spinner" />
                    <span className="apb-detail-text">{liveProgress.detail}</span>
                  </div>
                )}
                {isLiveDone && (
                  <div className="apb-stage-detail">
                    <Check size={11} />
                    <span className="apb-detail-text">Вложения обработаны, генерация ответа…</span>
                  </div>
                )}

                {liveTotal > 0 && (
                  <div className="apb-progress-bar">
                    <motion.div
                      className="apb-progress-fill"
                      animate={{ width: `${isLiveDone ? 100 : livePct}%` }}
                      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                    />
                  </div>
                )}
              </>
            )}

            {/* Финальный режим: список файлов */}
            {!hasLive && files.length > 0 && (
              <div className="apb-files">
                {files.map((file, i) => {
                  const isExpanded = expandedFiles.has(i)
                  const isError = file.status === 'error'
                  return (
                    <div key={i} className={`apb-file-row${isError ? ' apb-file-row--error' : ''}`}>
                      <div className="apb-file-header" onClick={() => toggleFile(i)}>
                        <span className={`apb-file-icon apb-file-icon--${file.status}`}>
                          <FileStatusIcon status={file.status} />
                        </span>
                        <span className="apb-file-name">{file.name}</span>
                        {file.size !== undefined && file.size > 0 && (
                          <span className="apb-file-size">{formatSize(file.size)}</span>
                        )}
                        <span className={`apb-file-status apb-file-status--${file.status}`}>
                          {statusLabel(file.status)}
                        </span>
                        {file.description && (
                          <motion.span
                            className="apb-file-chevron"
                            animate={{ rotate: isExpanded ? 0 : -90 }}
                            transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                          >
                            <ChevronDown size={11} />
                          </motion.span>
                        )}
                      </div>
                      <AnimatePresence initial={false}>
                        {isExpanded && file.description && (
                          <motion.div
                            className="apb-file-description"
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                          >
                            {file.description}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Shimmer-плейсхолдер когда live и нет files */}
            {isLive && (
              <div className="apb-shimmer-wrap">
                <div className="apb-shimmer-line" />
                <div className="apb-shimmer-line apb-shimmer-line--short" />
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
})

export default AttachmentProcessingBlock
