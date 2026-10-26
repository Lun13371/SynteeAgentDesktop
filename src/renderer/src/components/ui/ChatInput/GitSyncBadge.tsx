import { useState, useRef, useEffect, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import type { GitSyncProjectState } from '../../../../../shared/types'

interface GitSyncBadgeProps {
  projects: GitSyncProjectState[]
  onApply: (projectId: string) => Promise<void>
  onLater: (projectId: string) => void
  onOpenGit: (projectId: string) => void
}

export function GitSyncBadge({ projects, onApply, onLater, onOpenGit }: GitSyncBadgeProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState<string | null>(null)
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({})
  const wrapRef = useRef<HTMLDivElement>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelClose = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimerRef.current = setTimeout(() => setOpen(false), 180)
  }
  const positionPopover = () => {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(430, window.innerWidth - 32)
    setPopoverStyle({
      left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)),
      bottom: Math.max(16, window.innerHeight - rect.top + 6),
      width,
    })
  }
  useEffect(() => {
    if (!open) return
    positionPopover()
    const onResize = () => positionPopover()
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
    }
  }, [open, projects.length])
  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
  }, [])

  if (projects.length === 0) return null

  const commitCount = projects.reduce((sum, project) => sum + project.commits.length, 0)
  const diverged = projects.some(project => project.diverged)
  const label = diverged ? 'Git ↕' : `Git ↑ ${commitCount}`

  const apply = async (projectId: string) => {
    setLoading(projectId)
    try { await onApply(projectId) } finally { setLoading(null) }
  }

  return (
    <div
      ref={wrapRef}
      className="chat-input-git-sync-wrap"
      onMouseEnter={() => { cancelClose(); if (!open) { positionPopover(); setOpen(true) } }}
      onMouseLeave={scheduleClose}
    >
      <motion.button
        className={`chat-input-git-sync-badge${diverged ? ' chat-input-git-sync-badge--danger' : ''}`}
        initial={{ opacity: 0, y: 6, scale: 0.9 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 6, scale: 0.9 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => { cancelClose(); positionPopover(); setOpen(true) }}
        title="Доступны удалённые Git-коммиты"
      >
        <AppIcon name={diverged ? 'alertCircle' : 'git'} size="xs" />
        <span>{label}</span>
      </motion.button>
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              className="chat-input-git-sync-popover"
              style={popoverStyle}
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              onMouseEnter={cancelClose}
              onMouseLeave={scheduleClose}
            >
            <div className="chat-input-git-sync-popover-header">
              <AppIcon name="git" size="xs" />
              <span>Удалённые обновления</span>
              <span className="chat-input-git-sync-count">{commitCount}</span>
            </div>
            <div className="chat-input-git-sync-projects">
            {projects.map(project => (
              <div className="chat-input-git-sync-project" key={project.projectId}>
                <div className="chat-input-git-sync-project-head">
                  <strong>{project.projectName}</strong>
                  <span>{project.branch} ← {project.upstream}</span>
                </div>
                {project.diverged && <div className="chat-input-git-sync-warning">Ветки разошлись — автоматическое применение отключено.</div>}
                <div className="chat-input-git-sync-commits">
                  {project.commits.slice(0, 5).map(commit => (
                    <div className="chat-input-git-sync-commit" key={commit.hash}>
                      <code>{commit.shortHash}</code>
                      <span title={commit.message}>{commit.message}</span>
                    </div>
                  ))}
                  {project.commits.length > 5 && <span className="chat-input-git-sync-more">и ещё {project.commits.length - 5}</span>}
                </div>
                <div className="chat-input-git-sync-actions">
                  {!project.diverged && (
                    <button onClick={() => void apply(project.projectId)} disabled={loading === project.projectId}>
                      <AppIcon name={loading === project.projectId ? 'loader' : 'downloadCloud'} size="xs" animation={loading === project.projectId ? 'spin' : undefined} />
                      Применить
                    </button>
                  )}
                  <button onClick={() => { onLater(project.projectId); setOpen(false) }}>
                    <AppIcon name="clock" size="xs" /> Позже
                  </button>
                  <button onClick={() => { onOpenGit(project.projectId); setOpen(false) }}>
                    <AppIcon name="git" size="xs" /> Git-панель
                  </button>
                </div>
              </div>
            ))}
            </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  )
}
