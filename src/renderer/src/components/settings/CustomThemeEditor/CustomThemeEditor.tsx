import { useState, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { copyToClipboard } from '@renderer/utils/clipboard'
import { v4 as uuid } from 'uuid'
import ColorPickerPopover from '../../ui/ColorPicker/ColorPickerPopover'
import { normalizeHex } from '../../../utils/colorUtils'
import { applyCustomThemeToDOM } from '../../../App'
import type { CustomTheme } from '../../../../../shared/types'
import './CustomThemeEditor.css'

interface Props {
  themes: CustomTheme[]
  activeId: string | null
  onChange: (themes: CustomTheme[], activeId?: string | null) => void
  onApply: (id: string) => void
}

const DEFAULT_COLORS = {
  bodyBg: '#0e0e12',
  bgPrimary: 'rgba(20, 20, 26, 0.82)',
  bgSecondary: 'rgba(28, 28, 36, 0.85)',
  bgTertiary: 'rgba(38, 38, 48, 0.88)',
  textPrimary: '#e8e8ec',
  textSecondary: '#9a9aa5',
  textMuted: '#5c5c68',
  accent: '#4d9fff',
  sidebarBg: 'rgba(14, 14, 18, 0.88)',
  border: '',
  borderStrong: '',
  accentGradient: '',
  shadowColor: '',
}

const COLOR_FIELDS: { key: keyof CustomTheme['colors']; label: string }[] = [
  { key: 'bodyBg', label: 'Фон' },
  { key: 'bgPrimary', label: 'Surface 1' },
  { key: 'bgSecondary', label: 'Surface 2' },
  { key: 'bgTertiary', label: 'Surface 3' },
  { key: 'textPrimary', label: 'Текст' },
  { key: 'textSecondary', label: 'Текст 2' },
  { key: 'textMuted', label: 'Текст 3' },
  { key: 'accent', label: 'Акцент' },
  { key: 'sidebarBg', label: 'Сайдбар' },
  { key: 'border', label: 'Границы' },
  { key: 'borderStrong', label: 'Границы+' },
  { key: 'accentGradient', label: 'Акцент 2' },
  { key: 'shadowColor', label: 'Цвет тени' },
]

function makeTheme(name: string, base: 'light' | 'dark'): CustomTheme {
  return {
    id: uuid(),
    name,
    base,
    colors: { ...DEFAULT_COLORS },
    glass: { blur: 20, saturate: 180, opacity: 100 },
    effects: { overlayIntensity: 1 },
  }
}

export default function CustomThemeEditor({ themes, activeId, onChange, onApply }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [openPicker, setOpenPicker] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState('')
  const [exportMsg, setExportMsg] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  // Ref на активную swatch-кнопку для позиционирования ColorPickerPopover.
  // Только один picker открыт одновременно, поэтому один ref достаточно.
  // Picker рендерится через портал в document.body — иначе обрезается
  // overflow:hidden у .cte-item и motion.div обёртки.
  const activeSwatchRef = useRef<HTMLButtonElement>(null)
  // draftColor — локальный стейт для цвета в процессе драга пикера.
  // Во время драга НЕ вызываем onChange (IPC-persist), только обновляем DOM
  // через applyCustomThemeToDOM. На pointerup (onCommit) — полный persist.
  const [draftColor, setDraftColor] = useState<{ themeId: string; key: string; value: string } | null>(null)
  // Таймер для debounce persist glass-слайдеров (аналогичная причина —
  // не дёргать IPC на каждый тик range input).
  const glassTimer = useRef<number | null>(null)
  // rAF-throttle для applyCustomThemeToDOM — переписывает <style> с CSS-переменными
  // на каждый pointermove → полная пересчётка стилей. С rAF — не чаще 1 раза/кадр.
  const themeRafRef = useRef<number | null>(null)
  // Последний аргумент для отложенного applyCustomThemeToDOM (чтобы rAF взял актуальный).
  const themeRafData = useRef<{ id: string; theme: CustomTheme } | null>(null)

  // Отложенное применение темы к DOM (не чаще 1 раза за кадр).
  const scheduleThemeApply = (id: string, theme: CustomTheme) => {
    themeRafData.current = { id, theme }
    if (themeRafRef.current) return // уже запланирован — данные обновятся
    themeRafRef.current = requestAnimationFrame(() => {
      themeRafRef.current = null
      const data = themeRafData.current
      if (data && data.id === activeId) applyCustomThemeToDOM(data.theme)
    })
  }

  const createTheme = () => {
    const name = `Моя тема ${themes.length + 1}`
    const t = makeTheme(name, 'dark')
    onChange([...themes, t], t.id)
    setEditingId(t.id)
    setTimeout(() => nameRef.current?.focus(), 50)
  }

  const updateTheme = (id: string, patch: Partial<CustomTheme>) => {
    onChange(themes.map(t => t.id === id ? { ...t, ...patch } : t))
    const updated = themes.find(t => t.id === id)
    if (updated && id === activeId) {
      applyCustomThemeToDOM({ ...updated, ...patch })
    }
  }

  const updateColor = (id: string, key: keyof CustomTheme['colors'], value: string) => {
    onChange(themes.map(t => t.id === id ? { ...t, colors: { ...t.colors, [key]: value } } : t))
    const t = themes.find(x => x.id === id)
    if (t && id === activeId) {
      applyCustomThemeToDOM({ ...t, colors: { ...t.colors, [key]: value } })
    }
  }

  // Живой preview при драге пикера — только DOM (rAF-throttled), без IPC-пersist.
  const previewColor = (id: string, key: keyof CustomTheme['colors'], value: string) => {
    setDraftColor({ themeId: id, key: String(key), value })
    const t = themes.find(x => x.id === id)
    if (t && id === activeId) {
      scheduleThemeApply(id, { ...t, colors: { ...t.colors, [key]: value } })
    }
  }

  // Glass-слайдеры: DOM обновляется мгновенно (rAF-throttled), IPC-persist debounce 300мс.
  const updateGlassDebounced = (id: string, key: keyof CustomTheme['glass'], value: number) => {
    const t = themes.find(x => x.id === id)
    if (t && id === activeId) {
      scheduleThemeApply(id, { ...t, glass: { ...t.glass, [key]: value } })
    }
    if (glassTimer.current) clearTimeout(glassTimer.current)
    glassTimer.current = window.setTimeout(() => {
      onChange(themes.map(t2 => t2.id === id ? { ...t2, glass: { ...t2.glass, [key]: value } } : t2))
    }, 300)
  }

  const duplicate = (t: CustomTheme) => {
    const copy = { ...t, id: uuid(), name: `${t.name} копия` }
    onChange([...themes, copy])
  }

  const remove = (id: string) => {
    onChange(themes.filter(t => t.id !== id), id === activeId ? null : undefined)
    if (editingId === id) setEditingId(null)
  }

  const exportTheme = async (t: CustomTheme) => {
    const json = JSON.stringify(t, null, 2)
    const ok = await copyToClipboard(json)
    if (!ok) return
    setExportMsg('Скопировано в буфер!')
    setTimeout(() => setExportMsg(''), 2000)
  }

  const doImport = () => {
    try {
      const parsed = JSON.parse(importText) as CustomTheme
      if (!parsed.name || !parsed.colors || !parsed.glass) {
        setImportError('Неверный формат темы')
        return
      }
      const t = { ...parsed, id: uuid() }
      onChange([...themes, t], t.id)
      setImportOpen(false)
      setImportText('')
      setImportError('')
    } catch {
      setImportError('Ошибка парсинга JSON')
    }
  }

  // Импорт из файла (.json)
  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    const reader = new FileReader()
    reader.onload = () => {
      const text = reader.result as string
      try {
        const parsed = JSON.parse(text) as CustomTheme
        if (!parsed.name || !parsed.colors || !parsed.glass) {
          setImportError('Неверный формат темы в файле')
          return
        }
        const t = { ...parsed, id: uuid() }
        onChange([...themes, t], t.id)
        setImportOpen(false)
        setImportText('')
        setImportError('')
      } catch {
        setImportError('Ошибка парсинга файла')
      }
    }
    reader.onerror = () => setImportError('Не удалось прочитать файл')
    reader.readAsText(file)
  }

  return (
    <div className="cte-root">
      <div className="cte-header">
        <h3 className="cte-title">Кастомные темы</h3>
        <div className="cte-actions">
          <motion.button className="cte-btn" whileTap={{ scale: 0.95 }} onClick={createTheme}>＋ Создать</motion.button>
          <motion.button className="cte-btn" whileTap={{ scale: 0.95 }} onClick={() => { setImportOpen(v => !v); setImportError('') }}>Импорт</motion.button>
        </div>
      </div>

      <AnimatePresence>
        {importOpen && (
          <motion.div
            className="cte-import"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            style={{ overflow: 'hidden' }}
          >
            <textarea
              className="cte-import-text"
              placeholder="Вставьте JSON темы..."
              value={importText}
              onChange={e => setImportText(e.target.value)}
              rows={4}
            />
            {importError && <div className="cte-import-msg">{importError}</div>}
            <div className="cte-import-actions">
              <motion.button className="cte-btn cte-btn--primary" whileTap={{ scale: 0.95 }} onClick={doImport}>Применить</motion.button>
              <motion.button className="cte-btn" whileTap={{ scale: 0.95 }} onClick={() => fileInputRef.current?.click()}>Из файла</motion.button>
              <input ref={fileInputRef} type="file" accept=".json,application/json" onChange={onPickFile} style={{ display: 'none' }} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {exportMsg && <div className="cte-import-msg" style={{ color: 'var(--accent)' }}>{exportMsg}</div>}

      {themes.length === 0 && (
        <div className="cte-empty">Нет кастомных тем. Нажмите «Создать».</div>
      )}

      <div className="cte-list">
        {themes.map(t => (
          <div key={t.id} className={`cte-item${t.id === editingId ? ' cte-item--editing' : ''}`}>
            <div className="cte-item-row">
              <button
                className="cte-item-preview"
                style={{ background: t.colors.bodyBg, borderColor: t.colors.accent + '22' }}
                onClick={() => onApply(t.id)}
                title="Применить"
              >
                <div className="cte-item-sidebar" style={{ background: t.colors.bgSecondary }} />
                <div className="cte-item-bubble" style={{ background: t.colors.accent }} />
              </button>
              <input
                ref={t.id === editingId ? nameRef : undefined}
                className="cte-item-name"
                value={t.name}
                onChange={e => updateTheme(t.id, { name: e.target.value })}
              />
              <div className="cte-item-actions">
                <button className="cte-icon-btn" onClick={() => setEditingId(editingId === t.id ? null : t.id)} title="Редактировать">
                  {editingId === t.id ? '▲' : '▼'}
                </button>
                <button className="cte-icon-btn" onClick={() => duplicate(t)} title="Дублировать">⧉</button>
                <button className="cte-icon-btn" onClick={() => exportTheme(t)} title="Экспорт JSON">⤓</button>
                <button className="cte-icon-btn cte-icon-btn--danger" onClick={() => remove(t.id)} title="Удалить">✕</button>
              </div>
            </div>

            {editingId === t.id && (
              <AnimatePresence>
                <motion.div
                  className="cte-edit"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  style={{ overflow: 'hidden' }}
                >
                <div className="cte-edit-row">
                  <label className="cte-edit-label">Базовый режим</label>
                  <div className="cte-base-toggle">
                    <button
                      className={`cte-base-btn ${t.base === 'dark' ? 'cte-base-btn--active' : ''}`}
                      onClick={() => updateTheme(t.id, { base: 'dark' })}
                    >Тёмный</button>
                    <button
                      className={`cte-base-btn ${t.base === 'light' ? 'cte-base-btn--active' : ''}`}
                      onClick={() => updateTheme(t.id, { base: 'light' })}
                    >Светлый</button>
                  </div>
                </div>

                <div className="cte-colors">
                  {COLOR_FIELDS.map(f => {
                    const keyStr = String(f.key)
                    return (
                    <div key={keyStr} className="cte-color-field">
                      <label className="cte-color-label">{f.label}</label>
                      <button
                        ref={openPicker === keyStr ? activeSwatchRef : undefined}
                        className="cte-color-swatch"
                        style={{ background: (draftColor?.themeId === t.id && draftColor?.key === keyStr) ? draftColor.value : t.colors[f.key] }}
                        onClick={() => setOpenPicker(openPicker === keyStr ? null : keyStr)}
                      />
                      <input
                        className="cte-color-input"
                        value={(draftColor?.themeId === t.id && draftColor?.key === keyStr) ? draftColor.value : t.colors[f.key]}
                        onChange={e => {
                          const v = e.target.value
                          updateColor(t.id, f.key, v)
                          setDraftColor(null)
                        }}
                      />
                      <ColorPickerPopover
                        open={openPicker === keyStr}
                        onClose={() => {
                          if (themeRafRef.current) { cancelAnimationFrame(themeRafRef.current); themeRafRef.current = null }
                          setDraftColor(null)
                          setOpenPicker(null)
                        }}
                        anchorRef={activeSwatchRef}
                        value={normalizeHex(t.colors[f.key]) || '#ffffff'}
                        onChange={(c) => previewColor(t.id, f.key, c)}
                        onCommit={(c) => {
                          // Отменяем отложенный rAF — updateColor вызовет
                          // applyCustomThemeToDOM синхронно с финальным цветом.
                          if (themeRafRef.current) { cancelAnimationFrame(themeRafRef.current); themeRafRef.current = null }
                          updateColor(t.id, f.key, c)
                          setDraftColor(null)
                        }}
                      />
                    </div>
                    )
                  })}
                </div>

                <div className="cte-glass">
                  <label className="cte-glass-label">Glass blur: {t.glass.blur}px</label>
                  <input type="range" min={0} max={40} value={t.glass.blur}
                    onChange={e => updateGlassDebounced(t.id, 'blur', Number(e.target.value))} className="settings-slider" />
                  <label className="cte-glass-label">Glass saturate: {t.glass.saturate}%</label>
                  <input type="range" min={100} max={300} value={t.glass.saturate}
                    onChange={e => updateGlassDebounced(t.id, 'saturate', Number(e.target.value))} className="settings-slider" />
                  <label className="cte-glass-label">Glass opacity: {t.glass.opacity}%</label>
                  <input type="range" min={20} max={100} value={t.glass.opacity}
                    onChange={e => updateGlassDebounced(t.id, 'opacity', Number(e.target.value))} className="settings-slider" />
                  <label className="cte-glass-label">Overlay: {Math.round((t.effects?.overlayIntensity ?? 1) * 100)}%</label>
                  <input type="range" min={0.5} max={2} step={0.1} value={t.effects?.overlayIntensity ?? 1}
                    onChange={e => {
                      const v = Number(e.target.value)
                      const t2 = themes.find(x => x.id === t.id)
                      if (t2 && t.id === activeId) applyCustomThemeToDOM({ ...t2, effects: { overlayIntensity: v } })
                      if (glassTimer.current) clearTimeout(glassTimer.current)
                      glassTimer.current = window.setTimeout(() => {
                        onChange(themes.map(t3 => t3.id === t.id ? { ...t3, effects: { overlayIntensity: v } } : t3))
                      }, 300)
                    }}
                    className="settings-slider" />
                </div>

                <div className="cte-edit-actions">
                  <motion.button className="cte-btn cte-btn--primary" whileTap={{ scale: 0.95 }} onClick={() => onApply(t.id)}>
                    Применить тему
                  </motion.button>
                </div>
                </motion.div>
              </AnimatePresence>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
