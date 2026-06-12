import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { Chat } from '../../../../../shared/types'
import AppIcon from '../../ui/AppIcon/AppIcon'
import IconButton from '../../ui/IconButton/IconButton'
import ChatContextMenu, { type ContextMenuPos } from '../../ui/ChatContextMenu/ChatContextMenu'
import './Sidebar.css'

interface SidebarProps {
  chats?: Chat[]
  currentChatId?: string | null
  onSelectChat?: (id: string) => void
  onNewChat?: () => void
  onChatsUpdate?: (chats: Chat[]) => void
}

type FilterMode = 'all' | 'pinned' | 'archived'

function groupChatsByTime(chats: Chat[]) {
  const now = Date.now()
  const D = 86400000
  const groups: Record<string, Chat[]> = {
    'Закреплённые': [], 'Сегодня': [], 'Вчера': [], 'Эта неделя': [],
    'Этот месяц': [], 'Раньше': []
  }
  for (const c of chats) {
    if (c.isPinned) { groups['Закреплённые'].push(c); continue }
    const diff = now - c.updatedAt
    if (diff < D)         groups['Сегодня'].push(c)
    else if (diff < 2*D)  groups['Вчера'].push(c)
    else if (diff < 7*D)  groups['Эта неделя'].push(c)
    else if (diff < 30*D) groups['Этот месяц'].push(c)
    else                  groups['Раньше'].push(c)
  }
  return Object.entries(groups).filter(([, v]) => v.length > 0)
}

export default function Sidebar({ chats = [], currentChatId, onSelectChat, onNewChat, onChatsUpdate }: SidebarProps) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterMode>('all')
  const [ctxMenu, setCtxMenu] = useState<{ chat: Chat; pos: ContextMenuPos } | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)

  // Слушаем chat:renamed
  useEffect(() => {
    const off = window.syntee.on('chat:renamed', ({ chatId, title }: { chatId: string; title: string }) => {
      onChatsUpdate?.(chats.map(c => c.id === chatId ? { ...c, title } : c))
    })
    return () => off()
  }, [chats, onChatsUpdate])

  useEffect(() => {
    if (renamingId) renameRef.current?.focus()
  }, [renamingId])

  // Фильтрация
  const filtered = chats.filter(c => {
    if (filter === 'pinned')   return c.isPinned && !c.isArchived
    if (filter === 'archived') return !!c.isArchived
    return !c.isArchived
  }).filter(c => !search || c.title.toLowerCase().includes(search.toLowerCase()))

  const grouped = groupChatsByTime(filter === 'all' ? filtered : filtered)

  const handleCtx = (e: React.MouseEvent, chat: Chat) => {
    e.preventDefault(); e.stopPropagation()
    setCtxMenu({ chat, pos: { x: e.clientX, y: e.clientY } })
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

  return (
    <aside className="sidebar">
      {/* Шапка */}
      <div className="sidebar-header">
        <span className="sidebar-title">Чаты</span>
        <IconButton icon="plus" label="Новый чат" onClick={onNewChat} />
      </div>

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

      {/* Фильтры */}
      <div className="sidebar-filters">
        {(['all', 'pinned', 'archived'] as FilterMode[]).map(f => (
          <button
            key={f}
            className={`sidebar-filter-btn ${filter === f ? 'sidebar-filter-btn--active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'Все' : f === 'pinned' ? '📌 Закреп.' : '📦 Архив'}
          </button>
        ))}
      </div>

      {/* Список */}
      <div className="sidebar-list">
        {grouped.length === 0 && (
          <div className="sidebar-empty">
            {search ? 'Ничего не найдено' : 'Нет чатов'}
          </div>
        )}
        {grouped.map(([group, items]) => (
          <div key={group} className="sidebar-group">
            <div className="sidebar-group-label">{group}</div>
            {items.map((chat, i) => (
              <motion.div
                key={chat.id}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.03, type: 'spring', stiffness: 400, damping: 30 }}
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
                    {/* Цветная полоска */}
                    {chat.color && (
                      <span className="sidebar-chat-color" style={{ background: chat.color }} />
                    )}
                    <div className="sidebar-chat-content">
                      <div className="sidebar-chat-title">
                        {chat.isPinned && <AppIcon name="pin" size="xs" tone="accent" />}
                        {chat.title}
                      </div>
                      {chat.lastMessage && cleanPreview(chat.lastMessage) && (
                        <div className="sidebar-chat-preview">
                          {cleanPreview(chat.lastMessage)}
                        </div>
                      )}
                    </div>
                    <div className="sidebar-chat-meta">
                      <span className="sidebar-chat-time">
                        {formatTime(chat.updatedAt)}
                      </span>
                    </div>
                  </button>
                )}
              </motion.div>
            ))}
          </div>
        ))}
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
    </aside>
  )
}

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
  // Убираем markdown символы и переносы строк
  return text
    .replace(/```[\s\S]*?```/g, '[код]')
    .replace(/`[^`]+`/g, '[код]')
    .replace(/#{1,6}\s/g, '')
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, 60)
}
