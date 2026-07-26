import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import AppIcon, { type IconName } from '../../components/ui/AppIcon/AppIcon'
import IconButton from '../../components/ui/IconButton/IconButton'
import MemoryGraphTab from './MemoryGraphTab'
import './MemoryPage.css'

interface MemoryItem {
  id: string
  title: string
  scope: string
  projectId: string | null
  chatId: string | null
  kind: string
  category: string | null
  key: string | null
  content: string
  source: string
  confidence: number
  importance: number
  accessCount: number
  lastAccessedAt: number | null
  pinned: boolean
  createdAt: number
  updatedAt: number
}

interface Filter {
  scope?: string
  kind?: string
  projectId?: string
  category?: string
  search?: string
  limit?: number
  offset?: number
}

type SearchMode = 'list' | 'semantic'

const KIND_META: Record<string, { label: string; icon: IconName }> = {
  user_fact: { label: 'О пользователе', icon: 'user' },
  project_decision: { label: 'Решения', icon: 'folder' },
  convention: { label: 'Конвенции', icon: 'alertTriangle' },
  conversation: { label: 'Диалоги', icon: 'messageSquare' },
  agent_outcome: { label: 'Уроки', icon: 'wrench' },
}

const SCOPE_META: Record<string, { label: string; icon: IconName }> = {
  global: { label: 'Глобально', icon: 'globe' },
  project: { label: 'Проект', icon: 'folder' },
  chat: { label: 'Чат', icon: 'messageSquare' },
}

const CATEGORY_OPTIONS = [
  { id: 'personal', label: 'Личное', icon: 'user' as IconName },
  { id: 'work', label: 'Работа', icon: 'briefcase' as IconName },
  { id: 'preferences', label: 'Предпочтения', icon: 'sparkles' as IconName },
  { id: 'projects', label: 'Проекты', icon: 'folder' as IconName },
  { id: 'facts', label: 'Факты', icon: 'pin' as IconName },
]

const KIND_OPTIONS = [
  { id: 'user_fact', label: 'О пользователе', icon: 'user' as IconName },
  { id: 'project_decision', label: 'Решения', icon: 'folder' as IconName },
  { id: 'convention', label: 'Конвенции', icon: 'alertTriangle' as IconName },
  { id: 'conversation', label: 'Диалоги', icon: 'messageSquare' as IconName },
  { id: 'agent_outcome', label: 'Уроки', icon: 'wrench' as IconName },
]

const SCOPE_OPTIONS = [
  { id: 'global', label: 'Глобально', icon: 'globe' as IconName },
  { id: 'project', label: 'Проект', icon: 'folder' as IconName },
]

function fmtTime(ts: number | null): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  const day = 24 * 60 * 60 * 1000
  if (diff < day) return 'сегодня'
  if (diff < 2 * day) return 'вчера'
  if (diff < 7 * day) return `${Math.floor(diff / day)} дн назад`
  return new Date(ts).toLocaleDateString('ru')
}

function importanceTone(imp: number): 'muted' | 'default' | 'accent' | 'warning' {
  if (imp >= 0.8) return 'warning'
  if (imp >= 0.6) return 'accent'
  if (imp >= 0.3) return 'default'
  return 'muted'
}

export default function MemoryPage() {
  const [items, setItems] = useState<MemoryItem[]>([])
  const [stats, setStats] = useState<{ total: number; byScope: Record<string, number>; byKind: Record<string, number> } | null>(null)
  const [categories, setCategories] = useState<Array<{ id: string; name: string; label: string; icon: string | null; scope: string }>>([])
  const [searchMode, setSearchMode] = useState<SearchMode>('list')
  const [search, setSearch] = useState('')
  const [filterScope, setFilterScope] = useState<string>('')
  const [filterKind, setFilterKind] = useState<string>('')
  const [filterCategory, setFilterCategory] = useState<string>('')
  const [adding, setAdding] = useState(false)
  const [addingCategory, setAddingCategory] = useState(false)
  const [newContent, setNewContent] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [newKey, setNewKey] = useState('')
  const [newKind, setNewKind] = useState<string>('user_fact')
  const [newScope, setNewScope] = useState<string>('global')
  const [newCategory, setNewCategory] = useState<string>('facts')
  const [newImportance, setNewImportance] = useState<number>(0.5)
  const [newCatName, setNewCatName] = useState('')
  const [newCatLabel, setNewCatLabel] = useState('')
  const [activeTab, setActiveTab] = useState<'list' | 'graph'>('list')
  const [projects, setProjects] = useState<Array<{ id: string; name: string; workdir: string }>>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string>('')
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    if (searchMode === 'semantic' && search.trim()) {
      const results = await (window.syntee as any).memory?.search({
        query: search,
        scope: filterScope || 'all',
        kind: filterKind || undefined,
        limit: 30,
      }) || []
      setItems(results)
    } else {
      const filter: Filter = { limit: 200 }
      if (filterScope) filter.scope = filterScope
      if (filterKind) filter.kind = filterKind
      if (filterCategory) filter.category = filterCategory
      if (search) filter.search = search
      const all = await (window.syntee as any).memory?.getAll(filter) || []
      setItems(all)
    }
    try {
      const s = await (window.syntee as any).memory?.stats()
      setStats(s)
    } catch { /* ok */ }
    try {
      const cats = await (window.syntee as any).memory?.getCategories()
      setCategories(cats || [])
    } catch { /* ok */ }
  }, [searchMode, search, filterScope, filterKind, filterCategory])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [load])

  // Загружаем список проектов для tab'а графа
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    ;(async () => {
      try {
        const all = await (window.syntee as any).projects?.getAll() || []
        setProjects(all.map((p: any) => ({ id: p.id, name: p.name, workdir: p.workdir })))
      } catch { /* ok */ }
    })()
  }, [])

  const handleDelete = async (id: string) => {
    await (window.syntee as any).memory?.delete(id)
    setItems(prev => prev.filter(m => m.id !== id))
    load()
  }

  const handlePin = async (id: string, pinned: boolean) => {
    await (window.syntee as any).memory?.pin(id, pinned)
    setItems(prev => prev.map(m => m.id === id ? { ...m, pinned } : m))
  }

  const handleAdd = async () => {
    if (!newTitle.trim() || !newContent.trim()) return
    await (window.syntee as any).memory?.save({
      title: newTitle.trim(),
      content: newContent.trim(),
      kind: newKind,
      scope: newScope,
      key: newKey.trim() || undefined,
      category: newKind === 'user_fact' ? newCategory : undefined,
      importance: newImportance,
    })
    setNewTitle('')
    setNewContent('')
    setNewKey('')
    setAdding(false)
    load()
  }

  const handleSearch = () => { load() }

  const handlePrune = async () => {
    const count = await (window.syntee as any).memory?.prune()
    if (count > 0) {
      load()
      alert(`Удалено ${count} устаревших записей`)
    } else {
      alert('Нет записей для удаления')
    }
  }

  const handleExtractOutcomes = async () => {
    const result = await (window.syntee as any).memory?.extractOutcomes()
    alert(result?.extracted ? `Извлечено ${result.extracted} уроков` : 'Уроков не найдено')
    load()
  }

  const handleReindex = async () => {
    const count = await (window.syntee as any).memory?.reindex()
    alert(`Переиндексировано ${count} записей`)
  }

  const handleDeleteCategory = async (id: string) => {
    await (window.syntee as any).memory?.deleteCategory(id)
    load()
  }

  return (
    <div className="memory-page">
      {/* Заголовок */}
      <div className="memory-header">
        <div className="memory-title">
          <AppIcon name="brain" size="lg" tone="accent" />
          <h2>Память</h2>
          <span className="memory-count">{stats?.total ?? items.length}</span>
        </div>
        <div className="memory-header-actions">
          {activeTab === 'list' && (
            <>
              <button className="memory-add-btn" onClick={handleExtractOutcomes} title="Извлечь уроки из логов агента">
                <AppIcon name="wrench" size="sm" /> Уроки
              </button>
              <button className="memory-add-btn" onClick={handlePrune} title="Очистить устаревшие">
                <AppIcon name="trash" size="sm" /> Чистка
              </button>
              <button className="memory-add-btn" onClick={handleReindex} title="Переиндексировать embeddings">
                <AppIcon name="refreshCw" size="sm" /> Реиндекс
              </button>
              <button className="memory-add-btn memory-add-btn--primary" onClick={() => setAdding(p => !p)}>
                <AppIcon name="plus" size="sm" /> Добавить
              </button>
            </>
          )}
        </div>
      </div>

      {/* Табы: Записи | Граф — segmented control со скользящим pill */}
      <div className="memory-tabs" role="tablist" aria-label="Разделы памяти">
        {(['list', 'graph'] as const).map(t => (
          <button
            key={t}
            role="tab"
            aria-selected={activeTab === t}
            className={`memory-tab ${activeTab === t ? 'memory-tab--active' : ''}`}
            onClick={() => setActiveTab(t)}
          >
            {activeTab === t && (
              <motion.span
                layoutId="memory-tab-active"
                className="memory-tab-active-pill"
                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
              />
            )}
            <AppIcon name={t === 'list' ? 'listChecks' : 'gitBranch'} size="sm" />
            <span className="memory-tab-label">{t === 'list' ? 'Записи' : 'Граф знаний'}</span>
          </button>
        ))}
      </div>

      {activeTab === 'graph' && (
        <div className="memory-graph-project-selector">
          <label>Проект: </label>
          <select
            value={selectedProjectId}
            onChange={(e) => setSelectedProjectId(e.target.value)}
          >
            <option value="">— выберите проект —</option>
            {projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Форма добавления */}
      {activeTab === 'list' && (
      <>
      <AnimatePresence>
        {adding && (
          <motion.div
            className="memory-add-form"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          >
            <div className="memory-form-row">
              <select className="memory-select" value={newKind} onChange={e => setNewKind(e.target.value)}>
                {KIND_OPTIONS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
              </select>
              <select className="memory-select" value={newScope} onChange={e => setNewScope(e.target.value)}>
                {SCOPE_OPTIONS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
              {newKind === 'user_fact' && (
                <select className="memory-select" value={newCategory} onChange={e => setNewCategory(e.target.value)}>
                  {CATEGORY_OPTIONS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              )}
            </div>
            <input
              className="memory-input"
              placeholder="Название (обязательно, напр. «Архитектура авторизации»)"
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
            />
            <input
              className="memory-input"
              placeholder="Ключ (опционально, для дедупликации, напр. preferred_stack)"
              value={newKey}
              onChange={e => setNewKey(e.target.value)}
            />
            <textarea
              className="memory-input memory-textarea"
              placeholder="Подробное описание. Markdown поддерживается. Напр. «Решили использовать JWT.&#10;- Access token: 15мин&#10;- Refresh: 7дней»"
              value={newContent}
              onChange={e => setNewContent(e.target.value)}
              rows={4}
            />
            <div className="memory-form-row memory-importance-row">
              <label className="memory-label">Важность: {newImportance.toFixed(1)}</label>
              <input
                type="range" min="0" max="1" step="0.1"
                value={newImportance}
                onChange={e => setNewImportance(Number(e.target.value))}
                className="memory-range"
              />
            </div>
            <div className="memory-form-actions">
              <button className="memory-save-btn" onClick={handleAdd}>Сохранить</button>
              <button className="memory-cancel-btn" onClick={() => setAdding(false)}>Отмена</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Фильтры по типу */}
      <div className="memory-categories">
        <button
          className={`memory-cat-btn ${filterKind === '' ? 'memory-cat-btn--active' : ''}`}
          onClick={() => setFilterKind('')}
        >
          <AppIcon name="brain" size="sm" tone={filterKind === '' ? 'accent' : 'muted'} />
          Все {stats ? `(${stats.total})` : ''}
        </button>
        {KIND_OPTIONS.map(k => (
          <button
            key={k.id}
            className={`memory-cat-btn ${filterKind === k.id ? 'memory-cat-btn--active' : ''}`}
            onClick={() => setFilterKind(filterKind === k.id ? '' : k.id)}
          >
            <AppIcon name={k.icon} size="sm" tone={filterKind === k.id ? 'accent' : 'muted'} />
            {k.label} {stats?.byKind?.[k.id] ? `(${stats.byKind[k.id]})` : ''}
          </button>
        ))}
      </div>

      {/* Фильтр по scope + режим поиска */}
      <div className="memory-toolbar">
        <div className="memory-scope-filters">
          <button
            className={`memory-cat-btn ${filterScope === '' ? 'memory-cat-btn--active' : ''}`}
            onClick={() => setFilterScope('')}
          >
            <AppIcon name="layers" size="sm" tone={filterScope === '' ? 'accent' : 'muted'} />
            Все scope
          </button>
          {SCOPE_OPTIONS.map(s => (
            <button
              key={s.id}
              className={`memory-cat-btn ${filterScope === s.id ? 'memory-cat-btn--active' : ''}`}
              onClick={() => setFilterScope(filterScope === s.id ? '' : s.id)}
            >
              <AppIcon name={s.icon} size="sm" tone={filterScope === s.id ? 'accent' : 'muted'} />
              {s.label}
            </button>
          ))}
        </div>
        <div className="memory-mode-toggle" role="tablist" aria-label="Режим поиска">
          {(['list', 'semantic'] as const).map(m => (
            <button
              key={m}
              role="tab"
              aria-selected={searchMode === m}
              className={`memory-mode-btn ${searchMode === m ? 'memory-mode-btn--active' : ''}`}
              onClick={() => setSearchMode(m)}
            >
              {searchMode === m && (
                <motion.span
                  layoutId="memory-mode-active"
                  className="memory-mode-active-pill"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                />
              )}
              <span className="memory-mode-label">{m === 'list' ? 'Список' : 'Семантика'}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Фильтр по категориям (builtin + кастомные) */}
      <div className="memory-categories">
        <button
          className={`memory-cat-btn ${filterCategory === '' ? 'memory-cat-btn--active' : ''}`}
          onClick={() => setFilterCategory('')}
        >
          <AppIcon name="filter" size="sm" tone={filterCategory === '' ? 'accent' : 'muted'} />
          Все категории
        </button>
        {categories.map(c => (
          <button
            key={c.id}
            className={`memory-cat-btn ${filterCategory === c.name ? 'memory-cat-btn--active' : ''}`}
            onClick={() => setFilterCategory(filterCategory === c.name ? '' : c.name)}
          >
            <AppIcon name={(c.icon as IconName) || 'pin'} size="sm" tone={filterCategory === c.name ? 'accent' : 'muted'} />
            {c.label}
            {!c.id.startsWith('builtin-') && (
              <span
                className="memory-cat-delete"
                onClick={(e) => { e.stopPropagation(); handleDeleteCategory(c.id) }}
                title="Удалить категорию"
              >×</span>
            )}
          </button>
        ))}
        <button
          className="memory-cat-btn memory-cat-btn--add"
          onClick={() => setAddingCategory(p => !p)}
          title="Создать категорию"
        >
          <AppIcon name="plus" size="sm" tone="muted" />
        </button>
      </div>

      {/* Форма создания категории */}
      <AnimatePresence>
        {addingCategory && (
          <motion.div
            className="memory-add-form"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          >
            <div className="memory-form-row">
              <input
                className="memory-input"
                placeholder="Имя (машинное, напр. bugs, ideas)"
                value={newCatName}
                onChange={e => setNewCatName(e.target.value)}
              />
              <input
                className="memory-input"
                placeholder="Метка (человекочитаемое, напр. Баги)"
                value={newCatLabel}
                onChange={e => setNewCatLabel(e.target.value)}
              />
            </div>
            <div className="memory-form-actions">
              <button
                className="memory-save-btn"
                onClick={async () => {
                  if (!newCatName.trim() || !newCatLabel.trim()) return
                  await (window.syntee as any).memory?.createCategory({
                    name: newCatName.trim(),
                    label: newCatLabel.trim(),
                    scope: newScope,
                  })
                  setNewCatName('')
                  setNewCatLabel('')
                  setAddingCategory(false)
                  load()
                }}
              >Создать</button>
              <button className="memory-cancel-btn" onClick={() => setAddingCategory(false)}>Отмена</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Поиск */}
      <div className="memory-search-wrap">
        <AppIcon name="search" size="sm" tone="muted" />
        <input
          className="memory-search"
          placeholder={searchMode === 'semantic' ? 'Семантический поиск по смыслу...' : 'Поиск по содержимому...'}
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
        />
      </div>

      {/* Список */}
      <div className="memory-list">
        <AnimatePresence initial={false}>
          {items.length === 0 ? (
            <div className="memory-empty">
              <AppIcon name="brain" size="xl" tone="muted" />
              <p>
                {searchMode === 'semantic' && search
                  ? 'Ничего не найдено по смыслу. Попробуйте переформулировать.'
                  : 'Память пуста. Syntee запоминает факты автоматически, или добавьте вручную.'}
              </p>
            </div>
          ) : (
            items.map((m, i) => {
              const kindMeta = KIND_META[m.kind] ?? { label: m.kind, icon: 'pin' as IconName }
              const scopeMeta = SCOPE_META[m.scope] ?? { label: m.scope, icon: 'database' as IconName }
              return (
                <motion.div
                  key={m.id}
                  className={`memory-item ${m.pinned ? 'memory-item--pinned' : ''}`}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0, transition: { type: 'spring', stiffness: 320, damping: 26, delay: Math.min(i * 0.035, 0.4) } }}
                  exit={{ opacity: 0, x: -20 }}
                  whileHover={{ y: -2, transition: { type: 'spring', stiffness: 400, damping: 25 } }}
                  layout
                >
                  <div className="memory-item-cat">
                    <AppIcon name={kindMeta.icon} size="md" tone="muted" />
                  </div>
                  <div className="memory-item-content">
                    <div className="memory-item-tags">
                      <span className="memory-tag memory-tag--kind">{kindMeta.label}</span>
                      <span className="memory-tag memory-tag--scope">
                        <AppIcon name={scopeMeta.icon} size="xs" tone="muted" />
                        {scopeMeta.label}
                      </span>
                      {m.category && (
                        <span className="memory-tag memory-tag--category">{m.category}</span>
                      )}
                      {m.key && (
                        <span className="memory-tag memory-tag--key">key: {m.key}</span>
                      )}
                    </div>
                    <div className="memory-item-title">{m.title || m.content.slice(0, 80)}</div>
                    {m.content && m.content !== m.title && (
                      <>
                        <div className={`memory-item-content-body ${expandedItems.has(m.id) ? 'memory-item-content-body--expanded' : ''}`}>
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                        </div>
                        {m.content.length > 120 && (
                          <button
                            className="memory-item-expand"
                            onClick={() => setExpandedItems(prev => {
                              const next = new Set(prev)
                              if (next.has(m.id)) next.delete(m.id)
                              else next.add(m.id)
                              return next
                            })}
                          >
                            {expandedItems.has(m.id) ? 'Свернуть ▲' : 'Развернуть ▼'}
                          </button>
                        )}
                      </>
                    )}
                    <div className="memory-item-footer">
                      <span className="memory-meta-text">
                        <AppIcon name="clock" size="xs" tone="muted" />
                        {fmtTime(m.updatedAt)}
                      </span>
                      {m.accessCount > 0 && (
                        <span className="memory-meta-text">
                          <AppIcon name="eye" size="xs" tone="muted" />
                          {m.accessCount}
                        </span>
                      )}
                      <span className="memory-meta-text">источник: {m.source}</span>
                    </div>
                  </div>
                  <div className="memory-item-meta">
                    <div className="memory-importance-badge" title={`Важность: ${m.importance.toFixed(2)}`}>
                      <AppIcon name="star" size="xs" tone={importanceTone(m.importance)} />
                      <span>{Math.round(m.importance * 100)}%</span>
                    </div>
                    <button
                      className={`memory-pin-btn ${m.pinned ? 'memory-pin-btn--active' : ''}`}
                      onClick={() => handlePin(m.id, !m.pinned)}
                      title={m.pinned ? 'Открепить' : 'Закрепить (защита от авто-удаления)'}
                    >
                      <AppIcon name="pin" size="sm" tone={m.pinned ? 'warning' : 'muted'} />
                    </button>
                    <IconButton icon="trash" label="Удалить" danger onClick={() => handleDelete(m.id)} />
                  </div>
                </motion.div>
              )
            })
          )}
        </AnimatePresence>
      </div>
      </>
      )}

      {/* Граф знаний */}
      {activeTab === 'graph' && (
        <div className="memory-graph-container">
          <MemoryGraphTab projectId={selectedProjectId} />
        </div>
      )}
    </div>
  )
}
