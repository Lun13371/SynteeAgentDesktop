import { useState, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  getReasoningConfig,
  GENERIC_EFFORT_FALLBACK,
  CLAUDE_THINKING_FALLBACK,
  type ModelReasoningConfig,
} from '../../../../../shared/reasoningModels'
import type { ModelMeta } from '../../../../../shared/types'
import { useGatewayModelsStore } from '../../../store/gatewayModels.store'
import { whileHoverSm, whileTapSm, whileHoverListItem, whileTapListItem, springHover } from '../../../utils/motionPresets'
import { chatColumnRight } from '../../../utils/popupAnchor'
import './ReasoningSelector.css'

interface ReasoningSelectorProps {
  modelId: string
  value: string
  onChange: (value: string) => void
}

const PANEL_WIDTH = 264

// ── Иконки опций (в стиле ModelSelector items) ──────────────────────────────
const SparklesIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
    <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round"/>
    <path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
  </svg>
)
const StarIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
    <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round"/>
  </svg>
)
const ZapIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
    <path d="M13 2L4.5 13.5H11L9.5 22 19 10h-6.5L13 2z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round"/>
  </svg>
)
const OffIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7"/>
    <path d="M5.5 5.5l13 13" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/>
  </svg>
)

/** Иконка уровня мышления: off — перечёркнутый круг, low — молния,
 *  medium — звезда, high/остальные — двойная звезда. */
function optionIcon(value: string) {
  if (!value || value === 'off') return OffIcon
  if (value === 'low' || value === 'minimal') return ZapIcon
  if (value === 'medium') return StarIcon
  return SparklesIcon
}

/** Человекочитаемое описание уровня под его названием. */
function optionDesc(config: ModelReasoningConfig, value: string): string {
  switch (config.paramType) {
    case 'thinking_budget':
      return value ? `${value} токенов на размышления` : 'Мышление выключено'
    case 'gemini_budget':
      if (value === '-1') return 'Модель решает сама'
      if (value === '0') return 'Мышление выключено'
      return `${value} токенов на размышления`
    case 'reasoning_format':
      if (value === 'parsed') return 'Мысли — отдельным полем'
      if (value === 'raw') return 'Мысли в тексте (<think>)'
      return 'Без рассуждений'
    default: // reasoning_effort
      if (!value || value === 'off') return 'Мышление выключено'
      if (value === 'minimal') return 'Минимум размышлений'
      if (value === 'low') return 'Быстро — короткие размышления'
      if (value === 'medium') return 'Баланс скорости и глубины'
      if (value === 'high') return 'Максимальная глубина'
      return `Уровень: ${value}`
  }
}

/** Интенсивность мышления для цветовой градации: off → нейтральный,
 *  low → голубой, medium → янтарный, high → фиолетово-розовый.
 *  Бюджетные параметры мапятся по величине токенов. */
function effortLevel(config: ModelReasoningConfig, value: string): 'off' | 'low' | 'medium' | 'high' {
  if (!value || value === 'off') return 'off'
  switch (config.paramType) {
    case 'thinking_budget': {
      const n = parseInt(value)
      if (Number.isNaN(n)) return 'medium'
      if (n <= 5000) return 'low'
      if (n <= 16000) return 'medium'
      return 'high'
    }
    case 'gemini_budget': {
      if (value === '-1') return 'medium'
      if (value === '0') return 'off'
      const n = parseInt(value)
      if (Number.isNaN(n)) return 'medium'
      if (n <= 4096) return 'low'
      if (n <= 16384) return 'medium'
      return 'high'
    }
    case 'reasoning_format':
      return value === 'hidden' ? 'off' : 'medium'
    default:
      if (value === 'minimal' || value === 'low') return 'low'
      if (value === 'medium') return 'medium'
      if (value === 'high' || value === 'max' || value === 'ultra') return 'high'
      return 'medium'
  }
}

export default function ReasoningSelector({ modelId, value, onChange }: ReasoningSelectorProps) {
  const [open, setOpen] = useState(false)
  const [panelPos, setPanelPos] = useState({ bottom: 0, left: 0 })
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  // ── Конфиг мышления — каскад из 3 источников ─────────────────────────────
  // 1) Syntee-Gateway: уровни из /v1/models (reasoning.supported) — authoritative.
  // 2) Статическая таблица reasoningModels.ts (o3, grok-3-mini, gemini, deepseek-r1, claude-4...).
  // 3) Каталог models.dev: у модели capability 'reasoning' → generic-фоллбек
  //    (claude-* → thinking_budget, остальным → reasoning_effort).
  // Ничего не подошло → null: селектор вообще не рендерится.
  const gwModel = useGatewayModelsStore(s => s.models.find(m => m.id === modelId))
  const staticConfig = useMemo(() => getReasoningConfig(modelId), [modelId])
  const needCatalog = !gwModel?.reasoning?.supported && !staticConfig

  // Каталог моделей (для фоллбека) — ленивый IPC-запрос только когда
  // gateway и таблица не дали ответа.
  const [catalogMeta, setCatalogMeta] = useState<ModelMeta | null>(null)
  useEffect(() => {
    if (!needCatalog) return
    let cancelled = false
    ;(window.syntee.models.getAll() as Promise<ModelMeta[]>)
      .then(all => {
        if (cancelled) return
        setCatalogMeta(all.find(m => m.id === modelId) ?? null)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [needCatalog, modelId])

  const config: ModelReasoningConfig | null = useMemo(() => {
    const gwReasoning = gwModel?.reasoning
    if (gwReasoning?.supported) {
      return {
        paramType: 'reasoning_effort',
        apiParam: 'reasoning_effort',
        options: [
          { label: 'off', value: '' },
          ...gwReasoning.levels.map(l => ({ label: l, value: l })),
        ],
        default: '',
        hint: 'Режим мышления — Syntee-Gateway',
      }
    }
    if (staticConfig) return staticConfig
    if (catalogMeta?.capabilities?.includes('reasoning')) {
      return /claude/i.test(modelId) ? CLAUDE_THINKING_FALLBACK : GENERIC_EFFORT_FALLBACK
    }
    return null
  }, [gwModel, staticConfig, catalogMeta, modelId])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return
      const panel = document.getElementById('rs-panel')
      if (!panel?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (!config) return null

  if (config.paramType === 'always_on') {
    return (
      <span className="rs-badge" title={config.hint}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
          <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z"
            stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round"/>
        </svg>
        thinking
      </span>
    )
  }

  const effectiveValue = value || config.default
  const current = config.options.find(o => o.value === effectiveValue) ?? config.options[0]
  // Цветовая градация бейджа по интенсивности мышления
  const level = effortLevel(config, current.value)

  const openPanel = () => {
    if (!btnRef.current) return
    const rect = btnRef.current.getBoundingClientRect()
    const bottom = window.innerHeight - rect.top + 6
    let left = rect.left
    // не выезжаем за правый край колонки чата (а не окна — колонка
    // центрирована, справа от неё пустота)
    const colRight = chatColumnRight(btnRef.current)
    if (left + PANEL_WIDTH > colRight) {
      left = colRight - PANEL_WIDTH
    }
    if (left < 8) left = 8
    setPanelPos({ bottom, left })
    setTooltipPos(null)
    setOpen(v => !v)
  }

  return (
    <>
      <motion.button
        ref={btnRef}
        className={`rs-btn rs-btn--${level}${open ? ' rs-btn--active' : ''}`}
        onClick={openPanel}
        onMouseEnter={() => {
          if (open || !btnRef.current) return
          const rect = btnRef.current.getBoundingClientRect()
          setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top })
        }}
        onMouseLeave={() => setTooltipPos(null)}
        title=""
        whileHover={whileHoverSm}
        whileTap={whileTapSm}
        transition={springHover}
      >
        <svg className="rs-btn-icon" width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z"
            stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round"/>
          <path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z"
            stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
        </svg>
        <span className="rs-btn-val">{current.label}</span>
        <svg className="rs-btn-chevron" viewBox="0 0 10 6" fill="none">
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </motion.button>

      {/* Тултип */}
      {tooltipPos && createPortal(
        <div className="rs-tooltip" style={{ left: tooltipPos.x, top: tooltipPos.y - 38 }}>
          {config.hint}
        </div>,
        document.body
      )}

      {/* Дропдаун — AnimatePresence даёт анимацию и открытия, и закрытия
          (раньше был обычный conditional render без exit-transition). */}
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              id="rs-panel"
              className="rs-panel"
              style={{ bottom: panelPos.bottom, left: panelPos.left, width: PANEL_WIDTH }}
              initial={{ opacity: 0, y: 6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            >
              <div className="rs-panel-head">
                <span className="rs-panel-hint">{config.hint}</span>
                <span className="rs-panel-param">{config.apiParam}</span>
              </div>
              <div className="rs-panel-options">
                {config.options.map(opt => {
                  const active = opt.value === current.value
                  return (
                    <motion.button
                      key={opt.value}
                      className={`rs-option rs-option--${effortLevel(config, opt.value)}${active ? ' rs-option--active' : ''}`}
                      onClick={() => { onChange(opt.value); setOpen(false) }}
                      whileHover={whileHoverListItem}
                      whileTap={whileTapListItem}
                      transition={springHover}
                    >
                      <span className="rs-option-icon">{optionIcon(opt.value)}</span>
                      <span className="rs-option-body">
                        <span className="rs-option-val">{opt.label}</span>
                        <span className="rs-option-desc">{optionDesc(config, opt.value)}</span>
                      </span>
                      {active && (
                        <svg className="rs-option-check" width="12" height="12" viewBox="0 0 12 12" fill="none">
                          <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      )}
                    </motion.button>
                  )
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  )
}
