import { useState, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ModelMeta, ModelAssignment, Provider } from '../../../../../shared/types'
import AppIcon from '../AppIcon/AppIcon'
import BrandAvatar from '../BrandAvatar/BrandAvatar'
import { CAP_LABELS, SPEED_LABEL, SPEED_COLOR, formatCtx, formatPrice, getProviderColor, getBrandLogo } from '../../../utils/modelFormat'
import './ModelSelector.css'

interface ModelSelectorProps {
  /** Текущий modelId назначения main (для подсветки активного пункта). */
  modelId: string
  /** Колбэк при выборе модели — меняет main-назначение. */
  onChange: (modelId: string, providerId: string) => void
}

const DROP_H = 420

export default function ModelSelector({ modelId, onChange }: ModelSelectorProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [models, setModels] = useState<ModelMeta[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [assignment, setAssignment] = useState<ModelAssignment | null>(null)
  const [dropPos, setDropPos] = useState<{ top?: number; bottom?: number; left: number; width: number; openUp: boolean } | null>(null)
  const [hovered, setHovered] = useState<ModelMeta | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Загружаем модели + провайдеров + main-назначение при открытии
  // (также один раз на маунте для бейджа). Провайдеры нужны для аватаров —
  // getBrandLogo() смотрит на provider.type, а не на providerId.
  const lastLoadedAtRef = useRef(0)
  const loadData = async () => {
    try {
      const [all, assigns, provs] = await Promise.all([
        window.syntee.models.getAll() as Promise<ModelMeta[]>,
        window.syntee.models.getAssignments() as Promise<ModelAssignment[]>,
        window.syntee.providers.getAll() as Promise<Provider[]>,
      ])
      setModels(all)
      setProviders(provs)
      const main = assigns.find(a => a.role === 'main') ?? null
      setAssignment(main)
      lastLoadedAtRef.current = Date.now()
    } catch (e) {
      console.error('[ModelSelector] load error', e)
    }
  }

  // Map по providerId для быстрого доступа к provider.type при рендере пунктов.
  const providerMap = useRef<Map<string, Provider>>(new Map())
  providerMap.current = new Map(providers.map(p => [p.id, p]))

  useEffect(() => { loadData() }, [])

  // Не гоняем IPC round-trip на каждое открытие — список моделей/провайдеров
  // меняется редко. Перегружаем только если данные старше 5с (защита от
  // staleness, если пользователь поменял провайдеров в этой же сессии).
  useEffect(() => {
    if (open) {
      if (Date.now() - lastLoadedAtRef.current > 5000) loadData()
      setTimeout(() => inputRef.current?.focus(), 50)
    } else {
      setQuery('')
    }
  }, [open])

  // Закрытие по клику снаружи
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return
      if (dropRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const t = setTimeout(() => document.addEventListener('mousedown', close), 0)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', close) }
  }, [open])

  const handleOpen = () => {
    if (!btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom
    const openUp = spaceBelow < DROP_H + 12
    const dropW = 320
    const rawLeft = r.right - dropW
    const left = Math.max(8, Math.min(rawLeft, window.innerWidth - dropW - 8))
    setDropPos({
      left,
      width: dropW,
      openUp,
      ...(openUp ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
    })
    setOpen(o => !o)
  }

  // Hover-тултип со статами модели. По умолчанию справа от дропдауна;
  // если справа нет места (220px ширина тултипа + 8px отступ) — слева.
  // Fix 2: clamp по вертикали — не уходить за низ экрана, при необходимости
  // переворачивать тултип вверх (иначе нижние модели показывают тултип за viewport).
  const handleItemHover = (e: React.MouseEvent, m: ModelMeta) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const dropLeft = dropPos?.left ?? 0
    const dropW = dropPos?.width ?? 320
    const tooltipW = 220
    const tooltipH = 280 // примерная высота тултипа с caps + description
    const rightLeft = dropLeft + dropW + 8
    const left = rightLeft + tooltipW > window.innerWidth - 8
      ? dropLeft - tooltipW - 8
      : rightLeft

    // Если тултип не помещается снизу от текущей позиции item —
    // прижимаем к нижнему краю viewport или переворачиваем вверх.
    const maxTop = window.innerHeight - tooltipH - 8
    let top = Math.min(r.top, Math.max(8, maxTop))
    if (r.top > maxTop) {
      // Открываем вверх: низ тултипа на уровне низа item + отступ
      const topUp = r.bottom - tooltipH + Math.round(r.height / 2)
      if (topUp > 8) top = topUp
    }

    setTooltipPos({ top, left })
    setHovered(m)
  }

  // Текущая модель для бейджа
  const current = assignment
    ? models.find(m => m.id === assignment.modelId && m.providerId === assignment.providerId)
    : undefined
  const displayModelId = assignment?.modelId ?? modelId
  const displayProviderId = assignment?.providerId ?? ''
  const displayName = current?.name ?? displayModelId ?? 'Модель не выбрана'
  // Аватар текущей модели для бейджа в шапке
  const currentProvider = providerMap.current.get(displayProviderId)
  const currentLogo = currentProvider
    ? getBrandLogo(currentProvider.type, displayModelId, displayName, currentProvider.iconUrl)
    : null

  // Фильтрация по поиску + группировка по провайдеру. Мемоизируем по
  // [models, query] — иначе grouped был бы новым объектом на каждый
  // рендер (включая hover/scroll), и useMemo(rows, [grouped]) ниже
  // не давал бы эффекта, съедая пользу от виртуализации (Fix 7).
  const grouped = useMemo(() => {
    let filtered = models
    if (query.trim()) {
      const q = query.toLowerCase()
      filtered = filtered.filter(m =>
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.providerId.toLowerCase().includes(q)
      )
    }
    return filtered.reduce<Record<string, ModelMeta[]>>((acc, m) => {
      if (!acc[m.providerId]) acc[m.providerId] = []
      acc[m.providerId].push(m)
      return acc
    }, {})
  }, [models, query])

  // Fix 7: виртуализация списка. Строим плоский массив рядов
  // (header | item), чтобы один useVirtualizer покрывал весь список.
  // Раньше рендерились ВСЕ модели с per-item motion.div + delay — при 100+
  // моделях это вызывало лаг при открытии дропдауна.
  type Row =
    | { type: 'header'; providerId: string; key: string }
    | { type: 'item'; model: ModelMeta; key: string }

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const [pid, mods] of Object.entries(grouped)) {
      out.push({ type: 'header', providerId: pid, key: `h-${pid}` })
      for (const m of mods) {
        out.push({ type: 'item', model: m, key: `i-${m.id}-${m.providerId}` })
      }
    }
    return out
  }, [grouped])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (i) => rows[i].type === 'header' ? 26 : 32,
    overscan: 8,
  })

  const handleSelect = (m: ModelMeta) => {
    onChange(m.id, m.providerId)
    // Локально обновляем назначение для мгновенного отклика бейджа
    const next: ModelAssignment = { role: 'main', modelId: m.id, providerId: m.providerId }
    setAssignment(next)
    setOpen(false)
  }

  return (
    <div className="model-selector">
      <motion.button
        ref={btnRef}
        className="model-selector-badge"
        onClick={handleOpen}
        whileTap={{ scale: 0.97 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        title={displayModelId ? `${displayName} (${displayProviderId})` : 'Выбрать модель'}
      >
        <BrandAvatar logo={currentLogo} fallbackColor={getProviderColor(displayProviderId)} size={16} className="model-selector-logo" />
        <span className="model-selector-name">{displayName}</span>
        <AppIcon name={open ? 'chevronUp' : 'chevronDown'} size="xs" />
      </motion.button>

      {createPortal(
        <>
          <AnimatePresence>
            {open && dropPos && (
              <motion.div
                ref={dropRef}
                className="model-selector-dropdown"
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
                <div className="model-selector-search">
                  <AppIcon name="search" size="sm" />
                  <input
                    ref={inputRef}
                    className="model-selector-search-input"
                    placeholder="Поиск моделей..."
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                  />
                  {query && (
                    <button className="model-selector-search-clear" onClick={() => setQuery('')}>
                      <AppIcon name="x" size="xs" />
                    </button>
                  )}
                </div>

                {/* Список (виртуализированный — Fix 7) */}
                <div
                  className="model-selector-list"
                  ref={listRef}
                  onScroll={() => setHovered(null)}
                >
                  {rows.length === 0 && (
                    <div className="model-selector-empty">
                      {query ? 'Ничего не найдено' : 'Модели не найдены'}
                    </div>
                  )}
                  {rows.length > 0 && (
                    <div
                      style={{
                        height: `${virtualizer.getTotalSize()}px`,
                        width: '100%',
                        position: 'relative',
                      }}
                    >
                      {virtualizer.getVirtualItems().map(vRow => {
                        const row = rows[vRow.index]
                        const startY = vRow.start
                        if (row.type === 'header') {
                          const prov = providerMap.current.get(row.providerId)
                          const groupLogo = prov ? getBrandLogo(prov.type, '', '', prov.iconUrl) : null
                          return (
                            <div
                              key={row.key}
                              className="model-selector-group-label"
                              style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                height: '26px',
                                transform: `translateY(${startY}px)`,
                              }}
                            >
                              <BrandAvatar logo={groupLogo} fallbackColor={getProviderColor(row.providerId)} size={16} className="model-selector-provider-logo" />
                              {prov?.name ?? row.providerId}
                            </div>
                          )
                        }
                        const m = row.model
                        const isActive = m.id === displayModelId && m.providerId === displayProviderId
                        const mProv = providerMap.current.get(m.providerId)
                        const mLogo = mProv ? getBrandLogo(mProv.type, m.id, m.name, mProv.iconUrl) : null
                        return (
                          <div
                            key={row.key}
                            className={`model-selector-item ${isActive ? 'model-selector-item--active' : ''}`}
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              width: '100%',
                              height: '32px',
                              transform: `translateY(${startY}px)`,
                            }}
                            onClick={() => handleSelect(m)}
                            onMouseEnter={e => handleItemHover(e, m)}
                            onMouseLeave={() => setHovered(null)}
                          >
                            <BrandAvatar logo={mLogo} fallbackColor={getProviderColor(m.providerId)} size={16} className="model-selector-item-logo" />
                            <span className="model-selector-item-name">{m.name}</span>
                            {isActive && <AppIcon name="check" size="xs" tone="accent" />}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Tooltip со статами модели */}
          <AnimatePresence>
            {hovered && open && (
              <motion.div
                className="model-selector-tooltip"
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
