import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { getReasoningConfig } from '../../../../../shared/reasoningModels'
import './ReasoningSelector.css'

interface ReasoningSelectorProps {
  modelId: string
  value: string
  onChange: (value: string) => void
}

export default function ReasoningSelector({ modelId, value, onChange }: ReasoningSelectorProps) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  const config = getReasoningConfig(modelId)

  // Нет конфига или always_on без вариантов — не рендерим
  if (!config || config.options.length <= 1 && config.paramType === 'always_on') return null

  const effectiveValue = value || config.default
  const current = config.options.find(o => o.value === effectiveValue) ?? config.options[0]

  const handleOpen = () => {
    if (!btnRef.current) return
    const rect = btnRef.current.getBoundingClientRect()
    setPos({ top: rect.top - 8, left: rect.left })
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (btnRef.current && !btnRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  // always_on — просто иконка без дропдауна
  if (config.paramType === 'always_on') {
    return (
      <span className="reasoning-selector-badge" title={config.hint}>
        🧠 reasoning
      </span>
    )
  }

  return (
    <>
      <button
        ref={btnRef}
        className="reasoning-selector-btn"
        onClick={handleOpen}
        title={config.hint}
      >
        <span className="reasoning-selector-icon">🧠</span>
        <span className="reasoning-selector-label">{current.label}</span>
        <svg className="reasoning-selector-chevron" viewBox="0 0 10 6" fill="none">
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </button>

      {open && createPortal(
        <div
          className="reasoning-selector-dropdown"
          style={{ top: pos.top, left: pos.left }}
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="reasoning-selector-dropdown-hint">{config.hint}</div>
          <div className="reasoning-selector-dropdown-param">
            {config.apiParam}
          </div>
          {config.options.map(opt => (
            <button
              key={opt.value}
              className={`reasoning-selector-option ${opt.value === current.value ? 'active' : ''}`}
              onClick={() => { onChange(opt.value); setOpen(false) }}
            >
              <span className="reasoning-selector-option-label">{opt.label}</span>
              {opt.value === current.value && (
                <span className="reasoning-selector-check">✓</span>
              )}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}
