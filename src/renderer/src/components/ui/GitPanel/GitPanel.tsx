import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import DiffBlock from '../DiffBlock/DiffBlock'
import CodePreview from '../CodePreview/CodePreview'
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

interface FileTreeNode {
  name: string
  path: string
  isDir: boolean
  children: FileTreeNode[]
  file?: GitFileStatus
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

function buildFileTree(files: GitFileStatus[]): FileTreeNode[] {
  const root: FileTreeNode = { name: '', path: '', isDir: true, children: [] }
  for (const file of files) {
    const parts = file.path.split(/[\\/]/)
    let current = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isLast = i === parts.length - 1
      if (isLast) {
        current.children.push({ name: part, path: file.path, isDir: false, children: [], file })
      } else {
        let child = current.children.find(c => c.isDir && c.name === part)
        if (!child) {
          child = { name: part, path: parts.slice(0, i + 1).join('/'), isDir: true, children: [] }
          current.children.push(child)
        }
        current = child
      }
    }
  }
  function sortTree(nodes: FileTreeNode[]) {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    nodes.forEach(n => sortTree(n.children))
  }
  sortTree(root.children)
  return root.children
}

export default function GitPanel({ workdir }: GitPanelProps) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [log, setLog] = useState<GitLogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notARepo, setNotARepo] = useState(false)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [selectedCommit, setSelectedCommit] = useState<{ hash: string; message: string } | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'diff' | 'file'>('diff')
  const [fileContent, setFileContent] = useState<{ path: string; content: string; isBinary: boolean } | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())

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

  useEffect(() => {
    if (workdir) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workdir])

  useEffect(() => {
    if (!workdir) return
    const interval = setInterval(refresh, 30_000)
    return () => clearInterval(interval)
  }, [workdir, refresh])

  const loadDiff = useCallback(async (file: GitFileStatus) => {
    if (!workdir) return
    setSelectedFile(file.path)
    setSelectedCommit(null)
    setDiff(null)
    setDiffError(null)
    setDiffLoading(true)
    setViewMode('diff')
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

  const loadFileContent = useCallback(async (filePath: string) => {
    if (!workdir) return
    if (fileContent?.path === filePath) return
    setFileLoading(true)
    setFileContent(null)
    try {
      const result = await window.syntee.fs.readFile({ root: workdir, relPath: filePath }) as { success: boolean; content: string; error?: string; isBinary?: boolean }
      if (result.success) {
        setFileContent({ path: filePath, content: result.content, isBinary: result.isBinary ?? false })
      } else {
        setDiffError(result.error ?? 'Failed to read file')
      }
    } catch (e) {
      setDiffError(String((e as Error)?.message ?? e))
    } finally {
      setFileLoading(false)
    }
  }, [workdir, fileContent])

  const loadCommit = useCallback(async (entry: GitLogEntry) => {
    if (!workdir) return
    setSelectedCommit({ hash: entry.hash, message: entry.message.split('\n')[0] })
    setSelectedFile(null)
    setDiff(null)
    setDiffError(null)
    setDiffLoading(true)
    try {
      const result = await window.syntee.git.show({ workdir, hash: entry.hash }) as { success: boolean; diff: string; error?: string }
      if (result.success) {
        setDiff(result.diff || 'Нет изменений в этом коммите')
      } else {
        setDiffError(result.error ?? 'Failed to load commit')
      }
    } catch (e) {
      setDiffError(String((e as Error)?.message ?? e))
    } finally {
      setDiffLoading(false)
    }
  }, [workdir])

  const toggleDir = (path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const handleOpenInEditor = () => {
    if (!workdir || !selectedFile) return
    const fullpath = workdir.replace(/[\\/]+$/, '') + '\\' + selectedFile.replace(/\//g, '\\')
    window.syntee.shell.openPath(fullpath)
  }

  const fileTree = status?.files ? buildFileTree(status.files) : []

  const renderTreeNodes = (nodes: FileTreeNode[], level: number): React.ReactNode => {
    return nodes.map(node => {
      if (node.isDir) {
        const expanded = expandedDirs.has(node.path)
        return (
          <div key={node.path}>
            <button
              className="git-tree-dir"
              style={{ paddingLeft: 8 + level * 14 }}
              onClick={() => toggleDir(node.path)}
              title={node.path}
            >
              <AppIcon name={expanded ? 'chevronDown' : 'chevronRight'} size="xs" />
              <AppIcon name="folder" size="xs" />
              <span className="git-tree-dir__name">{node.name}</span>
            </button>
            {expanded && node.children.length > 0 && (
              <div className="git-tree-children">
                {renderTreeNodes(node.children, level + 1)}
              </div>
            )}
          </div>
        )
      }
      const badge = node.file ? getFileBadge(node.file) : null
      return (
        <button
          key={node.path}
          className={`git-file-item ${selectedFile === node.path ? 'git-file-item--selected' : ''}`}
          style={{ paddingLeft: 8 + level * 14 + 18 }}
          onClick={() => node.file && loadDiff(node.file)}
          title={node.path}
        >
          {badge && <span className={`git-file-item__badge ${badge.cls}`}>{badge.label}</span>}
          <span className="git-file-item__name">{node.name}</span>
        </button>
      )
    })
  }

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
              {renderTreeNodes(fileTree, 0)}
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
                <button
                  key={entry.hash}
                  className={`git-log-item ${selectedCommit?.hash === entry.hash ? 'git-log-item--selected' : ''}`}
                  title={entry.message}
                  onClick={() => loadCommit(entry)}
                >
                  <span className="git-log-item__hash">{entry.shortHash}</span>
                  <span className="git-log-item__msg">{entry.message.split('\n')[0]}</span>
                  <span className="git-log-item__date">{entry.date}</span>
                </button>
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
                <div className="git-panel__diff-actions">
                  <div className="git-panel__view-toggle">
                    <button
                      className={`git-panel__view-btn ${viewMode === 'diff' ? 'git-panel__view-btn--active' : ''}`}
                      onClick={() => setViewMode('diff')}
                      title="Показать diff"
                    >
                      <AppIcon name="git" size="xs" />
                    </button>
                    <button
                      className={`git-panel__view-btn ${viewMode === 'file' ? 'git-panel__view-btn--active' : ''}`}
                      onClick={() => { setViewMode('file'); loadFileContent(selectedFile) }}
                      title="Показать весь файл"
                    >
                      <AppIcon name="fileText" size="xs" />
                    </button>
                  </div>
                  <button
                    className="git-panel__action-btn"
                    onClick={handleOpenInEditor}
                    title="Открыть в редакторе"
                  >
                    <AppIcon name="filePen" size="xs" />
                  </button>
                </div>
              </div>
              <div className="git-panel__diff-body">
                {viewMode === 'diff' ? (
                  <>
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
                      <DiffBlock code={diff} variant="detailed" highlight wrap />
                    ) : null}
                  </>
                ) : (
                  <>
                    {fileLoading ? (
                      <div className="git-panel__diff-loading">
                        <AppIcon name="loader" size="sm" animation="spin" />
                        <span>Загрузка файла...</span>
                      </div>
                    ) : fileContent?.isBinary ? (
                      <div className="git-panel__diff-error">
                        <AppIcon name="fileText" size="lg" tone="muted" />
                        <p>Бинарный файл</p>
                      </div>
                    ) : fileContent ? (
                      <CodePreview content={fileContent.content} path={selectedFile} />
                    ) : null}
                  </>
                )}
              </div>
            </motion.div>
          )}
          {selectedCommit && (
            <motion.div
              key={selectedCommit.hash}
              className="git-panel__diff-content"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
            >
              <div className="git-panel__diff-header">
                <AppIcon name="git" size="xs" />
                <span className="git-panel__diff-path" title={selectedCommit.message}>
                  {selectedCommit.hash.slice(0, 7)} · {selectedCommit.message}
                </span>
              </div>
              <div className="git-panel__diff-body">
                {diffLoading ? (
                  <div className="git-panel__diff-loading">
                    <AppIcon name="loader" size="sm" animation="spin" />
                    <span>Загрузка коммита...</span>
                  </div>
                ) : diffError ? (
                  <div className="git-panel__diff-error">
                    <AppIcon name="x" size="lg" tone="danger" />
                    <p>{diffError}</p>
                  </div>
                ) : diff ? (
                  <DiffBlock code={diff} variant="detailed" highlight wrap />
                ) : null}
              </div>
            </motion.div>
          )}
          {!selectedFile && !selectedCommit && (
            <motion.div
              key="empty"
              className="git-panel__diff-empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <AppIcon name="git" size="lg" tone="muted" />
              <p>Выберите файл или коммит, чтобы увидеть изменения</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
