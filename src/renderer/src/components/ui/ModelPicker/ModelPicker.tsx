import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import type { ModelMeta, ModelCapability } from '../../../../../shared/types'
import AppIcon from '../AppIcon/AppIcon'
import './ModelPicker.css'

interface ModelPickerProps {
  value: string
  providerId: string
  onChange: (modelId: string, providerId: string) => void
  filterCaps?: ModelCapability[]
  placeholder?: string
}

const CAP_LABELS: Record<ModelCapability, string> = {
  vision: 'Vision', tools: 'Tools', reasoning: 'Reasoning',
  code: 'Code', embedding: 'Embed', tts: 'TTS', stt: 'STT',
}
const SPEED_LABEL: Record<string, string> = { fast: 'Быстро', medium: 'Средне', slow: 'Медленно' }
const SPEED_COLOR: Record<string, string> = { fast: '#4ade80', medium: '#facc15', slow: '#f87171' }

function formatCtx(n: number): string {
  if (!n) return '—'
  if (n >= 1_000_000) return `${n / 1_000_000}M`
  return `${n / 1_000}K`
}
function formatPrice(n?: number): string {
  if (n === undefined) return '—'
  return `$${n.toFixed(2)}`
}
function getProviderColor(pid: string): string {
  const colors: Record<string, string> = {
    openai: '#10a37f', anthropic: '#d4763b', google: '#4285f4',
    groq: '#f55036', mistral: '#ff7000', ollama: '#aaaaaa',
    cohere: '#39594d', together: '#7c3aed', fireworks: '#ef4444',
    deepseek: '#2563eb', xai: '#ffffff', onlysq: '#a855f7', voidai: '#06b6d4',
  }
  return colors[pid] || '#888'
}

const DROP_H = 420

export default function ModelPicker({ value, providerId, onChange, filterCaps, placeholder }: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [models, setModels] = useState<ModelMeta[]>([])
  const [dropPos, setDropPos] = useState<{ top?: number; bottom?: number; left: number; width: number; openUp: boolean } | null>(null)
  const [hovered, setHovered] = useState<ModelMeta | null>(null)
  const [tooltipPos, setTooltipPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    window.syntee.models.getAll()
      .then((all: ModelMeta[]) => setModels(all))
      .catch((e: unknown) => console.error('[ModelPicker] getAll error', e))
  }, [open])

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
  }, [open])

  const handleOpen = () => {
    if (!btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom
    const openUp = spaceBelow < DROP_H + 12
    setDropPos({
      left: r.left,
      width: Math.max(r.width, 300),
      openUp,
      ...(openUp
        ? { bottom: window.innerHeight - r.top + 4 }
        : { top: r.bottom + 4 }),
    })
    setOpen(o => !o)
  }

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    document.addEventListener('mousedown', close)
    // НЕ вешаем scroll — мешает скролу внутри дропдауна
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  // Фильтрация
  let filtered = models
  if (filterCaps?.length) filtered = filtered.filter(m => filterCaps.every(c => m.capabilities.includes(c)))
  if (query.trim()) {
    const q = query.toLowerCase()
    filtered = filtered.filter(m =>
      m.name.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q) ||
      m.providerId.toLowerCase().includes(q)
    )
  }

  // Группировка
  const grouped = filtered.reduce<Record<string, ModelMeta[]>>((acc, m) => {
    if (!acc[m.providerId]) acc[m.providerId] = []
    acc[m.providerId].push(m)
    return acc
  }, {})

  const current = models.find(m => m.id === value && m.providerId === providerId)

  const handleItemHover = (e: React.MouseEvent, m: ModelMeta) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setTooltipPos({ top: r.top, left: (dropPos?.left ?? 0) + (dropPos?.width ?? 300) + 8 })
    setHovered(m)
  }

  return (
    <div className="model-picker">
      <motion.button
        ref={btnRef}
        className="model-picker-btn glass"
        onClick={handleOpen}
        whileTap={{ scale: 0.97 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      >
        <span className="model-picker-provider-dot" style={{ background: getProviderColor(providerId) }} />
        <span className="model-picker-label">
          {current ? current.name : (placeholder || 'Выберите модель')}
        </span>
        <AppIcon name={open ? 'chevronUp' : 'chevronDown'} size="sm" />
      </motion.button>

      {createPortal(
        <>
          <AnimatePresence>
            {open && dropPos && (
              <motion.div
                className="model-picker-dropdown glass"
                style={{
                  position: 'fixed',
                  left: dropPos.left,
                  width: dropPos.width,
                  zIndex: 9999,
                  ...(dropPos.openUp ? { bottom: dropPos.bottom } : { top: dropPos.top }),
                }}
                initial={{ opacity: 0, y: dropPos.openUp ? 6 : -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: dropPos.openUp ? 6 : -8 }}
                transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                onMouseDown={e => e.stopPropagation()}
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
                      {mods.map((m, idx) => (
                        <motion.div
                          key={m.id}
                          className={`model-picker-item ${m.id === value && m.providerId === providerId ? 'model-picker-item--active' : ''}`}
                          initial={{ opacity: 0, x: -8 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ type: 'spring', stiffness: 400, damping: 28, delay: idx * 0.018 }}
                          onClick={() => { onChange(m.id, m.providerId); setOpen(false); setQuery('') }}
                          onMouseEnter={e => handleItemHover(e, m)}
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
                        </motion.div>
                      ))}
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Tooltip — отдельный portal слой */}
          <AnimatePresence>
            {hovered && open && (
              <motion.div
                className="model-picker-tooltip glass"
                style={{ position: 'fixed', top: tooltipPos.top, left: tooltipPos.left, zIndex: 10000 }}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.12 }}
              >
                <div className="mpt-name">{hovered.name}</div>
                <div className="mpt-id">{hovered.id}</div>
                <div className="mpt-row">
                  <span className="mpt-label">Контекст</span>
                  <span className="mpt-val">{formatCtx(hovered.contextWindow)}</span>
                </div>
                <div className="mpt-row">
                  <span className="mpt-label">Вход</span>
                  <span className="mpt-val">{formatPrice(hovered.inputPrice)} / 1M</span>
                </div>
                <div className="mpt-row">
                  <span className="mpt-label">Выход</span>
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
                {hovered.description && <div className="mpt-desc">{hovered.description}</div>}
              </motion.div>
            )}
          </AnimatePresence>
        </>,
        document.body
      )}
    </div>
  )
}
