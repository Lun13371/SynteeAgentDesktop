/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useRef, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import { hexToRgb, hexToHsl, normalizeHex, isValidHex, contrastText } from '../../../utils/colorUtils'
import './ColorPicker.css'

export interface ColorPickerProps {
  value: string
  onChange: (hex: string) => void
  onCommit?: (hex: string) => void
  recent?: string[]
  className?: string
}

interface SV { s: number; v: number }

function hexToSV(hex: string): SV {
  const hsl = hexToHsl(hex)
  if (!hsl) return { s: 100, v: 100 }
  const l = hsl.l / 100
  const s = hsl.s / 100
  const v = l + s * Math.min(l, 1 - l)
  const sOut = v === 0 ? 0 : 2 * (1 - l / v)
  return { s: sOut * 100, v: v * 100 }
}

function svToHex(h: number, s: number, v: number): string {
  v = Math.max(0, Math.min(100, v)) / 100
  s = Math.max(0, Math.min(100, s)) / 100
  const c = v * s
  const hp = ((h % 360) + 360) % 360 / 60
  const x = c * (1 - Math.abs(hp % 2 - 1))
  let r = 0, g = 0, b = 0
  if (hp < 1) { r = c; g = x; b = 0 }
  else if (hp < 2) { r = x; g = c; b = 0 }
  else if (hp < 3) { r = 0; g = c; b = x }
  else if (hp < 4) { r = 0; g = x; b = c }
  else if (hp < 5) { r = x; g = 0; b = c }
  else { r = c; g = 0; b = x }
  const m = v - c
  const toHex = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

export default function ColorPicker({ value, onChange, onCommit, recent = [], className }: ColorPickerProps) {
  const [hex, setHex] = useState(value)
  const [h, setH] = useState(0)
  const [sv, setSV] = useState<SV>({ s: 100, v: 100 })
  const svRef = useRef<HTMLDivElement>(null)
  const draggingSV = useRef(false)
  const draggingHue = useRef(false)

  useEffect(() => {
    const hsl = hexToHsl(value)
    if (hsl) {
      setH(hsl.h)
      setSV(hexToSV(value))
    }
    setHex(value)
  }, [value])

  const commit = useCallback((next: string) => {
    onChange(next)
    onCommit?.(next)
  }, [onChange, onCommit])

  const updateFromSV = useCallback((newH: number, newSV: SV) => {
    const next = svToHex(newH, newSV.s, newSV.v)
    setHex(next)
    onChange(next)
  }, [onChange])

  const handleSVPointer = useCallback((e: PointerEvent | React.PointerEvent) => {
    const el = svRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const x = Math.max(0, Math.min(rect.width, (e as PointerEvent).clientX - rect.left))
    const y = Math.max(0, Math.min(rect.height, (e as PointerEvent).clientY - rect.top))
    const newSV = { s: (x / rect.width) * 100, v: 100 - (y / rect.height) * 100 }
    setSV(newSV)
    updateFromSV(h, newSV)
  }, [h, updateFromSV])

  const handleHuePointer = useCallback((e: PointerEvent | React.PointerEvent, el: HTMLElement) => {
    const rect = el.getBoundingClientRect()
    const y = Math.max(0, Math.min(rect.height, (e as PointerEvent).clientY - rect.top))
    const newH = (y / rect.height) * 360
    setH(newH)
    const next = svToHex(newH, sv.s, sv.v)
    setHex(next)
    onChange(next)
  }, [sv, onChange])

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (draggingSV.current) handleSVPointer(e)
      else if (draggingHue.current) {
        const el = document.querySelector('.colorpicker-hue') as HTMLElement
        if (el) handleHuePointer(e, el)
      }
    }
    const onUp = () => {
      if (draggingSV.current || draggingHue.current) {
        draggingSV.current = false
        draggingHue.current = false
        commit(hex)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [hex, handleSVPointer, handleHuePointer, commit])

  const onHexInput = (raw: string) => {
    setHex(raw)
    const norm = normalizeHex(raw)
    if (norm && isValidHex(raw)) {
      const hsl = hexToHsl(norm)
      if (hsl) {
        setH(hsl.h)
        setSV(hexToSV(norm))
      }
      onChange(norm)
    }
  }

  const onHexBlur = () => {
    const norm = normalizeHex(hex)
    if (norm) commit(norm)
    else setHex(value)
  }

  const rgb = hexToRgb(hex) || { r: 255, g: 255, b: 255 }
  const onAccent = contrastText(svToHex(h, sv.s, sv.v))

  const pickEyeDropper = async () => {
    const EyeDropper = (window as any).EyeDropper
    if (!EyeDropper) return
    try {
      const res = await new EyeDropper().open()
      const c = res.sRGBHex as string
      setHex(c)
      const hsl = hexToHsl(c)
      if (hsl) { setH(hsl.h); setSV(hexToSV(c)) }
      commit(c)
    } catch { /* cancelled */ }
  }

  return (
    <div className={`colorpicker ${className || ''}`}>
      <div className="colorpicker-sv-wrap">
        <div
          ref={svRef}
          className="colorpicker-sv"
          style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${h}, 100%, 50%))` }}
          onPointerDown={(e) => { draggingSV.current = true; (e.target as Element).setPointerCapture?.(e.pointerId); handleSVPointer(e) }}
        >
          <div
            className="colorpicker-cursor"
            style={{ left: `${sv.s}%`, top: `${100 - sv.v}%`, background: hex, borderColor: onAccent }}
          />
        </div>
      </div>

      <div className="colorpicker-controls">
        <div
          className="colorpicker-hue"
          onPointerDown={(e) => { draggingHue.current = true; (e.target as Element).setPointerCapture?.(e.pointerId); handleHuePointer(e, e.currentTarget as HTMLElement) }}
        >
          <div className="colorpicker-hue-thumb" style={{ top: `${(h / 360) * 100}%` }} />
        </div>
        <div className="colorpicker-preview" style={{ background: svToHex(h, sv.s, sv.v) }} />
      </div>

      <div className="colorpicker-inputs">
        <label className="colorpicker-field">
          <span>HEX</span>
          <input
            value={hex}
            onChange={(e) => onHexInput(e.target.value)}
            onBlur={onHexBlur}
            spellCheck={false}
          />
        </label>
        <label className="colorpicker-field">
          <span>R</span>
          <input
            type="number" min={0} max={255} value={Math.round(rgb.r)}
            onChange={(e) => {
              const v = Math.max(0, Math.min(255, Number(e.target.value) || 0))
              const next = `#${v.toString(16).padStart(2, '0')}${Math.round(rgb.g).toString(16).padStart(2, '0')}${Math.round(rgb.b).toString(16).padStart(2, '0')}`
              setHex(next)
              const hsl = hexToHsl(next)
              if (hsl) { setH(hsl.h); setSV(hexToSV(next)) }
              onChange(next)
            }}
          />
        </label>
        <label className="colorpicker-field">
          <span>G</span>
          <input
            type="number" min={0} max={255} value={Math.round(rgb.g)}
            onChange={(e) => {
              const v = Math.max(0, Math.min(255, Number(e.target.value) || 0))
              const next = `#${Math.round(rgb.r).toString(16).padStart(2, '0')}${v.toString(16).padStart(2, '0')}${Math.round(rgb.b).toString(16).padStart(2, '0')}`
              setHex(next)
              const hsl = hexToHsl(next)
              if (hsl) { setH(hsl.h); setSV(hexToSV(next)) }
              onChange(next)
            }}
          />
        </label>
        <label className="colorpicker-field">
          <span>B</span>
          <input
            type="number" min={0} max={255} value={Math.round(rgb.b)}
            onChange={(e) => {
              const v = Math.max(0, Math.min(255, Number(e.target.value) || 0))
              const next = `#${Math.round(rgb.r).toString(16).padStart(2, '0')}${Math.round(rgb.g).toString(16).padStart(2, '0')}${v.toString(16).padStart(2, '0')}`
              setHex(next)
              const hsl = hexToHsl(next)
              if (hsl) { setH(hsl.h); setSV(hexToSV(next)) }
              onChange(next)
            }}
          />
        </label>
        {(window as any).EyeDropper && (
          <button
            type="button"
            className="colorpicker-eyedropper"
            onClick={pickEyeDropper}
            title="Пипетка"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>
            </svg>
          </button>
        )}
      </div>

      {recent.length > 0 && (
        <div className="colorpicker-recent">
          <span className="colorpicker-recent-label">Недавние</span>
          <div className="colorpicker-recent-list">
            {recent.map((c, i) => (
              <motion.button
                key={i + c}
                type="button"
                className="colorpicker-recent-swatch"
                style={{ background: c }}
                onClick={() => {
                  setHex(c)
                  const hsl = hexToHsl(c)
                  if (hsl) { setH(hsl.h); setSV(hexToSV(c)) }
                  commit(c)
                }}
                whileTap={{ scale: 0.85 }}
                title={c}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
