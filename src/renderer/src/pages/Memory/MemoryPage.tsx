import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import './MemoryPage.css'

interface MemoryEntry {
  id: string
  category: string
  key: string
  value: string
  confidence: number
  updatedAt: number
}

const CATEGORIES = [
  { id: 'all', label: 'Все', icon: '🧠' },
  { id: 'personal', label: 'Личное', icon: '👤' },
  { id: 'work', label: 'Работа', icon: '💼' },
  { id: 'preferences', label: 'Предпочтения', icon: '⭐' },
  { id: 'projects', label: 'Проекты', icon: '🚀' },
  { id: 'facts', label: 'Факты', icon: '📌' },
]

export default function MemoryPage() {
  const [memories, setMemories] = useState<MemoryEntry[]>([])
  const [activeCategory, setActiveCategory] = useState('all')
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const [newCategory, setNewCategory] = useState<string>('facts')

  const load = async () => {
    const all = await (window.syntee as any).memory?.getAll(
      activeCategory === 'all' ? undefined : activeCategory
    ) || []
    setMemories(all)
  }

  useEffect(() => { load() }, [activeCategory])

  const filtered = memories.filter(m =>
    !search || m.key.toLowerCase().includes(search.toLowerCase()) ||
    m.value.toLowerCase().includes(search.toLowerCase())
  )

  const handleDelete = async (id: string) => {
    await (window.syntee as any).memory?.delete(id)
    setMemories(prev => prev.filter(m => m.id !== id))
  }

  const handleAdd = async () => {
    if (!newKey.trim() || !newValue.trim()) return
    const entry = await (window.syntee as any).memory?.save({
      category: newCategory,
      key: newKey.trim(),
      value: newValue.trim(),
      confidence: 1.0,
      source: 'user_manual',
    })
    if (entry) setMemories(prev => [entry, ...prev])
    setNewKey('')
    setNewValue('')
    setAdding(false)
  }

  return (
    <div className="memory-page">
      {/* Заголовок */}
      <div className="memory-header">
        <div className="memory-title">
          <span>🧠</span>
          <h2>Память</h2>
          <span className="memory-count">{memories.length}</span>
        </div>
        <button className="memory-add-btn" onClick={() => setAdding(p => !p)}>
          + Добавить
        </button>
      </div>

      {/* Форма добавления */}
      <AnimatePresence>
        {adding && (
          <motion.div
            className="memory-add-form"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <select
              className="memory-select"
              value={newCategory}
              onChange={e => setNewCategory(e.target.value)}
            >
              {CATEGORIES.filter(c => c.id !== 'all').map(c => (
                <option key={c.id} value={c.id}>{c.icon} {c.label}</option>
              ))}
            </select>
            <input
              className="memory-input"
              placeholder="Ключ (напр: любимый язык)"
              value={newKey}
              onChange={e => setNewKey(e.target.value)}
            />
            <input
              className="memory-input"
              placeholder="Значение (напр: Python)"
              value={newValue}
              onChange={e => setNewValue(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAdd()}
            />
            <div className="memory-form-actions">
              <button className="memory-save-btn" onClick={handleAdd}>Сохранить</button>
              <button className="memory-cancel-btn" onClick={() => setAdding(false)}>Отмена</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Фильтры по категориям */}
      <div className="memory-categories">
        {CATEGORIES.map(cat => (
          <button
            key={cat.id}
            className={`memory-cat-btn ${activeCategory === cat.id ? 'memory-cat-btn--active' : ''}`}
            onClick={() => setActiveCategory(cat.id)}
          >
            {cat.icon} {cat.label}
          </button>
        ))}
      </div>

      {/* Поиск */}
      <div className="memory-search-wrap">
        <input
          className="memory-search"
          placeholder="Поиск по памяти..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* Список */}
      <div className="memory-list">
        <AnimatePresence initial={false}>
          {filtered.length === 0 ? (
            <div className="memory-empty">
              <span>🧠</span>
              <p>Нет записей. Напиши Syntee «запомни...» или добавь вручную.</p>
            </div>
          ) : (
            filtered.map(m => (
              <motion.div
                key={m.id}
                className="memory-item"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: -20 }}
                layout
              >
                <div className="memory-item-cat">
                  {CATEGORIES.find(c => c.id === m.category)?.icon || '📌'}
                </div>
                <div className="memory-item-content">
                  <span className="memory-item-key">{m.key}</span>
                  <span className="memory-item-value">{m.value}</span>
                </div>
                <div className="memory-item-meta">
                  <span className="memory-item-conf">{Math.round(m.confidence * 100)}%</span>
                  <button
                    className="memory-delete-btn"
                    onClick={() => handleDelete(m.id)}
                    title="Удалить"
                  >✕</button>
                </div>
              </motion.div>
            ))
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
