import { useState, useEffect, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import DiffBlock from '../DiffBlock/DiffBlock'
import type { CheckpointMeta, RewindResult, LastTurnChanges } from '../../../../../shared/types'
import { useChatStore } from '../../../store/chat.store'
import './SessionChangesPanel.css'

interface SessionChangesPanelProps {
  chatId?: string | null
}

type ViewMode = 'last' | 'all'

/** Извлекает basename из пути (работает с / и \). */
function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/** Извлекает директорию из пути. */
function dirname(p: string): string {
  return p.includes('\\') || p.includes('/')
    ? p.replace(/[\\/][^\\/]+$/, '')
    : ''
}

export default function SessionChangesPanel({ chatId }: SessionChangesPanelProps) {
  const [checkpoints, setCheckpoints] = useState<CheckpointMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('last')
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<CheckpointMeta | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [rewinding, setRewinding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── Redo-баннер: отмена отката ──
  const [lastRewind, setLastRewind] = useState<{ rewindMessageId: string; createdAt: number } | null>(null)
  const [canRedo, setCanRedo] = useState(false)
  const [redoing, setRedoing] = useState(false)

  // ── Per-file undo в diff-панели ──
  const [undoingFile, setUndoingFile] = useState<string | null>(null)
  const [undoingAll, setUndoingAll] = useState(false)

  // ── +N -M последнего turn'а из store (для file-chips последнего чекпоинта) ──
  const lastTurnChanges = useChatStore(s => chatId ? s.lastTurnChangesByChat[chatId] : undefined) as LastTurnChanges | null | undefined

  const refresh = useCallback(async () => {
    if (!chatId) return
    setLoading(true)
    setError(null)
    try {
      const result = await window.syntee.chat.getSessionTimeline(chatId) as CheckpointMeta[]
      setCheckpoints(result)
      // Проверяем наличие активного отката для redo-баннера
      const rewind = await window.syntee.chat.getLastRewind(chatId) as { rewindMessageId: string; createdAt: number } | null
      setLastRewind(rewind)
      if (rewind) {
        const redo = await window.syntee.chat.canRedo(chatId, rewind.rewindMessageId) as boolean
        setCanRedo(redo)
      } else {
        setCanRedo(false)
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setLoading(false)
    }
  }, [chatId])

  useEffect(() => {
    if (chatId) {
      // schedule refresh to avoid synchronous setState in effect
      requestAnimationFrame(() => { refresh() })
      // В режиме "последний запрос" автоматически выбираем последний checkpoint с правками
      setSelectedCheckpoint(null)
      setDiff(null)
    } else {
      setCheckpoints([])
      setSelectedCheckpoint(null)
      setDiff(null)
      setLastRewind(null)
      setCanRedo(false)
    }
  }, [chatId, refresh])

  // Авто-refresh при получении события о новом чекпоинте
  useEffect(() => {
    if (!chatId) return
    const handler = (data: { chatId: string }) => {
      if (data.chatId === chatId) refresh()
    }
    const rewindHandler = (data: { chatId: string }) => {
      if (data.chatId === chatId) {
        refresh()
        setSelectedCheckpoint(null)
        setDiff(null)
      }
    }
    const off1 = window.syntee.on('chat:checkpoint:created', (data: unknown) => handler(data as { chatId: string }))
    const off2 = window.syntee.on('chat:rewound', (data: unknown) => rewindHandler(data as { chatId: string }))
    return () => { off1(); off2() }
  }, [chatId, refresh])

  // Checkpoints с правками файлов
  const checkpointsWithFiles = useMemo(() => checkpoints.filter(c => c.filesChanged > 0), [checkpoints])
  const lastCheckpointWithFiles = useMemo(() => {
    return checkpointsWithFiles.length > 0 ? checkpointsWithFiles[checkpointsWithFiles.length - 1] : null
  }, [checkpointsWithFiles])

  // В режиме "последний запрос" показываем только последний checkpoint с правками
  const visibleCheckpoints = useMemo(() => {
    if (viewMode === 'all') return checkpoints
    return lastCheckpointWithFiles ? [lastCheckpointWithFiles] : []
  }, [viewMode, checkpoints, lastCheckpointWithFiles])

  // Общая статистика для шапки режима "Все изменения"
  const totalStats = useMemo(() => {
    const totalFiles = checkpointsWithFiles.reduce((sum, c) => sum + c.filesChanged, 0)
    const uniqueFiles = new Set(checkpointsWithFiles.flatMap(c => c.filePaths)).size
    return { turns: checkpointsWithFiles.length, totalFiles, uniqueFiles }
  }, [checkpointsWithFiles])

  const loadCheckpointDiff = useCallback(async (cp: CheckpointMeta) => {
    if (!chatId) return
    setSelectedCheckpoint(cp)
    setDiff(null)
    if (cp.filesChanged === 0 || cp.filePaths.length === 0 || !cp.assistantMessageId) {
      return
    }
    setDiffLoading(true)
    try {
      const messages = await window.syntee.chat.getMessages(chatId) as Array<{
        id: string
        toolSteps?: Array<{ type: string; diff?: string; toolName?: string }>
      }>
      const assistantMsg = messages.find(m => m.id === cp.assistantMessageId)
      if (!assistantMsg?.toolSteps) {
        setDiff(null)
        return
      }
      const diffs: string[] = []
      for (const step of assistantMsg.toolSteps) {
        if (step.type === 'tool_result' && step.diff) {
          diffs.push(step.diff)
        }
      }
      setDiff(diffs.length > 0 ? diffs.join('\n\n') : null)
    } catch {
      setDiff(null)
    } finally {
      setDiffLoading(false)
    }
  }, [chatId])

  // Автовыбор последнего checkpoint'а при переключении в режим "last"
  useEffect(() => {
    if (viewMode === 'last' && lastCheckpointWithFiles && !selectedCheckpoint) {
      loadCheckpointDiff(lastCheckpointWithFiles)
    }
  }, [viewMode, lastCheckpointWithFiles, selectedCheckpoint, loadCheckpointDiff])

  // ── Rewind (откат сессии) ──
  const handleRewind = useCallback(async (cp: CheckpointMeta) => {
    if (!chatId || rewinding) return
    const preview = cp.userPromptPreview.length > 60 ? cp.userPromptPreview.slice(0, 60) + '…' : cp.userPromptPreview
    const confirmed = window.confirm(
      `Откатить сессию к сообщению "${preview}"?\n\n` +
      `Будет восстановлено ${cp.filesChanged} файл(ов) и удалены все последующие сообщения.\n` +
      `Это действие можно отменить кнопкой «Отменить откат».`
    )
    if (!confirmed) return

    setRewinding(true)
    try {
      const result = await window.syntee.chat.rewindTo(chatId, cp.userMessageId) as RewindResult
      if (result.error) {
        setError(result.error)
      }
      await refresh()
      setSelectedCheckpoint(null)
      setDiff(null)
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setRewinding(false)
    }
  }, [chatId, rewinding, refresh])

  // ── Redo (отмена отката) ──
  const handleRedo = useCallback(async () => {
    if (!chatId || !lastRewind || redoing) return
    const confirmed = window.confirm('Отменить откат? Сообщения и файлы будут возвращены.')
    if (!confirmed) return
    setRedoing(true)
    try {
      const result = await window.syntee.chat.redo(chatId, lastRewind.rewindMessageId) as { messages?: unknown[]; error?: string }
      if (result.error) {
        window.alert(result.error)
      }
      // CHAT_REWOUND event обновит messages в store + refresh() через подписку
    } catch (e) {
      window.alert(String((e as Error)?.message ?? e))
    } finally {
      setRedoing(false)
    }
  }, [chatId, lastRewind, redoing])

  // ── Per-file undo (одного файла чекпоинта) ──
  const handleUndoFile = useCallback(async (filePath: string) => {
    if (!chatId || !selectedCheckpoint || undoingFile || undoingAll) return
    const name = basename(filePath)
    const isLast = lastCheckpointWithFiles?.id === selectedCheckpoint.id
    const warning = isLast
      ? 'Файл будет восстановлен к состоянию до этого запроса.'
      : 'Внимание: более поздние правки этого файла будут перезаписаны.\n\nДля полной отмены лучше используйте «Откатить сюда».'
    const confirmed = window.confirm(`Отменить изменения в файле «${name}»?\n\n${warning}`)
    if (!confirmed) return
    setUndoingFile(filePath)
    try {
      const result = await window.syntee.chat.undoCheckpointFile(chatId, selectedCheckpoint.userMessageId, filePath)
      if (result?.error) {
        window.alert(`Ошибка: ${result.error}`)
      }
      // CHAT_FILES_RESTORED сбросит lastTurnChanges в store
    } catch (e) {
      window.alert(`Ошибка: ${(e as Error).message}`)
    } finally {
      setUndoingFile(null)
    }
  }, [chatId, selectedCheckpoint, undoingFile, undoingAll, lastCheckpointWithFiles])

  // ── Undo all files of checkpoint ──
  const handleUndoAllFiles = useCallback(async () => {
    if (!chatId || !selectedCheckpoint || undoingFile || undoingAll) return
    const isLast = lastCheckpointWithFiles?.id === selectedCheckpoint.id
    const warning = isLast
      ? `${selectedCheckpoint.filesChanged} файл(ов) будет восстановлено к состоянию до запроса.\nСообщения диалога останутся без изменений.`
      : `${selectedCheckpoint.filesChanged} файл(ов) будет восстановлено к состоянию этого запроса.\nВнимание: более поздние правки этих файлов будут перезаписаны.`
    const confirmed = window.confirm(`Отменить все изменения этого запроса?\n\n${warning}`)
    if (!confirmed) return
    setUndoingAll(true)
    try {
      const result = await window.syntee.chat.undoCheckpointFiles(chatId, selectedCheckpoint.userMessageId)
      if (result?.error) {
        window.alert(`Ошибка: ${result.error}`)
      }
    } catch (e) {
      window.alert(`Ошибка: ${(e as Error).message}`)
    } finally {
      setUndoingAll(false)
    }
  }, [chatId, selectedCheckpoint, undoingFile, undoingAll, lastCheckpointWithFiles])

  // ── +N -M для конкретного файла (только последнего чекпоинта) ──
  const getFileStats = useCallback((filePath: string): { added: number; deleted: number } | null => {
    if (!lastTurnChanges || !selectedCheckpoint) return null
    if (lastCheckpointWithFiles?.id !== selectedCheckpoint.id) return null
    const fc = lastTurnChanges.files.find(f => f.path === filePath)
    if (!fc) return null
    return { added: fc.added, deleted: fc.deleted }
  }, [lastTurnChanges, selectedCheckpoint, lastCheckpointWithFiles])

  if (!chatId) {
    return (
      <div className="session-panel session-panel--empty">
        <AppIcon name="history" size="lg" tone="muted" />
        <p>Нет активного чата</p>
        <p className="session-panel__hint">Выберите чат, чтобы увидеть историю изменений</p>
      </div>
    )
  }

  if (error && checkpoints.length === 0) {
    return (
      <div className="session-panel session-panel--empty">
        <AppIcon name="x" size="lg" tone="danger" />
        <p>Ошибка загрузки</p>
        <p className="session-panel__hint">{error}</p>
        <button className="session-panel__retry" onClick={refresh}>
          <AppIcon name="refreshCw" size="xs" /> Повторить
        </button>
      </div>
    )
  }

  return (
    <div className="session-panel">
      <div className="session-panel__timeline">
        <div className="session-panel__header">
          <div className="session-panel__title">
            <AppIcon name="history" size="xs" />
            <span>Сессия</span>
          </div>
          <button
            className="session-panel__refresh"
            title="Обновить"
            onClick={refresh}
            disabled={loading}
          >
            <AppIcon name="refreshCw" size="xs" animation={loading ? 'spin' : 'none'} />
          </button>
        </div>

        {/* ── Redo-баннер: отмена отката ── */}
        <AnimatePresence>
          {canRedo && lastRewind && (
            <motion.div
              className="session-panel__redo-banner"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
            >
              <div className="session-panel__redo-info">
                <AppIcon name="rewind" size="xs" tone="warning" />
                <span>Откат активен</span>
              </div>
              <button
                className="session-panel__redo-btn"
                onClick={handleRedo}
                disabled={redoing}
                title="Отменить откат — вернуть сообщения и файлы"
              >
                <AppIcon name="refreshCw" size="xs" animation={redoing ? 'spin' : 'none'} />
                <span>{redoing ? 'Отмена...' : 'Отменить откат'}</span>
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Переключатель режимов */}
        <div className="session-panel__mode-switch">
          <button
            className={`session-panel__mode-btn ${viewMode === 'last' ? 'session-panel__mode-btn--active' : ''}`}
            onClick={() => setViewMode('last')}
            title="Что изменилось в последнем запросе"
          >
            <AppIcon name="zap" size="xs" />
            <span>Последний запрос</span>
          </button>
          <button
            className={`session-panel__mode-btn ${viewMode === 'all' ? 'session-panel__mode-btn--active' : ''}`}
            onClick={() => setViewMode('all')}
            title="Все изменения за всю сессию"
          >
            <AppIcon name="listChecks" size="xs" />
            <span>Все изменения</span>
          </button>
        </div>

        {/* Статистика в режиме "Все изменения" */}
        {viewMode === 'all' && totalStats.turns > 0 && (
          <div className="session-panel__stats">
            <div className="session-panel__stat">
              <span className="session-panel__stat-value">{totalStats.turns}</span>
              <span className="session-panel__stat-label">запросов с правками</span>
            </div>
            <div className="session-panel__stat">
              <span className="session-panel__stat-value">{totalStats.uniqueFiles}</span>
              <span className="session-panel__stat-label">файлов затронуто</span>
            </div>
          </div>
        )}

        <div className="session-panel__list">
          {loading && checkpoints.length === 0 ? (
            <div className="session-panel__loading">
              <AppIcon name="loader" size="sm" animation="spin" />
              <span>Загрузка...</span>
            </div>
          ) : visibleCheckpoints.length === 0 ? (
            <div className="session-panel__empty-list">
              <AppIcon name={viewMode === 'last' ? 'zap' : 'listChecks'} size="md" tone="muted" />
              <p>{viewMode === 'last' ? 'Нет правок в последнем запросе' : 'Нет правок за сессию'}</p>
              <span>{viewMode === 'last' ? 'Попросите AI изменить файл — здесь появятся изменения' : 'Отправьте запрос с правкой файлов'}</span>
            </div>
          ) : (
            <div className="session-panel__items">
              {visibleCheckpoints.slice().reverse().map((cp, idx) => {
                const isLast = viewMode === 'all' && idx === 0
                const isSelected = selectedCheckpoint?.id === cp.id
                return (
                  <div
                    key={cp.id}
                    className={`session-checkpoint ${isSelected ? 'session-checkpoint--selected' : ''} ${isLast ? 'session-checkpoint--latest' : ''}`}
                  >
                    <button
                      className="session-checkpoint__main"
                      onClick={() => loadCheckpointDiff(cp)}
                      title={cp.userPromptPreview}
                    >
                      <div className="session-checkpoint__header-row">
                        <span className="session-checkpoint__time">
                          {new Date(cp.createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        {isLast && <span className="session-checkpoint__latest-tag">последний</span>}
                      </div>
                      <div className="session-checkpoint__preview">{cp.userPromptPreview}</div>
                    </button>
                    {cp.filesChanged > 0 && (
                      <>
                        <div className="session-checkpoint__files-summary">
                          <span className="session-checkpoint__files-badge">
                            {cp.filesChanged}
                          </span>
                          <span>{cp.filesChanged === 1 ? 'файл изменён' : cp.filesChanged < 5 ? 'файла изменено' : 'файлов изменено'}</span>
                        </div>
                        <div className="session-checkpoint__paths">
                          {cp.filePaths.map((p, i) => {
                            const fileName = basename(p)
                            const dir = dirname(p)
                            const stats = lastCheckpointWithFiles?.id === cp.id && lastTurnChanges
                              ? lastTurnChanges.files.find(f => f.path === p)
                              : null
                            return (
                              <button
                                key={`${p}-${i}`}
                                className={`session-checkpoint__path ${isSelected ? 'session-checkpoint__path--active' : ''}`}
                                onClick={() => loadCheckpointDiff(cp)}
                                title={p}
                              >
                                <span className="session-checkpoint__path-name">{fileName}</span>
                                {stats && (
                                  <span className="session-checkpoint__path-stats">
                                    <span className="session-checkpoint__path-added">+{stats.added}</span>
                                    <span className="session-checkpoint__path-deleted">-{stats.deleted}</span>
                                  </span>
                                )}
                                {dir && <span className="session-checkpoint__path-dir">{dir}</span>}
                              </button>
                            )
                          })}
                        </div>
                      </>
                    )}
                    <button
                      className="session-checkpoint__rewind"
                      title="Откатить к этому сообщению"
                      onClick={() => handleRewind(cp)}
                      disabled={rewinding}
                    >
                      <AppIcon name="rewind" size="xs" />
                      <span>Откатить сюда</span>
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <div className="session-panel__diff">
        <AnimatePresence mode="wait">
          {selectedCheckpoint && (
            <motion.div
              key={selectedCheckpoint.id}
              className="session-panel__diff-content"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
            >
              {/* ── Diff header: file count + «Отменить все» ── */}
              <div className="session-panel__diff-header">
                <div className="session-panel__diff-header-left">
                  <AppIcon name="fileText" size="xs" />
                  <span className="session-panel__diff-title">
                    {selectedCheckpoint.filesChanged > 0
                      ? `${selectedCheckpoint.filesChanged} ${selectedCheckpoint.filesChanged === 1 ? 'файл' : selectedCheckpoint.filesChanged < 5 ? 'файла' : 'файлов'}`
                      : 'Нет изменений файлов'}
                  </span>
                </div>
                {selectedCheckpoint.filesChanged > 0 && (
                  <button
                    className="session-panel__diff-undo-all"
                    onClick={handleUndoAllFiles}
                    disabled={!!undoingFile || undoingAll}
                    title="Отменить все изменения этого запроса"
                  >
                    {undoingAll ? (
                      <AppIcon name="refreshCw" size="xs" animation="spin" />
                    ) : (
                      <AppIcon name="undo" size="xs" />
                    )}
                    <span>{undoingAll ? 'Отмена...' : 'Отменить все'}</span>
                  </button>
                )}
              </div>

              {/* ── File chips с undo-кнопками ── */}
              {selectedCheckpoint.filesChanged > 0 && (
                <div className="session-panel__file-chips">
                  {selectedCheckpoint.filePaths.map((p) => {
                    const name = basename(p)
                    const dir = dirname(p)
                    const stats = getFileStats(p)
                    const isUndoing = undoingFile === p
                    return (
                      <div key={p} className="session-file-chip">
                        <div className="session-file-chip__info" title={p}>
                          <span className="session-file-chip__name">{name}</span>
                          {dir && <span className="session-file-chip__dir">{dir}</span>}
                          {stats && (
                            <span className="session-file-chip__stats">
                              <span className="session-file-chip__added">+{stats.added}</span>
                              <span className="session-file-chip__deleted">-{stats.deleted}</span>
                            </span>
                          )}
                        </div>
                        <button
                          className="session-file-chip__undo"
                          onClick={() => handleUndoFile(p)}
                          disabled={!!undoingFile || undoingAll}
                          title="Отменить изменения в этом файле"
                        >
                          {isUndoing ? (
                            <AppIcon name="refreshCw" size="xs" animation="spin" />
                          ) : (
                            <AppIcon name="undo" size="xs" />
                          )}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}

              <div className="session-panel__diff-body">
                {diffLoading ? (
                  <div className="session-panel__diff-loading">
                    <AppIcon name="loader" size="sm" animation="spin" />
                    <span>Загрузка diff...</span>
                  </div>
                ) : diff ? (
                  <DiffBlock code={diff} variant="detailed" />
                ) : selectedCheckpoint.filesChanged === 0 ? (
                  <div className="session-panel__diff-empty-inner">
                    <AppIcon name="messageSquare" size="md" tone="muted" />
                    <p>В этом запросе файлы не изменялись</p>
                  </div>
                ) : (
                  <div className="session-panel__diff-empty-inner">
                    <AppIcon name="fileText" size="md" tone="muted" />
                    <p>Нет diff для отображения</p>
                  </div>
                )}
              </div>
            </motion.div>
          )}
          {!selectedCheckpoint && (
            <motion.div
              key="empty"
              className="session-panel__diff-empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <AppIcon name="history" size="lg" tone="muted" />
              <p>Выберите точку, чтобы увидеть изменения</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
