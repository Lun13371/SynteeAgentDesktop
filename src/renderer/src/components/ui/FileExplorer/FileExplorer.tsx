import { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
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
  truncatedReason?: string
  size: number
  error?: string
  isBinary?: boolean
  loading: boolean
}

// ── Flat node for virtualization ────────────────────────────────────────
// Раньше дерево рендерилось рекурсивно — каждый FileTreeNode получал весь
// tree object + expanded/loadingDir/selectedFile Sets → любая смена состояния
// ре-рендерила ВСЕ видимые ноды. Теперь: flatten в массив, виртуализация через
// useVirtualizer, каждая строка — независимый memo-компонент.
interface FlatNode {
  relPath: string
  name: string
  isDir: boolean
  depth: number
  isOpen: boolean
  isLoading: boolean
  isSelected: boolean
}

function buildFlatTree(
  tree: Record<string, FsEntry[]>,
  expanded: Set<string>,
  loadingDir: Set<string>,
  selectedFile: string | null,
  rootName: string,
): FlatNode[] {
  const result: FlatNode[] = []
  const walk = (relPath: string, name: string, isDir: boolean, depth: number) => {
    result.push({
      relPath,
      name,
      isDir,
      depth,
      isOpen: expanded.has(relPath),
      isLoading: loadingDir.has(relPath),
      isSelected: !isDir && selectedFile === relPath,
    })
    if (isDir && expanded.has(relPath)) {
      const entries = tree[relPath]
      if (entries) {
        for (const child of entries) {
          walk(child.relPath, child.name, child.isDir, depth + 1)
        }
      }
    }
  }
  walk('', rootName, true, 0)
  return result
}

export default function FileExplorer({ workdir }: FileExplorerProps) {
  const [tree, setTree] = useState<Record<string, FsEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']))
  const [loadingDir, setLoadingDir] = useState<Set<string>>(new Set())
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const previewAbortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // treeRef — чтобы toggleDir не зависел от tree в deps (стабильный callback).
  const treeRef = useRef(tree)
  treeRef.current = tree

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
    if (workdir && !treeRef.current['']) {
      loadDir('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workdir])

  // Стабильный toggleDir — не пересоздаётся при каждом обновлении tree.
  const toggleDir = useCallback((relPath: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(relPath)) next.delete(relPath)
      else next.add(relPath)
      return next
    })
    if (!treeRef.current[relPath]) {
      loadDir(relPath)
    }
  }, [loadDir])

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
        { success: boolean; content: string; truncated: boolean; truncatedReason?: string; size: number; error?: string; isBinary?: boolean }
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
          truncatedReason: result.truncatedReason,
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

  const rootName = workdir ? (workdir.split(/[\\/]/).pop() || workdir) : ''

  // Flat tree для виртуализации — пересчитывается только при смене
  // tree/expanded/loadingDir/selectedFile.
  const flatNodes = useMemo(
    () => workdir ? buildFlatTree(tree, expanded, loadingDir, selectedFile, rootName) : [],
    [tree, expanded, loadingDir, selectedFile, rootName, workdir],
  )

  const virtualizer = useVirtualizer({
    count: flatNodes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 6,
  })

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
        <div className="file-explorer__tree-body" ref={scrollRef}>
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map(vi => {
              const node = flatNodes[vi.index]
              return (
                <div
                  key={node.relPath || '__root__'}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    transform: `translateY(${vi.start}px)`,
                    width: '100%',
                    height: vi.size,
                  }}
                >
                  <FileTreeRow
                    node={node}
                    onToggleDir={toggleDir}
                    onOpenFile={openFile}
                  />
                </div>
              )
            })}
          </div>
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
                    truncatedReason={preview.truncatedReason}
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

// ── FileTreeRow — одна строка дерева, memo-изирована ────────────────────
// Props — примитивы + стабильные callbacks → memo эффективно пропускает
// ре-рендер когда конкретная строка не изменилась.
interface FileTreeRowProps {
  node: FlatNode
  onToggleDir: (relPath: string) => void
  onOpenFile: (entry: FsEntry) => void
}

const FileTreeRow = memo(function FileTreeRow({ node, onToggleDir, onOpenFile }: FileTreeRowProps) {
  const { relPath, name, isDir, depth, isOpen, isLoading, isSelected } = node

  return (
    <button
      className={`file-tree-item ${isSelected ? 'file-tree-item--selected' : ''}`}
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
  )
})
