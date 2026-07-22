import { useState, useEffect, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import DiffBlock from '../DiffBlock/DiffBlock'
import type { CheckpointMeta, RewindResult } from '../../../../../shared/types'
import './SessionChangesPanel.css'

interface SessionChangesPanelProps {
  chatId?: string | null
}

type ViewMode = 'last' | 'all'

export default function SessionChangesPanel({ chatId }: SessionChangesPanelProps) {
  const [checkpoints, setCheckpoints] = useState<CheckpointMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('last')
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<CheckpointMeta | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [rewinding, setRewinding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!chatId) return
    setLoading(true)
    setError(null)
    try {
      const result = await window.syntee.chat.getSessionTimeline(chatId) as CheckpointMeta[]
      setCheckpoints(result)
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setLoading(false)
    }
  }, [chatId])

  useEffect(() => {
    if (chatId) {
      refresh()
      // В режиме "последний запрос" автоматически выбираем последний checkpoint с правками
      setSelectedCheckpoint(null)
      setDiff(null)
    } else {
      setCheckpoints([])
      setSelectedCheckpoint(null)
      setDiff(null)
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
    if (viewMode === 'all' && selectedCheckpoint) {
      // снимаем выбор при переключении в "all" — пользователь сам кликнет
      // (оставляем selectedCheckpoint чтобы diff не пропадал при возврате)
    }
  }, [viewMode, lastCheckpointWithFiles, selectedCheckpoint, loadCheckpointDiff])

  const handleRewind = useCallback(async (cp: CheckpointMeta) => {
    if (!chatId || rewinding) return
    const preview = cp.userPromptPreview.length > 60 ? cp.userPromptPreview.slice(0, 60) + '…' : cp.userPromptPreview
    const confirmed = window.confirm(
      `Откатить сессию к сообщению "${preview}"?\n\n` +
      `Будет восстановлено ${cp.filesChanged} файл(ов) и удалены все последующие сообщения.\n` +
      `Это действие необратимо.`
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
                return (
                  <div
                    key={cp.id}
                    className={`session-checkpoint ${selectedCheckpoint?.id === cp.id ? 'session-checkpoint--selected' : ''} ${isLast ? 'session-checkpoint--latest' : ''}`}
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
                          <AppIcon name="fileText" size="xs" />
                          <span>{cp.filesChanged} файл(ов) изменено</span>
                        </div>
                        <div className="session-checkpoint__paths">
                          {cp.filePaths.map((p, i) => {
                            const fileName = p.split(/[\\/]/).pop() ?? p
                            const dir = p.includes('\\') || p.includes('/')
                              ? p.replace(/[\\/][^\\/]+$/, '')
                              : ''
                            return (
                              <button
                                key={`${p}-${i}`}
                                className={`session-checkpoint__path ${selectedCheckpoint?.id === cp.id ? 'session-checkpoint__path--active' : ''}`}
                                onClick={() => loadCheckpointDiff(cp)}
                                title={p}
                              >
                                <span className="session-checkpoint__path-name">{fileName}</span>
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
              <div className="session-panel__diff-header">
                <AppIcon name="fileText" size="xs" />
                <span className="session-panel__diff-title">
                  {selectedCheckpoint.filePaths.length > 0
                    ? selectedCheckpoint.filePaths.map(p => p.split(/[\\/]/).pop()).join(', ')
                    : 'Нет изменений файлов'}
                </span>
              </div>
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
