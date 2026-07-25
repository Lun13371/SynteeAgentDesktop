import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import type { Chat, Project, Message } from '../../../../../shared/types'
import AppIcon from '../../ui/AppIcon/AppIcon'
import IconButton from '../../ui/IconButton/IconButton'
import ChatContextMenu, { type ContextMenuPos } from '../../ui/ChatContextMenu/ChatContextMenu'
import ExtensionsPopover from '../../ui/ExtensionsPopover/ExtensionsPopover'
import { ProjectIndexModal } from '../../ui/ProjectIndexModal/ProjectIndexModal'
import { useChatStore } from '../../../store/chat.store'
import './Sidebar.css'

interface SidebarProps {
  chats?: Chat[]
  projects?: Project[]
  activeProjectId?: string | null
  currentChatId?: string | null
  onSelectChat?: (id: string) => void
  onNewChat?: (projectId?: string) => void
  onNewChatWithoutProject?: () => void
  onNewProject?: (mode: 'empty' | 'existing') => void
  onChatsUpdate?: (chats: Chat[]) => void
  onProjectsUpdate?: (projects: Project[]) => void
  onSelectProject?: (id: string | null) => void
  /** Вызывается после установки MCP/Skill через маркетплейс — открывает новый чат установки. */
  onExtensionInstalled?: (chatId: string, projectId: string | undefined, userMsg: Message) => void
}

type ChatFilter = 'all' | 'projects' | 'favorites' | 'archive'

const CHAT_FILTERS: { value: ChatFilter; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'projects', label: 'Проекты' },
  { value: 'favorites', label: 'Избранные' },
  { value: 'archive', label: 'Архив' },
]

function formatTime(ts: number): string {
  if (!ts || ts < 1000000) return ''
  const now = Date.now()
  const diff = now - ts
  const D = 86400000
  if (diff < D) return new Date(ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
  if (diff < 7 * D) return new Date(ts).toLocaleDateString('ru', { weekday: 'short' })
  return new Date(ts).toLocaleDateString('ru', { day: 'numeric', month: 'short' })
}

function cleanPreview(text: string | undefined): string {
  if (!text) return ''
  return text
    .replace(/```[\s\S]*?```/g, '[код]')
    .replace(/`[^`]+`/g, '[код]')
    .replace(/#{1,6}\s/g, '')
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, 60)
}

function shortWorkdir(workdir: string): string {
  const segs = workdir.split(/[\\/]/).filter(Boolean)
  if (segs.length <= 2) return segs.join(' / ')
  return '… / ' + segs.slice(-2).join(' / ')
}

export default function Sidebar({
  chats = [],
  projects = [],
  activeProjectId = null,
  currentChatId,
  onSelectChat,
  onNewChat,
  onNewChatWithoutProject,
  onNewProject,
  onChatsUpdate,
  onProjectsUpdate,
  onSelectProject,
  onExtensionInstalled,
}: SidebarProps) {
  const [search, setSearch] = useState('')
  const [chatFilter, setChatFilter] = useState<ChatFilter>('all')
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set())
  const [ctxMenu, setCtxMenu] = useState<{ chat: Chat; pos: ContextMenuPos } | null>(null)
  const [projectCtxMenu, setProjectCtxMenu] = useState<{ project: Project; pos: ContextMenuPos } | null>(null)
  const projectCtxRef = useRef<HTMLDivElement>(null)
  const [newProjectMenu, setNewProjectMenu] = useState<ContextMenuPos | null>(null)
  const newProjectMenuRef = useRef<HTMLDivElement>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null)
  const [renameProjectVal, setRenameProjectVal] = useState('')
  const [editingVerifyCmdId, setEditingVerifyCmdId] = useState<string | null>(null)
  const [verifyCmdVal, setVerifyCmdVal] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)
  const renameProjectRef = useRef<HTMLInputElement>(null)
  const verifyCmdRef = useRef<HTMLInputElement>(null)
  const [extPopoverOpen, setExtPopoverOpen] = useState(false)
  const [indexModalProject, setIndexModalProject] = useState<{ id: string; name: string } | null>(null)

  // Статусы запусков чатов для индикаторов (spinner/✓/✗). Подписываемся на
  // весь объект — Sidebar не большой, ре-рендер недорогой. Альтернатива
  // (useSyncExternalStore + selector на каждый chatId) усложняет код.
  const runStatusByChat = useChatStore(s => s.runStatusByChat)
  const unreadStatusByChat = useChatStore(s => s.unreadStatusByChat)
  const dropChatState = useChatStore(s => s.dropChatState)

  useEffect(() => {
    const off = window.syntee.on('chat:renamed', ({ chatId, title }: { chatId: string; title: string }) => {
      onChatsUpdate?.(chats.map(c => c.id === chatId ? { ...c, title } : c))
    })
    return () => off()
  }, [chats, onChatsUpdate])

  useEffect(() => { if (renamingId) renameRef.current?.focus() }, [renamingId])
  useEffect(() => { if (renamingProjectId) renameProjectRef.current?.focus() }, [renamingProjectId])
  useEffect(() => { if (editingVerifyCmdId) verifyCmdRef.current?.focus() }, [editingVerifyCmdId])

  // Закрытие контекстного меню проекта по клику вне его
  useEffect(() => {
    if (!projectCtxMenu) return
    const handler = (e: MouseEvent) => {
      if (projectCtxRef.current && !projectCtxRef.current.contains(e.target as Node)) {
        setProjectCtxMenu(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [projectCtxMenu])

  // Закрытие меню «Новый проект» по клику вне его. Клик по самой кнопке +/—
  // обрабатывается отдельно (через data-атрибут), чтобы не закрывать тут же.
  useEffect(() => {
    if (!newProjectMenu) return
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('[data-new-project-btn]')) return
      if (newProjectMenuRef.current && !newProjectMenuRef.current.contains(t)) {
        setNewProjectMenu(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [newProjectMenu])

  // Фильтрация по поиску + активному селектору (Все/Проекты/Избранные/Архив).
  // archive-чаты по умолчанию скрыты (filter = 'all' показывает только не-архивные);
  // для просмотра архива пользователь явно выбирает «Архив».
  const searchLower = search.toLowerCase()
  const matchesSearch = (c: Chat) => !search || c.title.toLowerCase().includes(searchLower)
  const matchesFilter = (c: Chat) => {
    switch (chatFilter) {
      case 'all':       return !c.isArchived
      case 'projects':  return !c.isArchived && !!c.projectId
      case 'favorites': return !!c.isPinned && !c.isArchived
      case 'archive':   return !!c.isArchived
    }
  }

  // Чаты по проектам
  const chatsByProject = (projectId: string | null) =>
    chats.filter(c => (c.projectId ?? null) === projectId && matchesFilter(c) && matchesSearch(c))

  const projectChats = (p: Project) => chatsByProject(p.id)
  const noProjectChats = chatsByProject(null)

  // Для режимов «Избранные» и «Архив» группировка по проектам избыточна —
  // показываем плоский список.
  const flatChats = chatFilter === 'favorites' || chatFilter === 'archive'
    ? chats.filter(c => matchesFilter(c) && matchesSearch(c))
    : []

  const toggleCollapse = (id: string) => {
    setCollapsedProjects(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCtx = (e: React.MouseEvent, chat: Chat) => {
    e.preventDefault(); e.stopPropagation()
    setCtxMenu({ chat, pos: { x: e.clientX, y: e.clientY } })
  }

  const handleProjectCtx = (e: React.MouseEvent, project: Project) => {
    e.preventDefault(); e.stopPropagation()
    setProjectCtxMenu({ project, pos: { x: e.clientX, y: e.clientY } })
  }

  const handleRename = async (chat: Chat) => {
    setRenamingId(chat.id); setRenameVal(chat.title)
  }

  const commitRename = async (chatId: string) => {
    if (renameVal.trim()) {
      await window.syntee.chat.rename(chatId, renameVal.trim())
      onChatsUpdate?.(chats.map(c => c.id === chatId ? { ...c, title: renameVal.trim() } : c))
    }
    setRenamingId(null)
  }

  const handlePin = async (chat: Chat) => {
    const updated = await window.syntee.chat.pinChat(chat.id, !chat.isPinned) as Chat[]
    onChatsUpdate?.(updated)
  }

  const handleArchive = async (chat: Chat) => {
    const updated = await window.syntee.chat.archive(chat.id, !chat.isArchived) as Chat[]
    onChatsUpdate?.(updated)
    if (chat.id === currentChatId) onSelectChat?.(updated.find(c => !c.isArchived)?.id ?? '')
  }

  const handleDuplicate = async (chat: Chat) => {
    await window.syntee.chat.duplicate(chat.id)
    const updated = await window.syntee.chat.getAll() as Chat[]
    onChatsUpdate?.(updated)
  }

  const handleDelete = async (chat: Chat) => {
    await window.syntee.chat.delete(chat.id)
    // Чистим live-state и статусы удалённого чата из store
    dropChatState(chat.id)
    const updated = await window.syntee.chat.getAll() as Chat[]
    onChatsUpdate?.(updated)
    if (chat.id === currentChatId) onSelectChat?.(updated[0]?.id ?? '')
  }

  const handleExport = async (chat: Chat, fmt: 'txt' | 'md') => {
    const content = await window.syntee.chat.export(chat.id, fmt) as string
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${chat.title}.${fmt}`; a.click()
    URL.revokeObjectURL(url)
  }

  const handleColor = async (chat: Chat, color: string | null) => {
    await window.syntee.chat.setColor(chat.id, color)
    onChatsUpdate?.(chats.map(c => c.id === chat.id ? { ...c, color: color ?? undefined } : c))
  }

  // ── Project actions ──
  const handleProjectRename = (project: Project) => {
    setRenamingProjectId(project.id); setRenameProjectVal(project.name)
  }

  const commitProjectRename = async (projectId: string) => {
    if (renameProjectVal.trim()) {
      await window.syntee.projects.rename(projectId, renameProjectVal.trim())
      onProjectsUpdate?.(projects.map(p => p.id === projectId ? { ...p, name: renameProjectVal.trim() } : p))
    }
    setRenamingProjectId(null)
  }

  const handleProjectDelete = async (project: Project) => {
    if (!confirm(`Удалить проект «${project.name}»? Чаты останутся, но перейдут в «Без проекта».`)) return
    await window.syntee.projects.delete(project.id)
    const updated = await window.syntee.projects.getAll() as Project[]
    onProjectsUpdate?.(updated)
    if (activeProjectId === project.id) onSelectProject?.(null)
  }

  const handleProjectOpenFolder = (project: Project) => {
    window.syntee.shell.openPath(project.workdir)
  }

  const handleEditVerifyCmd = (project: Project) => {
    setEditingVerifyCmdId(project.id); setVerifyCmdVal(project.verificationCommand ?? '')
  }

  const commitVerifyCmd = async (projectId: string) => {
    const value = verifyCmdVal.trim() || null
    await window.syntee.projects.setVerificationCommand(projectId, value)
    onProjectsUpdate?.(projects.map(p => p.id === projectId ? { ...p, verificationCommand: value ?? undefined } : p))
    setEditingVerifyCmdId(null)
  }

  const renderChatItem = (chat: Chat) => {
    // Индикатор статуса запуска: spinner пока агент работает, бейдж ✓/✗ после.
    // Бейдж исчезает при открытии чата (markChatRead в selectChat).
    const status = runStatusByChat[chat.id]?.status
    const unread = unreadStatusByChat[chat.id]
    return (
    <motion.div
      key={chat.id}
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
    >
      {renamingId === chat.id ? (
        <div className="sidebar-rename">
          <input
            ref={renameRef}
            className="sidebar-rename-input"
            value={renameVal}
            onChange={e => setRenameVal(e.target.value)}
            onBlur={() => commitRename(chat.id)}
            onKeyDown={e => {
              if (e.key === 'Enter') commitRename(chat.id)
              if (e.key === 'Escape') setRenamingId(null)
            }}
          />
        </div>
      ) : (
        <button
          className={`sidebar-chat-item ${currentChatId === chat.id ? 'sidebar-chat-item--active' : ''}`}
          onClick={() => onSelectChat?.(chat.id)}
          onContextMenu={e => handleCtx(e, chat)}
        >
          {chat.color && (
            <span className="sidebar-chat-color" style={{ background: chat.color }} />
          )}
          <div className="sidebar-chat-content">
            <div className="sidebar-chat-title">
              {!!chat.isPinned && <AppIcon name="pin" size="xs" tone="accent" />}
              <span className="sidebar-chat-title-text">{chat.title}</span>
            </div>
            {chat.lastMessage && cleanPreview(chat.lastMessage) && (
              <div className="sidebar-chat-preview">
                {cleanPreview(chat.lastMessage)}
              </div>
            )}
          </div>
          <div className="sidebar-chat-meta">
            {/* Индикатор статуса агента: spinner (работает) или бейдж ✓/✗ (завершено, непрочитано) */}
            {(status === 'running' || status === 'queued') && (
              <span className="sidebar-chat-spinner" title={status === 'queued' ? 'В очереди' : 'Работает'} />
            )}
            {unread === 'done' && (
              <span className="sidebar-chat-status sidebar-chat-status--done" title="Завершено">
                <AppIcon name="check" size="xs" tone="accent" />
              </span>
            )}
            {unread === 'error' && (
              <span className="sidebar-chat-status sidebar-chat-status--error" title="Ошибка">
                <AppIcon name="x" size="xs" />
              </span>
            )}
            {unread === 'cancelled' && (
              <span className="sidebar-chat-status sidebar-chat-status--cancelled" title="Отменено">
                <AppIcon name="minus" size="xs" />
              </span>
            )}
            <span className="sidebar-chat-time">
              {formatTime(chat.updatedAt)}
            </span>
          </div>
        </button>
      )}
    </motion.div>
    )
  }

  const renderProject = (project: Project) => {
    const items = projectChats(project)
    const isCollapsed = collapsedProjects.has(project.id)
    const isActive = activeProjectId === project.id
    return (
      <div key={project.id} className={`sidebar-project ${isActive ? 'sidebar-project--active' : ''}`}>
        <div
          className="sidebar-project-header"
          onClick={() => onSelectProject?.(project.id)}
          onContextMenu={e => handleProjectCtx(e, project)}
        >
          <button
            className="sidebar-project-chevron"
            onClick={(e) => { e.stopPropagation(); toggleCollapse(project.id) }}
            title={isCollapsed ? 'Развернуть' : 'Свернуть'}
          >
            <AppIcon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size="xs" />
          </button>
          <AppIcon name="folder" size="xs" tone={isActive ? 'accent' : 'default'} />
          {renamingProjectId === project.id ? (
            <input
              ref={renameProjectRef}
              className="sidebar-project-rename-input"
              value={renameProjectVal}
              onChange={e => setRenameProjectVal(e.target.value)}
              onClick={e => e.stopPropagation()}
              onBlur={() => commitProjectRename(project.id)}
              onKeyDown={e => {
                if (e.key === 'Enter') commitProjectRename(project.id)
                if (e.key === 'Escape') setRenamingProjectId(null)
              }}
            />
          ) : (
            <span className="sidebar-project-name" title={project.workdir}>{project.name}</span>
          )}
          <button
            className="sidebar-project-add"
            onClick={(e) => { e.stopPropagation(); onNewChat?.(project.id) }}
            title="Новый чат в проекте"
          >
            <AppIcon name="plus" size="xs" />
          </button>
        </div>
        <div className="sidebar-project-workdir" title={project.workdir}>
          {shortWorkdir(project.workdir)}
        </div>
        {editingVerifyCmdId === project.id ? (
          <input
            ref={verifyCmdRef}
            className="sidebar-project-verifycmd-input"
            placeholder="Команда проверки, напр. npm test"
            value={verifyCmdVal}
            onChange={e => setVerifyCmdVal(e.target.value)}
            onClick={e => e.stopPropagation()}
            onBlur={() => commitVerifyCmd(project.id)}
            onKeyDown={e => {
              if (e.key === 'Enter') commitVerifyCmd(project.id)
              if (e.key === 'Escape') setEditingVerifyCmdId(null)
            }}
          />
        ) : project.verificationCommand ? (
          <div className="sidebar-project-verifycmd" title={project.verificationCommand}>
            ✓ {project.verificationCommand}
          </div>
        ) : null}
        <AnimatePresence initial={false}>
          {!isCollapsed && (
            <motion.div
              className="sidebar-project-chats"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {items.length === 0 && (
                <div className="sidebar-project-empty">Нет чатов</div>
              )}
              {items.map(renderChatItem)}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    )
  }

  const hasAnyChats = chats.filter(c => !c.isArchived).length > 0

  return (
    <aside className="sidebar">
      {/* Шапка */}
      <div className="sidebar-header">
        <span className="sidebar-title">Проекты</span>
        <div className="sidebar-header-actions">
          <IconButton
            icon="messageSquare"
            label="Новый чат без проекта"
            onClick={() => onNewChatWithoutProject?.()}
          />
          <IconButton
            icon="plus"
            label="Новый проект"
            data-new-project-btn
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
              // Меню шириной 240 — прижимаем к правому краю кнопки
              const menuW = 240
              setNewProjectMenu({ x: Math.max(8, rect.right - menuW), y: rect.bottom + 4 })
            }}
          />
        </div>
      </div>

      {/* Расширения (MCP и Skills) — отдельная широкая кнопка на всю ширину. */}
      <button
        type="button"
        className="sidebar-extensions-btn"
        data-extensions-btn
        onClick={() => setExtPopoverOpen(true)}
      >
        <span className="sidebar-extensions-btn-icon">
          <AppIcon name="puzzle" size="sm" />
        </span>
        <span className="sidebar-extensions-btn-label">Расширения</span>
        <span className="sidebar-extensions-btn-sub">MCP и Skills</span>
        <AppIcon name="chevronRight" size="xs" className="sidebar-extensions-btn-chevron" />
      </button>

      {/* Поиск */}
      <div className="sidebar-search">
        <AppIcon name="search" size="xs" />
        <input
          className="sidebar-search-input"
          placeholder="Поиск чатов..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {search && (
          <button className="sidebar-search-clear" onClick={() => setSearch('')}>
            <AppIcon name="x" size="xs" />
          </button>
        )}
      </div>

      {/* Селектор: какие чаты показывать */}
      <div className="sidebar-filter">
        {CHAT_FILTERS.map(f => (
          <button
            key={f.value}
            className={`sidebar-filter-btn ${chatFilter === f.value ? 'sidebar-filter-btn--active' : ''}`}
            onClick={() => setChatFilter(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Список */}
      <div className="sidebar-list">
        {chatFilter === 'favorites' || chatFilter === 'archive' ? (
          flatChats.length === 0 ? (
            <div className="sidebar-empty">
              {search ? 'Ничего не найдено' : chatFilter === 'favorites' ? 'Нет избранных чатов' : 'Архив пуст'}
            </div>
          ) : (
            flatChats.map(renderChatItem)
          )
        ) : (
          <>
            {projects.length === 0 && noProjectChats.length === 0 && (
              <div className="sidebar-empty">
                {search ? 'Ничего не найдено' : 'Нет проектов. Нажмите + чтобы создать.'}
              </div>
            )}

            {projects.map(renderProject)}

            {/* Без проекта — чаты без project_id (старые, инкогнито).
                Скрываем в режиме «Проекты», чтобы не было пустой группы. */}
            {chatFilter !== 'projects' && noProjectChats.length > 0 && (
              <div className="sidebar-project sidebar-project--noproject">
                <div
                  className="sidebar-project-header"
                  onClick={() => onSelectProject?.(null)}
                >
                  <button
                    className="sidebar-project-chevron"
                    onClick={(e) => { e.stopPropagation(); toggleCollapse('__noproject__') }}
                  >
                    <AppIcon name={collapsedProjects.has('__noproject__') ? 'chevronRight' : 'chevronDown'} size="xs" />
                  </button>
                  <AppIcon name="layers" size="xs" tone="muted" />
                  <span className="sidebar-project-name">Без проекта</span>
                </div>
                <AnimatePresence initial={false}>
                  {!collapsedProjects.has('__noproject__') && (
                    <motion.div
                      className="sidebar-project-chats"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.15 }}
                    >
                      {noProjectChats.map(renderChatItem)}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}

            {!hasAnyChats && projects.length > 0 && (
              <div className="sidebar-empty sidebar-empty--subtle">
                Создайте чат кнопкой + рядом с проектом
              </div>
            )}
          </>
        )}
      </div>

      <ChatContextMenu
        chat={ctxMenu?.chat ?? null}
        pos={ctxMenu?.pos ?? null}
        onClose={() => setCtxMenu(null)}
        onRename={handleRename}
        onPin={handlePin}
        onArchive={handleArchive}
        onDuplicate={handleDuplicate}
        onExport={handleExport}
        onDelete={handleDelete}
        onColor={handleColor}
      />

      {/* Контекстное меню проекта. Рендерим всегда (без условия), чтобы
          AnimatePresence оставался смонтированным и проигрывал exit-анимацию. */}
      {createProjectContextMenu(projectCtxMenu, projectCtxRef, {
        onClose: () => setProjectCtxMenu(null),
        onRename: handleProjectRename,
        onDelete: handleProjectDelete,
        onOpenFolder: handleProjectOpenFolder,
        onNewChat: (p) => { onNewChat?.(p.id); setProjectCtxMenu(null) },
        onEditVerifyCmd: handleEditVerifyCmd,
        onIndexStatus: (p) => setIndexModalProject({ id: p.id, name: p.name }),
      })}

      {/* Меню «Новый проект»: создать пустой или выбрать существующую папку.
          Тоже всегда смонтировано ради exit-анимации. */}
      {createNewProjectMenu(newProjectMenu, newProjectMenuRef, {
        onClose: () => setNewProjectMenu(null),
        onEmpty: () => { onNewProject?.('empty'); setNewProjectMenu(null) },
        onExisting: () => { onNewProject?.('existing'); setNewProjectMenu(null) },
      })}

      {/* Модальное окно управления расширениями (MCP и Skills). */}
      <ExtensionsPopover
        open={extPopoverOpen}
        projectId={activeProjectId ?? undefined}
        onClose={() => setExtPopoverOpen(false)}
        onInstalled={onExtensionInstalled}
      />

      <ProjectIndexModal
        open={!!indexModalProject}
        projectId={indexModalProject?.id ?? null}
        projectName={indexModalProject?.name}
        onClose={() => setIndexModalProject(null)}
      />
    </aside>
  )
}

// Контекстное меню для проекта — отдельный портал (аналог ChatContextMenu).
// Функция вызывается всегда (даже когда state === null), чтобы AnimatePresence
// оставался смонтированным и проигрывал exit-анимацию при закрытии.
function createProjectContextMenu(
  state: { project: Project; pos: ContextMenuPos } | null,
  ref: React.RefObject<HTMLDivElement>,
  handlers: {
    onClose: () => void
    onRename: (p: Project) => void
    onDelete: (p: Project) => void
    onOpenFolder: (p: Project) => void
    onNewChat: (p: Project) => void
    onEditVerifyCmd: (p: Project) => void
    onIndexStatus: (p: Project) => void
  }
) {
  const project = state?.project
  const pos = state?.pos
  const menuW = 220, menuH = 200
  const left = pos ? Math.min(pos.x, window.innerWidth - menuW - 8) : 0
  const top = pos ? Math.min(pos.y, window.innerHeight - menuH - 8) : 0
  return createPortal(
    <AnimatePresence>
      {project && pos && (
        <motion.div
          ref={ref}
          className="chat-ctx-menu"
          style={{ position: 'fixed', left, top, zIndex: 9999 }}
          initial={{ opacity: 0, scale: 0.95, y: -6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -4 }}
          transition={{ type: 'spring', stiffness: 500, damping: 32 }}
        >
          <button className="ctx-item" onClick={() => { handlers.onNewChat(project); }}>
            <AppIcon name="plus" size="sm" />
            <span>Новый чат здесь</span>
          </button>
          <div className="ctx-divider" />
          <button className="ctx-item" onClick={() => { handlers.onRename(project); handlers.onClose() }}>
            <AppIcon name="edit" size="sm" />
            <span>Переименовать</span>
          </button>
          <button className="ctx-item" onClick={() => { handlers.onOpenFolder(project); handlers.onClose() }}>
            <AppIcon name="folder" size="sm" />
            <span>Открыть папку</span>
          </button>
          <button className="ctx-item" onClick={() => { handlers.onEditVerifyCmd(project); handlers.onClose() }}>
            <AppIcon name="terminal" size="sm" />
            <span>Команда проверки</span>
          </button>
          <button className="ctx-item" onClick={() => { handlers.onIndexStatus(project); handlers.onClose() }}>
            <AppIcon name="database" size="sm" />
            <span>Статус индекса</span>
          </button>
          <div className="ctx-divider" />
          <button className="ctx-item ctx-item--danger" onClick={() => { handlers.onDelete(project); handlers.onClose() }}>
            <AppIcon name="trash" size="sm" />
            <span>Удалить проект</span>
          </button>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}

// Меню «Новый проект»: выбор между созданием пустой папки и выбором
// существующей. Появляется по клику на + в шапке сайдбара.
// Вызывается всегда (даже когда pos === null) ради exit-анимации.
function createNewProjectMenu(
  pos: ContextMenuPos | null,
  ref: React.RefObject<HTMLDivElement>,
  handlers: {
    onClose: () => void
    onEmpty: () => void
    onExisting: () => void
  }
) {
  const menuW = 240, menuH = 96
  const left = pos ? Math.min(pos.x, window.innerWidth - menuW - 8) : 0
  const top = pos ? Math.min(pos.y, window.innerHeight - menuH - 8) : 0
  return createPortal(
    <AnimatePresence>
      {pos && (
        <motion.div
          ref={ref}
          className="chat-ctx-menu"
          style={{ position: 'fixed', left, top, zIndex: 9999 }}
          initial={{ opacity: 0, scale: 0.95, y: -6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -4 }}
          transition={{ type: 'spring', stiffness: 500, damping: 32 }}
        >
          <button className="ctx-item" onClick={handlers.onEmpty}>
            <AppIcon name="plus" size="sm" />
            <span>Создать пустой проект</span>
          </button>
          <button className="ctx-item" onClick={handlers.onExisting}>
            <AppIcon name="folder" size="sm" />
            <span>Выбрать существующую папку</span>
          </button>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
