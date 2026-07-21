import { useState, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import CodePreview from '../CodePreview/CodePreview'
import './FileExplorer.css'

interface FsEntry {
  name: string
  path: string
  relPath: string
  isDir: boolean
  isSymlink: boolean
  size: number
  mtime: number
}

interface FileExplorerProps {
  workdir: string | null
}

interface FilePreview {
  relPath: string
  content: string
  truncated: boolean
  size: number
  error?: string
  isBinary?: boolean
  loading: boolean
}

export default function FileExplorer({ workdir }: FileExplorerProps) {
  const [tree, setTree] = useState<Record<string, FsEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']))
  const [loadingDir, setLoadingDir] = useState<Set<string>>(new Set())
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const previewAbortRef = useRef<AbortController | null>(null)
  // NOTE: сброс состояния при смене workdir выполняется через key prop
  // в RightPanel — React полностью перемонтирует компонент.

  const loadDir = useCallback(async (relPath: string) => {
    if (!workdir) return
    setLoadingDir(prev => new Set(prev).add(relPath))
    try {
      const result = await window.syntee.fs.listDirectory({ root: workdir, relPath }) as
        { success: boolean; entries: FsEntry[]; error?: string }
      if (!result.success) {
        setError(result.error ?? 'Failed to load directory')
        setTree(prev => ({ ...prev, [relPath]: [] }))
      } else {
        setTree(prev => ({ ...prev, [relPath]: result.entries }))
        setError(null)
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
      setTree(prev => ({ ...prev, [relPath]: [] }))
    } finally {
      setLoadingDir(prev => {
        const next = new Set(prev)
        next.delete(relPath)
        return next
      })
    }
  }, [workdir])

  // Загрузка корня при монтировании
  useEffect(() => {
    if (workdir && !tree['']) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadDir('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workdir])

  const toggleDir = useCallback((relPath: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(relPath)) {
        next.delete(relPath)
      } else {
        next.add(relPath)
      }
      return next
    })
    if (!tree[relPath]) {
      loadDir(relPath)
    }
  }, [tree, loadDir])

  const openFile = useCallback(async (entry: FsEntry) => {
    if (!workdir) return
    // Отменяем предыдущую загрузку
    if (previewAbortRef.current) {
      previewAbortRef.current.abort()
    }
    const controller = new AbortController()
    previewAbortRef.current = controller

    setSelectedFile(entry.relPath)
    setPreview({
      relPath: entry.relPath,
      content: '',
      truncated: false,
      size: entry.size,
      loading: true,
    })

    try {
      const result = await window.syntee.fs.readFile({ root: workdir, relPath: entry.relPath }) as
        { success: boolean; content: string; truncated: boolean; size: number; error?: string; isBinary?: boolean }
      if (controller.signal.aborted) return
      if (!result.success) {
        setPreview({
          relPath: entry.relPath,
          content: '',
          truncated: false,
          size: entry.size,
          error: result.error,
          isBinary: result.isBinary,
          loading: false,
        })
      } else {
        setPreview({
          relPath: entry.relPath,
          content: result.content,
          truncated: result.truncated,
          size: result.size,
          loading: false,
        })
      }
    } catch (e) {
      if (controller.signal.aborted) return
      setPreview({
        relPath: entry.relPath,
        content: '',
        truncated: false,
        size: entry.size,
        error: String((e as Error)?.message ?? e),
        loading: false,
      })
    }
  }, [workdir])

  // Очистка abort при размонтировании
  useEffect(() => {
    return () => {
      if (previewAbortRef.current) previewAbortRef.current.abort()
    }
  }, [])

  if (!workdir) {
    return (
      <div className="file-explorer file-explorer--empty">
        <AppIcon name="folder" size="lg" tone="muted" />
        <p>Нет рабочей директории</p>
        <p className="file-explorer__hint">Выберите проект с рабочей папкой, чтобы просматривать файлы</p>
      </div>
    )
  }

  if (error && Object.keys(tree).length === 0) {
    return (
      <div className="file-explorer file-explorer--empty">
        <AppIcon name="x" size="lg" tone="danger" />
        <p>Не удалось загрузить файлы</p>
        <p className="file-explorer__hint">{error}</p>
        <button className="file-explorer__retry" onClick={() => loadDir('')}>
          <AppIcon name="refreshCw" size="xs" /> Повторить
        </button>
      </div>
    )
  }

  const rootName = workdir.split(/[\\/]/).pop() || workdir

  return (
    <div className="file-explorer">
      <div className="file-explorer__tree">
        <div className="file-explorer__tree-header">
          <AppIcon name="folder" size="xs" />
          <span className="file-explorer__root-name" title={workdir}>{rootName}</span>
          <button
            className="file-explorer__refresh"
            title="Обновить"
            onClick={() => {
              setTree({})
              loadDir('')
            }}
          >
            <AppIcon name="refreshCw" size="xs" />
          </button>
        </div>
        <div className="file-explorer__tree-body">
          <FileTreeNode
            relPath=""
            name={rootName}
            isDir
            depth={0}
            tree={tree}
            expanded={expanded}
            loadingDir={loadingDir}
            selectedFile={selectedFile}
            onToggleDir={toggleDir}
            onOpenFile={openFile}
            onLoadDir={loadDir}
          />
        </div>
      </div>
      <div className="file-explorer__preview">
        <AnimatePresence mode="wait">
          {preview && (
            <motion.div
              key={preview.relPath}
              className="file-explorer__preview-content"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
            >
              <div className="file-explorer__preview-header">
                <AppIcon name="fileText" size="xs" />
                <span className="file-explorer__preview-path" title={preview.relPath}>{preview.relPath}</span>
                {preview.size > 0 && (
                  <span className="file-explorer__preview-size">
                    {(preview.size / 1024).toFixed(1)} KB
                  </span>
                )}
              </div>
              <div className="file-explorer__preview-body">
                {preview.loading ? (
                  <div className="file-explorer__preview-loading">
                    <AppIcon name="loader" size="sm" animation="spin" />
                    <span>Загрузка...</span>
                  </div>
                ) : preview.error ? (
                  <div className="file-explorer__preview-error">
                    {preview.isBinary ? (
                      <>
                        <AppIcon name="fileText" size="lg" tone="muted" />
                        <p>Бинарный файл</p>
                        <span>{(preview.size / 1024).toFixed(1)} KB</span>
                      </>
                    ) : (
                      <>
                        <AppIcon name="x" size="lg" tone="danger" />
                        <p>{preview.error}</p>
                      </>
                    )}
                  </div>
                ) : (
                  <CodePreview
                    content={preview.content}
                    path={preview.relPath}
                    truncated={preview.truncated}
                    maxHeight="100%"
                  />
                )}
              </div>
            </motion.div>
          )}
          {!preview && (
            <motion.div
              key="empty"
              className="file-explorer__preview-empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <AppIcon name="fileText" size="lg" tone="muted" />
              <p>Выберите файл для просмотра</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

interface FileTreeNodeProps {
  relPath: string
  name: string
  isDir: boolean
  depth: number
  tree: Record<string, FsEntry[]>
  expanded: Set<string>
  loadingDir: Set<string>
  selectedFile: string | null
  onToggleDir: (relPath: string) => void
  onOpenFile: (entry: FsEntry) => void
  onLoadDir: (relPath: string) => void
}

function FileTreeNode({
  relPath, name, isDir, depth, tree, expanded, loadingDir, selectedFile, onToggleDir, onOpenFile,
}: FileTreeNodeProps) {
  const isOpen = expanded.has(relPath)
  const entries = tree[relPath]
  const isLoading = loadingDir.has(relPath)

  return (
    <div className="file-tree-node">
      <button
        className={`file-tree-item ${!isDir && selectedFile === relPath ? 'file-tree-item--selected' : ''}`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={() => {
          if (isDir) onToggleDir(relPath)
          else onOpenFile({ name, path: '', relPath, isDir: false, isSymlink: false, size: 0, mtime: 0 })
        }}
      >
        {isDir ? (
          <>
            <AppIcon
              name={isOpen ? 'chevronDown' : 'chevronRight'}
              size="xs"
              tone="muted"
            />
            <AppIcon
              name={isOpen ? 'folder' : 'folder'}
              size="xs"
              tone="accent"
            />
          </>
        ) : (
          <>
            <span className="file-tree-item__spacer" />
            <AppIcon name="fileText" size="xs" tone="muted" />
          </>
        )}
        <span className="file-tree-item__name" title={name}>{name}</span>
        {isLoading && <AppIcon name="loader" size="xs" animation="spin" />}
      </button>

      <AnimatePresence initial={false}>
        {isDir && isOpen && entries && (
          <motion.div
            className="file-tree-node__children"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            {entries.length === 0 && !isLoading ? (
              <div className="file-tree-empty" style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}>
                Пусто
              </div>
            ) : (
              entries.map(child => (
                <FileTreeNode
                  key={child.relPath}
                  relPath={child.relPath}
                  name={child.name}
                  isDir={child.isDir}
                  depth={depth + 1}
                  tree={tree}
                  expanded={expanded}
                  loadingDir={loadingDir}
                  selectedFile={selectedFile}
                  onToggleDir={onToggleDir}
                  onOpenFile={onOpenFile}
                  onLoadDir={() => {}}
                />
              ))
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
