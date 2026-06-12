import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { ModelMeta, ModelCapability } from '../../../../../shared/types'
import AppIcon from '../AppIcon/AppIcon'
import './ModelPicker.css'

interface ModelPickerProps {
  value: string           // текущий modelId
  providerId: string
  onChange: (modelId: string, providerId: string) => void
  filterCaps?: ModelCapability[]  // фильтр по capabilities
  placeholder?: string
}

const CAP_LABELS: Record<ModelCapability, string> = {
  vision:    'Vision',
  tools:     'Tools',
  reasoning: 'Reasoning',
  code:      'Code',
  embedding: 'Embed',
  tts:       'TTS',
  stt:       'STT',
}

const SPEED_LABEL: Record<string, string> = {
  fast: 'Быстро',
  medium: 'Средне',
  slow: 'Медленно',
}

const SPEED_COLOR: Record<string, string> = {
  fast:   '#4ade80',
  medium: '#facc15',
  slow:   '#f87171',
}

function formatCtx(n: number): string {
  if (!n) return '—'
  if (n >= 1_000_000) return `${n / 1_000_000}M`
  return `${n / 1_000}K`
}

function formatPrice(n?: number): string {
  if (n === undefined) return '—'
  return `$${n.toFixed(2)}`
}

export default function ModelPicker({ value, providerId, onChange, filterCaps, placeholder }: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [models, setModels] = useState<ModelMeta[]>([])
  const [hovered, setHovered] = useState<ModelMeta | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ top: number }>({ top: 0 })
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    window.syntee.models.getAll()
      .then((all: ModelMeta[]) => setModels(all))
      .catch((e: unknown) => console.error('[ModelPicker] getAll error', e))
  }, [open])

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
  }, [open])

  // Закрыть при клике вне
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Фильтрация
  let filtered = models
  if (filterCaps?.length) {
    filtered = filtered.filter(m => filterCaps.every(c => m.capabilities.includes(c)))
  }
  if (query.trim()) {
    const q = query.toLowerCase()
    filtered = filtered.filter(m =>
      m.name.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q) ||
      m.providerId.toLowerCase().includes(q)
    )
  }

  // Группировка по провайдеру
  const grouped = filtered.reduce<Record<string, ModelMeta[]>>((acc, m) => {
    if (!acc[m.providerId]) acc[m.providerId] = []
    acc[m.providerId].push(m)
    return acc
  }, {})

  const current = models.find(m => m.id === value && m.providerId === providerId)

  return (
    <div className="model-picker" ref={wrapRef}>
      <motion.button
        className="model-picker-btn glass"
        onClick={() => setOpen(o => !o)}
        whileTap={{ scale: 0.97 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      >
        <span className="model-picker-provider-dot" style={{ background: getProviderColor(providerId) }} />
        <span className="model-picker-label">
          {current ? current.name : (placeholder || 'Выберите модель')}
        </span>
        <AppIcon name={open ? 'chevronUp' : 'chevronDown'} size="sm" />
      </motion.button>

      <AnimatePresence>
      {open && (
        <motion.div
          className="model-picker-dropdown glass"
          initial={{ opacity: 0, y: -6, scaleY: 0.95, transformOrigin: 'top' }}
          animate={{ opacity: 1, y: 0, scaleY: 1 }}
          exit={{ opacity: 0, y: -6, scaleY: 0.95 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        >
            {/* Поиск */}
            <div className="model-picker-search">
              <AppIcon name="search" size="sm" />
              <input
                ref={inputRef}
                className="model-picker-search-input"
                placeholder="Поиск моделей..."
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
              {query && (
                <button className="model-picker-search-clear" onClick={() => setQuery('')}>
                  <AppIcon name="x" size="xs" />
                </button>
              )}
            </div>

            {/* Список */}
            <div className="model-picker-list">
              {Object.entries(grouped).length === 0 && (
                <div className="model-picker-empty">Модели не найдены</div>
              )}
              {Object.entries(grouped).map(([pid, mods]) => (
                <div key={pid} className="model-picker-group">
                  <div className="model-picker-group-label">
                    <span className="model-picker-provider-dot" style={{ background: getProviderColor(pid) }} />
                    {pid}
                  </div>
                  {mods.map(m => (
                    <div
                      key={m.id}
                      className={`model-picker-item ${m.id === value && m.providerId === providerId ? 'model-picker-item--active' : ''}`}
                      onClick={() => { onChange(m.id, m.providerId); setOpen(false); setQuery('') }}
                      onMouseEnter={(e) => {
                        setHovered(m)
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                        const dropRect = wrapRef.current?.getBoundingClientRect()
                        setTooltipPos({ top: rect.top - (dropRect?.top || 0) })
                      }}
                      onMouseLeave={() => setHovered(null)}
                    >
                      <span className="model-picker-item-name">{m.name}</span>
                      <div className="model-picker-item-caps">
                        {m.capabilities.slice(0, 3).map(c => (
                          <span key={c} className="model-cap-badge">{CAP_LABELS[c]}</span>
                        ))}
                      </div>
                      {m.id === value && m.providerId === providerId && (
                        <AppIcon name="check" size="xs" tone="accent" />
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>

            {/* Tooltip */}
            <AnimatePresence>
              {hovered && (
                <motion.div
                  className="model-picker-tooltip glass"
                  style={{ top: tooltipPos.top }}
                  initial={{ opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 8 }}
                  transition={{ duration: 0.12 }}
                >
                  <div className="mpt-name">{hovered.name}</div>
                  <div className="mpt-id">{hovered.id}</div>
                  <div className="mpt-row">
                    <span className="mpt-label">Контекст</span>
                    <span className="mpt-val">{formatCtx(hovered.contextWindow)}</span>
                  </div>
                  <div className="mpt-row">
                    <span className="mpt-label">Цена (вход)</span>
                    <span className="mpt-val">{formatPrice(hovered.inputPrice)} / 1M</span>
                  </div>
                  <div className="mpt-row">
                    <span className="mpt-label">Цена (выход)</span>
                    <span className="mpt-val">{formatPrice(hovered.outputPrice)} / 1M</span>
                  </div>
                  <div className="mpt-row">
                    <span className="mpt-label">Скорость</span>
                    <span className="mpt-val" style={{ color: SPEED_COLOR[hovered.speed] }}>
                      {SPEED_LABEL[hovered.speed]}
                    </span>
                  </div>
                  {hovered.capabilities.length > 0 && (
                    <div className="mpt-caps">
                      {hovered.capabilities.map(c => (
                        <span key={c} className="model-cap-badge">{CAP_LABELS[c]}</span>
                      ))}
                    </div>
                  )}
                  {hovered.description && (
                    <div className="mpt-desc">{hovered.description}</div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function getProviderColor(pid: string): string {
  const colors: Record<string, string> = {
    openai: '#10a37f', anthropic: '#d4763b', google: '#4285f4',
    groq: '#f55036', mistral: '#ff7000', ollama: '#aaaaaa',
    cohere: '#39594d', together: '#7c3aed', fireworks: '#ef4444',
    deepseek: '#2563eb', xai: '#ffffff', onlysq: '#a855f7', voidai: '#06b6d4',
  }
  return colors[pid] || '#888888'
}
