import { useState, useEffect, useCallback } from 'react'
import AppIcon from '../AppIcon/AppIcon'
import './NotesPanel.css'

interface Note {
  id: string
  scope: string
  projectId: string | null
  chatId: string | null
  title: string
  content: string
  createdAt: number
  updatedAt: number
}

interface NotesPanelProps {
  currentChatId: string | null
}

type Scope = 'project' | 'chat'

export default function NotesPanel({ currentChatId }: NotesPanelProps) {
  const [scope, setScope] = useState<Scope>('chat')
  const [notes, setNotes] = useState<Note[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newContent, setNewContent] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Resolve projectId from chatId via IPC
  useEffect(() => {
    if (!currentChatId) return
    let cancelled = false
    window.syntee.notes.getProjectId(currentChatId).then((pid: string | null) => {
      if (!cancelled) setProjectId(pid)
    }).catch(() => { if (!cancelled) setProjectId(null) })
    return () => { cancelled = true }
  }, [currentChatId])

  // Derived: effectiveProjectId is null when no chat selected
  const effectiveProjectId = currentChatId ? projectId : null

  // Load notes
  const loadNotes = useCallback(async () => {
    if (scope === 'project' && !effectiveProjectId) { setNotes([]); return }
    if (scope === 'chat' && !currentChatId) { setNotes([]); return }
    setLoading(true)
    setError(null)
    try {
      const result = await window.syntee.notes.list({
        scope,
        projectId: scope === 'project' ? effectiveProjectId ?? undefined : undefined,
        chatId: scope === 'chat' ? currentChatId ?? undefined : undefined,
      })
      setNotes(result as Note[])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [scope, effectiveProjectId, currentChatId])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadNotes() }, [loadNotes])

  // Live update: subscribe to notes:changed event
  useEffect(() => {
    const unsub = window.syntee.on('notes:changed', (data: unknown) => {
      const d = data as { scope: string; projectId?: string; chatId?: string }
      if (d.scope === scope) {
        if (scope === 'project' && d.projectId && effectiveProjectId && d.projectId === effectiveProjectId) {
          loadNotes()
        } else if (scope === 'chat' && d.chatId && currentChatId && d.chatId === currentChatId) {
          loadNotes()
        } else if (scope === 'project' && !d.projectId) {
          loadNotes()
        } else if (scope === 'chat' && !d.chatId) {
          loadNotes()
        }
      }
    })
    return () => { unsub() }
  }, [scope, effectiveProjectId, currentChatId, loadNotes])

  const handleCreate = async () => {
    if (!newTitle.trim()) return
    setError(null)
    try {
      const result = await window.syntee.notes.create({
        scope,
        projectId: scope === 'project' ? effectiveProjectId ?? undefined : undefined,
        chatId: scope === 'chat' ? currentChatId ?? undefined : undefined,
        title: newTitle.trim(),
        content: newContent,
      })
      if (!result.success) {
        setError(result.error ?? 'Failed to create note')
        return
      }
      setNewTitle('')
      setNewContent('')
      setCreating(false)
      loadNotes()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const handleUpdate = async (id: string) => {
    if (!editTitle.trim()) return
    setError(null)
    try {
      const result = await window.syntee.notes.update({
        id,
        title: editTitle.trim(),
        content: editContent,
      })
      if (!result.success) {
        setError(result.error ?? 'Failed to update note')
        return
      }
      setEditingId(null)
      setEditTitle('')
      setEditContent('')
      loadNotes()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const handleDelete = async (id: string) => {
    setError(null)
    try {
      const result = await window.syntee.notes.delete(id)
      if (!result.success) {
        setError(result.error ?? 'Failed to delete note')
        return
      }
      loadNotes()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const startEdit = (note: Note) => {
    setEditingId(note.id)
    setEditTitle(note.title)
    setEditContent(note.content)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditTitle('')
    setEditContent('')
  }

  const canUseProject = !!effectiveProjectId

  if (!currentChatId) {
    return (
      <div className="notes-panel notes-panel--empty">
        <AppIcon name="fileText" size="lg" tone="muted" />
        <p>Выберите чат</p>
        <p className="notes-panel__hint">Заметки доступны когда открыт чат</p>
      </div>
    )
  }

  return (
    <div className="notes-panel">
      <div className="notes-panel__header">
        <div className="notes-panel__scope-toggle">
          <button
            className={`notes-panel__scope-btn ${scope === 'chat' ? 'active' : ''}`}
            onClick={() => setScope('chat')}
          >
            Чат
          </button>
          <button
            className={`notes-panel__scope-btn ${scope === 'project' ? 'active' : ''} ${!canUseProject ? 'disabled' : ''}`}
            onClick={() => canUseProject && setScope('project')}
            disabled={!canUseProject}
            title={canUseProject ? 'Проектные заметки' : 'Чат не привязан к проекту'}
          >
            Проект
          </button>
        </div>
        <button
          className="notes-panel__add-btn"
          onClick={() => setCreating(true)}
          title="Новая заметка"
          disabled={scope === 'project' && !canUseProject}
        >
          <AppIcon name="plus" size="xs" />
        </button>
      </div>

      {error && <div className="notes-panel__error">{error}</div>}

      {creating && (
        <div className="notes-panel__create-form">
          <input
            className="notes-panel__input"
            type="text"
            placeholder="Заголовок заметки…"
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            autoFocus
            maxLength={100}
          />
          <textarea
            className="notes-panel__textarea"
            placeholder="Содержимое заметки…"
            value={newContent}
            onChange={e => setNewContent(e.target.value)}
            rows={4}
          />
          <div className="notes-panel__form-actions">
            <button className="notes-panel__btn notes-panel__btn--save" onClick={handleCreate} disabled={!newTitle.trim()}>
              Сохранить
            </button>
            <button className="notes-panel__btn notes-panel__btn--cancel" onClick={() => { setCreating(false); setNewTitle(''); setNewContent('') }}>
              Отмена
            </button>
          </div>
        </div>
      )}

      <div className="notes-panel__list">
        {loading && notes.length === 0 && (
          <div className="notes-panel__loading">Загрузка…</div>
        )}
        {!loading && notes.length === 0 && !creating && (
          <div className="notes-panel__empty-list">
            <p>Нет заметок</p>
            <span>{scope === 'project' ? 'Создайте заметку для проекта — она будет видна во всех чатах проекта' : 'Создайте заметку для этого чата'}</span>
          </div>
        )}
        {notes.map(note => (
          <div key={note.id} className="notes-panel__note">
            {editingId === note.id ? (
              <div className="notes-panel__edit-form">
                <input
                  className="notes-panel__input"
                  type="text"
                  value={editTitle}
                  onChange={e => setEditTitle(e.target.value)}
                  maxLength={100}
                  autoFocus
                />
                <textarea
                  className="notes-panel__textarea"
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                  rows={4}
                />
                <div className="notes-panel__form-actions">
                  <button className="notes-panel__btn notes-panel__btn--save" onClick={() => handleUpdate(note.id)} disabled={!editTitle.trim()}>
                    Сохранить
                  </button>
                  <button className="notes-panel__btn notes-panel__btn--cancel" onClick={cancelEdit}>
                    Отмена
                  </button>
                </div>
              </div>
            ) : (
              <div className="notes-panel__note-content">
                <div className="notes-panel__note-header">
                  <span className="notes-panel__note-title">{note.title}</span>
                  <div className="notes-panel__note-actions">
                    <button className="notes-panel__note-btn" onClick={() => startEdit(note)} title="Редактировать">
                      <AppIcon name="edit" size="xs" />
                    </button>
                    <button className="notes-panel__note-btn" onClick={() => handleDelete(note.id)} title="Удалить">
                      <AppIcon name="trash" size="xs" />
                    </button>
                  </div>
                </div>
                {note.content && (
                  <div className="notes-panel__note-body">{note.content}</div>
                )}
                <div className="notes-panel__note-date">
                  {new Date(note.updatedAt).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
