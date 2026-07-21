import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import DiffBlock from '../DiffBlock/DiffBlock'
import './GitPanel.css'

interface GitFileStatus {
  path: string
  indexStatus: string
  worktreeStatus: string
  raw: string
}

interface GitStatus {
  branch: string | null
  ahead: number
  behind: number
  files: GitFileStatus[]
  clean: boolean
}

interface GitLogEntry {
  hash: string
  shortHash: string
  author: string
  date: string
  message: string
}

interface GitPanelProps {
  workdir: string | null
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  M: { label: 'M', cls: 'git-status-modified' },
  A: { label: 'A', cls: 'git-status-added' },
  D: { label: 'D', cls: 'git-status-deleted' },
  R: { label: 'R', cls: 'git-status-renamed' },
  C: { label: 'C', cls: 'git-status-copied' },
  U: { label: 'U', cls: 'git-status-unmerged' },
  '?': { label: '?', cls: 'git-status-untracked' },
  ' ': { label: ' ', cls: 'git-status-unchanged' },
}

function getFileBadge(file: GitFileStatus): { label: string; cls: string; title: string } {
  const idx = file.indexStatus
  const wt = file.worktreeStatus
  if (idx === '?' && wt === '?') return { label: '?', cls: 'git-status-untracked', title: 'Untracked' }
  if (idx === 'M') return { label: 'M', cls: 'git-status-staged', title: 'Modified (staged)' }
  if (wt === 'M') return { label: 'M', cls: 'git-status-modified', title: 'Modified (working tree)' }
  if (idx === 'A') return { label: 'A', cls: 'git-status-staged', title: 'Added (staged)' }
  if (idx === 'D') return { label: 'D', cls: 'git-status-staged', title: 'Deleted (staged)' }
  if (wt === 'D') return { label: 'D', cls: 'git-status-deleted', title: 'Deleted (working tree)' }
  if (idx === 'R') return { label: 'R', cls: 'git-status-staged', title: 'Renamed (staged)' }
  if (idx === 'C') return { label: 'C', cls: 'git-status-staged', title: 'Copied (staged)' }
  if (idx === 'U' || wt === 'U') return { label: 'U', cls: 'git-status-unmerged', title: 'Unmerged' }
  const meta = STATUS_META[idx] ?? STATUS_META[wt] ?? STATUS_META[' ']
  return { label: meta.label, cls: meta.cls, title: file.raw }
}

export default function GitPanel({ workdir }: GitPanelProps) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [log, setLog] = useState<GitLogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notARepo, setNotARepo] = useState(false)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!workdir) return
    setLoading(true)
    setError(null)
    setNotARepo(false)
    try {
      const [statusResult, logResult] = await Promise.all([
        window.syntee.git.status(workdir),
        window.syntee.git.log({ workdir, limit: 15 }),
      ]) as [GitStatus & { success: boolean; error?: string; notARepo?: boolean }, { success: boolean; entries: GitLogEntry[]; error?: string; notARepo?: boolean }]

      if (statusResult.notARepo) {
        setNotARepo(true)
        setStatus(null)
        setLog([])
        return
      }
      if (!statusResult.success) {
        setError(statusResult.error ?? 'Failed to load git status')
        return
      }
      setStatus({
        branch: statusResult.branch,
        ahead: statusResult.ahead,
        behind: statusResult.behind,
        files: statusResult.files,
        clean: statusResult.clean,
      })
      if (logResult.success) {
        setLog(logResult.entries)
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setLoading(false)
    }
  }, [workdir])

  // NOTE: сброс состояния при смене workdir выполняется через key prop
  // в RightPanel — React полностью перемонтирует компонент.

  // Загрузка при монтировании
  useEffect(() => {
    if (workdir) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workdir])

  // Авто-refresh каждые 30 секунд
  useEffect(() => {
    if (!workdir) return
    const interval = setInterval(refresh, 30_000)
    return () => clearInterval(interval)
  }, [workdir, refresh])

  const loadDiff = useCallback(async (file: GitFileStatus) => {
    if (!workdir) return
    setSelectedFile(file.path)
    setDiff(null)
    setDiffError(null)
    setDiffLoading(true)
    try {
      const isUntracked = file.indexStatus === '?' && file.worktreeStatus === '?'
      const result = isUntracked
        ? await window.syntee.fs.readFile({ root: workdir, relPath: file.path }) as { success: boolean; content: string; error?: string; isBinary?: boolean }
        : await window.syntee.git.diff({ workdir, file: file.path }) as { success: boolean; diff: string; error?: string }

      if (!result.success) {
        setDiffError(result.error ?? 'Failed to load diff')
        return
      }
      if (isUntracked) {
        const content = (result as { content: string }).content
        const lines = content.split('\n').map(l => `+${l}`)
        setDiff(lines.join('\n'))
      } else {
        setDiff((result as { diff: string }).diff || 'Нет изменений в diff')
      }
    } catch (e) {
      setDiffError(String((e as Error)?.message ?? e))
    } finally {
      setDiffLoading(false)
    }
  }, [workdir])

  if (!workdir) {
    return (
      <div className="git-panel git-panel--empty">
        <AppIcon name="git" size="lg" tone="muted" />
        <p>Нет рабочей директории</p>
        <p className="git-panel__hint">Выберите проект, чтобы увидеть git-статус</p>
      </div>
    )
  }

  if (notARepo) {
    return (
      <div className="git-panel git-panel--empty">
        <AppIcon name="git" size="lg" tone="muted" />
        <p>Не git-репозиторий</p>
        <p className="git-panel__hint">В этой папке нет git-репозитория</p>
      </div>
    )
  }

  if (error && !status) {
    return (
      <div className="git-panel git-panel--empty">
        <AppIcon name="x" size="lg" tone="danger" />
        <p>Ошибка загрузки</p>
        <p className="git-panel__hint">{error}</p>
        <button className="git-panel__retry" onClick={refresh}>
          <AppIcon name="refreshCw" size="xs" /> Повторить
        </button>
      </div>
    )
  }

  return (
    <div className="git-panel">
      <div className="git-panel__files">
        <div className="git-panel__header">
          <div className="git-panel__branch">
            <AppIcon name="git-branch" size="xs" />
            <span className="git-panel__branch-name" title={status?.branch ?? ''}>
              {status?.branch ?? '…'}
            </span>
            {(status?.ahead ?? 0) > 0 && (
              <span className="git-panel__ahead-behind git-panel__ahead-behind--ahead" title="Ahead">
                ↑{status?.ahead}
              </span>
            )}
            {(status?.behind ?? 0) > 0 && (
              <span className="git-panel__ahead-behind git-panel__ahead-behind--behind" title="Behind">
                ↓{status?.behind}
              </span>
            )}
          </div>
          <button
            className="git-panel__refresh"
            title="Обновить"
            onClick={refresh}
            disabled={loading}
          >
            <AppIcon name="refreshCw" size="xs" animation={loading ? 'spin' : 'none'} />
          </button>
        </div>

        <div className="git-panel__files-body">
          {loading && !status ? (
            <div className="git-panel__loading">
              <AppIcon name="loader" size="sm" animation="spin" />
              <span>Загрузка...</span>
            </div>
          ) : status?.clean ? (
            <div className="git-panel__clean">
              <AppIcon name="check" size="md" tone="success" />
              <p>Нет изменений</p>
              <span>Рабочая директория чиста</span>
            </div>
          ) : (
            <div className="git-panel__file-list">
              {status?.files.map((file, i) => {
                const badge = getFileBadge(file)
                const fileName = file.path.split(/[\\/]/).pop() ?? file.path
                const dir = file.path.includes('/') || file.path.includes('\\')
                  ? file.path.replace(/[\\/][^\\/]+$/, '')
                  : ''
                return (
                  <button
                    key={`${file.path}-${i}`}
                    className={`git-file-item ${selectedFile === file.path ? 'git-file-item--selected' : ''}`}
                    onClick={() => loadDiff(file)}
                    title={file.path}
                  >
                    <span className={`git-file-item__badge ${badge.cls}`}>{badge.label}</span>
                    <div className="git-file-item__info">
                      <span className="git-file-item__name">{fileName}</span>
                      {dir && <span className="git-file-item__dir">{dir}</span>}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {log.length > 0 && (
          <div className="git-panel__log">
            <div className="git-panel__log-header">
              <AppIcon name="clock" size="xs" />
              <span>Последние коммиты</span>
            </div>
            <div className="git-panel__log-list">
              {log.map(entry => (
                <div key={entry.hash} className="git-log-item" title={entry.message}>
                  <span className="git-log-item__hash">{entry.shortHash}</span>
                  <span className="git-log-item__msg">{entry.message.split('\n')[0]}</span>
                  <span className="git-log-item__date">{entry.date}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="git-panel__diff">
        <AnimatePresence mode="wait">
          {selectedFile && (
            <motion.div
              key={selectedFile}
              className="git-panel__diff-content"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
            >
              <div className="git-panel__diff-header">
                <AppIcon name="fileText" size="xs" />
                <span className="git-panel__diff-path" title={selectedFile}>{selectedFile}</span>
              </div>
              <div className="git-panel__diff-body">
                {diffLoading ? (
                  <div className="git-panel__diff-loading">
                    <AppIcon name="loader" size="sm" animation="spin" />
                    <span>Загрузка diff...</span>
                  </div>
                ) : diffError ? (
                  <div className="git-panel__diff-error">
                    <AppIcon name="x" size="lg" tone="danger" />
                    <p>{diffError}</p>
                  </div>
                ) : diff ? (
                  <DiffBlock code={diff} variant="detailed" />
                ) : null}
              </div>
            </motion.div>
          )}
          {!selectedFile && (
            <motion.div
              key="empty"
              className="git-panel__diff-empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <AppIcon name="git" size="lg" tone="muted" />
              <p>Выберите файл, чтобы увидеть diff</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
