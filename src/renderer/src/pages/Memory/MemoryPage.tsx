import { useState, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import { useVirtualizer } from '@tanstack/react-virtual'
import remarkGfm from 'remark-gfm'
import AppIcon, { type IconName } from '../../components/ui/AppIcon/AppIcon'
import IconButton from '../../components/ui/IconButton/IconButton'
import MemoryGraphTab from './MemoryGraphTab'
import { whileHoverSm, whileTapSm, whileHoverTiny, whileTapTiny, whileHoverWide, whileTapWide, whileHoverListItem, whileTapListItem, springHover } from '../../utils/motionPresets'
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

// Module-scope константа — не создаём новый массив remarkPlugins при каждом
// рендере (сбивает мемоизацию ReactMarkdown → ре-парс всех 200 элементов).
const REMARK_PLUGINS = [remarkGfm]

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
  const [searchInput, setSearchInput] = useState('')
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

  // Виртуализация списка — рендерим только видимые элементы
  const listRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 86,
    overscan: 5,
  })

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
  }, [searchMode, search, filterScope, filterKind, filterCategory])

  // Stats/categories меняются редко — только при add/delete/prune. Не тянем
  // их на каждый поисковый запрос (раньше 3 IPC на каждое нажатие клавиши).
  const loadStats = useCallback(async () => {
    try {
      const s = await (window.syntee as any).memory?.stats()
      setStats(s)
    } catch { /* ok */ }
    try {
      const cats = await (window.syntee as any).memory?.getCategories()
      setCategories(cats || [])
    } catch { /* ok */ }
  }, [])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [load])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadStats() }, [])

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
    loadStats()
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
    loadStats()
  }

  const handleSearch = () => { setSearch(searchInput) }

  const handlePrune = async () => {
    const count = await (window.syntee as any).memory?.prune()
    if (count > 0) {
      load()
      loadStats()
      alert(`Удалено ${count} устаревших записей`)
    } else {
      alert('Нет записей для удаления')
    }
  }

  const handleExtractOutcomes = async () => {
    const result = await (window.syntee as any).memory?.extractOutcomes()
    alert(result?.extracted ? `Извлечено ${result.extracted} уроков` : 'Уроков не найдено')
    load()
    loadStats()
  }

  const handleReindex = async () => {
    const count = await (window.syntee as any).memory?.reindex()
    alert(`Переиндексировано ${count} записей`)
  }

  const handleDeleteCategory = async (id: string) => {
    await (window.syntee as any).memory?.deleteCategory(id)
    load()
    loadStats()
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
              <motion.button className="memory-add-btn" onClick={handleExtractOutcomes} title="Извлечь уроки из логов агента" whileHover={whileHoverSm} whileTap={whileTapSm} transition={springHover}>
                <AppIcon name="wrench" size="sm" /> Уроки
              </motion.button>
              <motion.button className="memory-add-btn" onClick={handlePrune} title="Очистить устаревшие" whileHover={whileHoverSm} whileTap={whileTapSm} transition={springHover}>
                <AppIcon name="trash" size="sm" /> Чистка
              </motion.button>
              <motion.button className="memory-add-btn" onClick={handleReindex} title="Переиндексировать embeddings" whileHover={whileHoverSm} whileTap={whileTapSm} transition={springHover}>
                <AppIcon name="refreshCw" size="sm" /> Реиндекс
              </motion.button>
              <motion.button className="memory-add-btn memory-add-btn--primary" onClick={() => setAdding(p => !p)} whileHover={whileHoverSm} whileTap={whileTapSm} transition={springHover}>
                <AppIcon name="plus" size="sm" /> Добавить
              </motion.button>
            </>
          )}
        </div>
      </div>

      {/* Табы: Записи | Граф — segmented control со скользящим pill */}
      <div className="memory-tabs" role="tablist" aria-label="Разделы памяти">
        {(['list', 'graph'] as const).map(t => (
          <motion.button
            key={t}
            role="tab"
            aria-selected={activeTab === t}
            className={`memory-tab ${activeTab === t ? 'memory-tab--active' : ''}`}
            onClick={() => setActiveTab(t)}
            whileHover={whileHoverListItem}
            whileTap={whileTapListItem}
            transition={springHover}
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
          </motion.button>
        ))}
      </div>



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
              <motion.button className="memory-save-btn" onClick={handleAdd} whileHover={whileHoverWide} whileTap={whileTapWide} transition={springHover}>Сохранить</motion.button>
              <motion.button className="memory-cancel-btn" onClick={() => setAdding(false)} whileHover={whileHoverWide} whileTap={whileTapWide} transition={springHover}>Отмена</motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Row 1: kind-фильтры + поиск + режим */}
      <div className="memory-toolbar-primary">
        <div className="memory-filter-chips">
          <motion.button
            className={`memory-cat-btn ${filterKind === '' ? 'memory-cat-btn--active' : ''}`}
            onClick={() => setFilterKind('')}
            whileHover={whileHoverSm}
            whileTap={whileTapSm}
            transition={springHover}
          >
            <AppIcon name="brain" size="sm" tone={filterKind === '' ? 'accent' : 'muted'} />
            Все {stats ? `(${stats.total})` : ''}
          </motion.button>
          {KIND_OPTIONS.map(k => (
            <motion.button
              key={k.id}
              className={`memory-cat-btn ${filterKind === k.id ? 'memory-cat-btn--active' : ''}`}
              onClick={() => setFilterKind(filterKind === k.id ? '' : k.id)}
              whileHover={whileHoverSm}
              whileTap={whileTapSm}
              transition={springHover}
            >
              <AppIcon name={k.icon} size="sm" tone={filterKind === k.id ? 'accent' : 'muted'} />
              {k.label} {stats?.byKind?.[k.id] ? `(${stats.byKind[k.id]})` : ''}
            </motion.button>
          ))}
        </div>
        <div className="memory-search-wrap">
          <AppIcon name="search" size="sm" tone="muted" />
          <input
            className="memory-search"
            placeholder={searchMode === 'semantic' ? 'Поиск по смыслу...' : 'Поиск...'}
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
          />
        </div>
        <div className="memory-mode-toggle" role="tablist" aria-label="Режим поиска">
          {(['list', 'semantic'] as const).map(m => (
            <motion.button
              key={m}
              role="tab"
              aria-selected={searchMode === m}
              className={`memory-mode-btn ${searchMode === m ? 'memory-mode-btn--active' : ''}`}
              onClick={() => setSearchMode(m)}
              whileHover={whileHoverListItem}
              whileTap={whileTapListItem}
              transition={springHover}
            >
              {searchMode === m && (
                <motion.span
                  layoutId="memory-mode-active"
                  className="memory-mode-active-pill"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                />
              )}
              <span className="memory-mode-label">{m === 'list' ? 'Список' : 'Семантика'}</span>
            </motion.button>
          ))}
        </div>
      </div>

      {/* Row 2: scope + category-фильтры */}
      <div className="memory-toolbar-secondary">
        <div className="memory-filter-chips">
          <motion.button
            className={`memory-cat-btn ${filterScope === '' ? 'memory-cat-btn--active' : ''}`}
            onClick={() => setFilterScope('')}
            whileHover={whileHoverSm}
            whileTap={whileTapSm}
            transition={springHover}
          >
            <AppIcon name="layers" size="sm" tone={filterScope === '' ? 'accent' : 'muted'} />
            Все scope
          </motion.button>
          {SCOPE_OPTIONS.map(s => (
            <motion.button
              key={s.id}
              className={`memory-cat-btn ${filterScope === s.id ? 'memory-cat-btn--active' : ''}`}
              onClick={() => setFilterScope(filterScope === s.id ? '' : s.id)}
              whileHover={whileHoverSm}
              whileTap={whileTapSm}
              transition={springHover}
            >
              <AppIcon name={s.icon} size="sm" tone={filterScope === s.id ? 'accent' : 'muted'} />
              {s.label}
            </motion.button>
          ))}
        </div>
        <div className="memory-toolbar-divider" />
        <div className="memory-filter-chips">
          <motion.button
            className={`memory-cat-btn ${filterCategory === '' ? 'memory-cat-btn--active' : ''}`}
            onClick={() => setFilterCategory('')}
            whileHover={whileHoverSm}
            whileTap={whileTapSm}
            transition={springHover}
          >
            <AppIcon name="filter" size="sm" tone={filterCategory === '' ? 'accent' : 'muted'} />
            Все кат.
          </motion.button>
          {categories.map(c => (
            <motion.button
              key={c.id}
              className={`memory-cat-btn ${filterCategory === c.name ? 'memory-cat-btn--active' : ''}`}
              onClick={() => setFilterCategory(filterCategory === c.name ? '' : c.name)}
              whileHover={whileHoverSm}
              whileTap={whileTapSm}
              transition={springHover}
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
            </motion.button>
          ))}
          <motion.button
            className="memory-cat-btn memory-cat-btn--add"
            onClick={() => setAddingCategory(p => !p)}
            title="Создать категорию"
            whileHover={whileHoverSm}
            whileTap={whileTapSm}
            transition={springHover}
          >
            <AppIcon name="plus" size="sm" tone="muted" />
          </motion.button>
        </div>
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
              <motion.button
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
                whileHover={whileHoverWide}
                whileTap={whileTapWide}
                transition={springHover}
              >Создать</motion.button>
              <motion.button className="memory-cancel-btn" onClick={() => setAddingCategory(false)} whileHover={whileHoverWide} whileTap={whileTapWide} transition={springHover}>Отмена</motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Список — виртуализированный */}
      <div className="memory-list" ref={listRef}>
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
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map(virtualItem => {
              const m = items[virtualItem.index]
              const kindMeta = KIND_META[m.kind] ?? { label: m.kind, icon: 'pin' as IconName }
              const scopeMeta = SCOPE_META[m.scope] ?? { label: m.scope, icon: 'database' as IconName }
              const isExpanded = expandedItems.has(m.id)
              return (
                <div
                  key={m.id}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                    paddingBottom: '6px',
                  }}
                >
                  <div className={`memory-item ${m.pinned ? 'memory-item--pinned' : ''}`}>
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
                          <div className={`memory-item-content-body ${isExpanded ? 'memory-item-content-body--expanded' : ''}`}>
                            {isExpanded
                              ? <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{m.content}</ReactMarkdown>
                              : <span>{m.content.slice(0, 120)}{m.content.length > 120 ? '…' : ''}</span>
                            }
                          </div>
                          {m.content.length > 120 && (
                            <motion.button
                              className="memory-item-expand"
                              onClick={() => setExpandedItems(prev => {
                                const next = new Set(prev)
                                if (next.has(m.id)) next.delete(m.id)
                                else next.add(m.id)
                                return next
                              })}
                              whileHover={whileHoverSm}
                              whileTap={whileTapSm}
                              transition={springHover}
                            >
                              {isExpanded ? 'Свернуть ▲' : 'Развернуть ▼'}
                            </motion.button>
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
                      <motion.button
                        className={`memory-pin-btn ${m.pinned ? 'memory-pin-btn--active' : ''}`}
                        onClick={() => handlePin(m.id, !m.pinned)}
                        title={m.pinned ? 'Открепить' : 'Закрепить (защита от авто-удаления)'}
                        whileHover={whileHoverTiny}
                        whileTap={whileTapTiny}
                        transition={springHover}
                      >
                        <AppIcon name="pin" size="sm" tone={m.pinned ? 'warning' : 'muted'} />
                      </motion.button>
                      <IconButton icon="trash" label="Удалить" danger onClick={() => handleDelete(m.id)} />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
      </>
      )}

      {/* Граф знаний */}
      {activeTab === 'graph' && (
        <div className="memory-graph-container">
          <MemoryGraphTab
            selectedProjectId={selectedProjectId}
            onSelectProject={setSelectedProjectId}
            projects={projects}
          />
        </div>
      )}
    </div>
  )
}
