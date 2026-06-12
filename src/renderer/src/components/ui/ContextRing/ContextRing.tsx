import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { ContextInfo } from '../../../hooks/useContextCounter'
import './ContextRing.css'

interface ContextRingProps {
  info: ContextInfo | null
}

function formatNum(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

function formatCost(cents: number): string {
  if (cents < 1) return `<$0.01`
  if (cents < 100) return `$${(cents / 100).toFixed(3)}`
  return `$${(cents / 100).toFixed(2)}`
}

export default function ContextRing({ info }: ContextRingProps) {
  const [panelOpen, setPanelOpen] = useState(false)
  const [tooltipVisible, setTooltipVisible] = useState(false)
  const ringRef = useRef<HTMLButtonElement>(null)
  const [panelPos, setPanelPos] = useState({ bottom: 0, left: 0 })

  const SIZE = 28
  const STROKE = 3
  const R = (SIZE - STROKE) / 2
  const CIRC = 2 * Math.PI * R
  const percent = info?.percent ?? 0
  const offset = CIRC - (percent / 100) * CIRC

  const color = info?.critical
    ? 'var(--color-danger, #ef4444)'
    : info?.warning
      ? 'var(--color-warning, #f59e0b)'
      : 'var(--accent)'

  useEffect(() => {
    if (panelOpen && ringRef.current) {
      const rect = ringRef.current.getBoundingClientRect()
      setPanelPos({
        bottom: window.innerHeight - rect.top + 8,
        left: rect.left - 20,
      })
    }
  }, [panelOpen])

  // Закрытие панели при клике снаружи
  useEffect(() => {
    if (!panelOpen) return
    const handler = (e: MouseEvent) => {
      if (ringRef.current && !ringRef.current.contains(e.target as Node)) {
        const panel = document.getElementById('ctx-panel')
        if (!panel?.contains(e.target as Node)) setPanelOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [panelOpen])

  return (
    <>
      <button
        ref={ringRef}
        className={`ctx-ring-btn${info?.warning ? ' ctx-ring-warn' : ''}${info?.critical ? ' ctx-ring-crit' : ''}`}
        onClick={() => {
          setPanelOpen(p => !p)
          setTooltipVisible(false)
        }}
        onMouseEnter={() => !panelOpen && setTooltipVisible(true)}
        onMouseLeave={() => setTooltipVisible(false)}
        title=""
      >
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          {/* Трек */}
          <circle
            cx={SIZE / 2} cy={SIZE / 2} r={R}
            fill="none"
            stroke="rgba(255,255,255,0.1)"
            strokeWidth={STROKE}
          />
          {/* Прогресс */}
          <circle
            cx={SIZE / 2} cy={SIZE / 2} r={R}
            fill="none"
            stroke={color}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={offset}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            style={{ transition: 'stroke-dashoffset 0.6s ease, stroke 0.3s ease' }}
          />
          {/* Процент внутри */}
          <text
            x={SIZE / 2} y={SIZE / 2 + 4}
            textAnchor="middle"
            fontSize="7"
            fill={color}
            fontFamily="inherit"
          >
            {info ? `${Math.round(percent)}%` : '…'}
          </text>
        </svg>

        {/* Тултип при hover */}
        {tooltipVisible && info && (
          <div className="ctx-tooltip">
            {formatNum(info.total)} / {formatNum(info.limit)} tok
            <span className="ctx-tooltip-pct"> {percent.toFixed(1)}%</span>
          </div>
        )}
      </button>

      {/* Полная панель при клике — через портал */}
      {panelOpen && info && createPortal(
        <div
          id="ctx-panel"
          className="ctx-panel"
          style={{ bottom: panelPos.bottom, left: panelPos.left }}
        >
          <div className="ctx-panel-header">
            <span className="ctx-panel-title">Контекст</span>
            <span className="ctx-panel-model">{info.modelId}</span>
            <button className="ctx-panel-close" onClick={() => setPanelOpen(false)}>✕</button>
          </div>

          {/* Прогресс-бар */}
          <div className="ctx-bar-wrap">
            <div
              className={`ctx-bar-fill${info.warning ? ' warn' : ''}${info.critical ? ' crit' : ''}`}
              style={{ width: `${Math.min(100, percent)}%` }}
            />
          </div>
          <div className="ctx-bar-label">
            {formatNum(info.total)} / {formatNum(info.limit)} токенов ({percent.toFixed(1)}%)
          </div>

          {/* Разбивка */}
          <div className="ctx-rows">
            <div className="ctx-row">
              <span className="ctx-row-label">System prompt</span>
              <span className="ctx-row-val">{formatNum(info.systemPrompt)} tok</span>
            </div>
            <div className="ctx-row">
              <span className="ctx-row-label">История чата</span>
              <span className="ctx-row-val">{formatNum(info.history)} tok
                {info.historyMessages > 0 && <span className="ctx-row-sub"> ({info.historyMessages} сообщ.)</span>}
              </span>
            </div>
            <div className="ctx-row">
              <span className="ctx-row-label">Текущий ввод</span>
              <span className="ctx-row-val">{formatNum(info.currentInput)} tok</span>
            </div>
            <div className="ctx-row ctx-row-reserved">
              <span className="ctx-row-label">Резерв ответа</span>
              <span className="ctx-row-val">{formatNum(info.reserved)} tok</span>
            </div>
            <div className="ctx-row ctx-row-total">
              <span className="ctx-row-label">Итого</span>
              <span className="ctx-row-val">{formatNum(info.total)} / {formatNum(info.limit)}</span>
            </div>
          </div>

          {/* Цены */}
          <div className="ctx-pricing">
            {info.pricing ? (
              <>
                <span className="ctx-pricing-label">Стоимость запроса:</span>
                <span className="ctx-pricing-val">
                  {info.estimatedCostCents != null
                    ? formatCost(info.estimatedCostCents)
                    : '—'}
                </span>
                <span className="ctx-pricing-sub">
                  ${(info.pricing.inputPerM / 100).toFixed(2)}/M in · ${(info.pricing.outputPerM / 100).toFixed(2)}/M out
                </span>
              </>
            ) : (
              <span className="ctx-pricing-nodata">Нет данных о ценах</span>
            )}
          </div>

          {info.warning && (
            <div className={`ctx-alert${info.critical ? ' ctx-alert-crit' : ''}`}>
              {info.critical ? '⚠ Контекст почти заполнен!' : '⚠ Контекст заполнен более чем на 80%'}
            </div>
          )}
        </div>,
        document.body
      )}
    </>
  )
}
