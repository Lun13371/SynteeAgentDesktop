/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useRef, useEffect, useLayoutEffect, useCallback, memo } from 'react'
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

const THROTTLE_MS = 80
const CURSOR_SIZE = 14   // px, совпадает с CSS .colorpicker-cursor width/height
const THUMB_HEIGHT = 6   // px, совпадает с CSS .colorpicker-hue-thumb height

function ColorPicker({ value, onChange, onCommit, recent = [], className }: ColorPickerProps) {
  const [hex, setHex] = useState(value)
  const [h, setH] = useState(0)
  const [sv, setSV] = useState<SV>({ s: 100, v: 100 })
  const svRef = useRef<HTMLDivElement>(null)
  const cursorRef = useRef<HTMLDivElement>(null)
  const hueThumbRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const svBgRef = useRef<HTMLDivElement>(null)
  const draggingSV = useRef(false)
  const draggingHue = useRef(false)

  const hRef = useRef(0)
  const svRefState = useRef<SV>({ s: 100, v: 100 })

  // Кэш rect на pointerdown — не дёргаем getBoundingClientRect на каждый pointermove
  const svRectCache = useRef<DOMRect | null>(null)
  const hueRectCache = useRef<DOMRect | null>(null)

  const isDragging = useRef(false)
  const throttleRef = useRef<number | null>(null)
  const lastOnChangeRef = useRef<number>(0)
  const pendingHexRef = useRef<string | null>(null)

  const onChangeRef = useRef(onChange)
  const onCommitRef = useRef(onCommit)
  useEffect(() => { onChangeRef.current = onChange }, [onChange])
  useEffect(() => { onCommitRef.current = onCommit }, [onCommit])

  // Синхронизация value → state + DOM refs (когда НЕ драгаем)
  useLayoutEffect(() => {
    if (isDragging.current) return
    const hsl = hexToHsl(value)
    if (hsl) {
      setH(hsl.h); hRef.current = hsl.h
      const newSV = hexToSV(value)
      setSV(newSV); svRefState.current = newSV
      // Пишем пиксели в transform — нужен rect для вычисления позиции
      const svEl = svRef.current
      if (svEl) {
        const rect = svEl.getBoundingClientRect()
        const px = (newSV.s / 100) * rect.width
        const py = (1 - newSV.v / 100) * rect.height
        if (cursorRef.current) {
          cursorRef.current.style.transform = `translate(${px - CURSOR_SIZE / 2}px, ${py - CURSOR_SIZE / 2}px)`
          cursorRef.current.style.background = value
          cursorRef.current.style.borderColor = contrastText(value)
        }
      }
      if (hueThumbRef.current) {
        const hueEl = hueThumbRef.current.parentElement
        if (hueEl) {
          const hueRect = hueEl.getBoundingClientRect()
          const hy = (hsl.h / 360) * hueRect.height
          hueThumbRef.current.style.transform = `translate(-50%, ${hy - THUMB_HEIGHT / 2}px)`
        }
      }
      if (previewRef.current) previewRef.current.style.background = value
      if (svBgRef.current) svBgRef.current.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsl.h}, 100%, 50%))`
    }
    setHex(value)
  }, [value])

  // Throttled onChange
  const scheduleOnChange = useCallback((next: string) => {
    pendingHexRef.current = next
    const now = Date.now()
    const elapsed = now - lastOnChangeRef.current
    if (elapsed >= THROTTLE_MS) {
      lastOnChangeRef.current = now
      onChangeRef.current(next)
      pendingHexRef.current = null
    } else {
      if (throttleRef.current !== null) return
      throttleRef.current = window.setTimeout(() => {
        throttleRef.current = null
        if (pendingHexRef.current !== null) {
          lastOnChangeRef.current = Date.now()
          onChangeRef.current(pendingHexRef.current)
          pendingHexRef.current = null
        }
      }, THROTTLE_MS - elapsed)
    }
  }, [])

  // ── Прямой DOM-мув через transform в ПИКСЕЛЯХ — GPU compositor, НЕТ layout ──
  const handleSVPointer = useCallback((e: PointerEvent | React.PointerEvent) => {
    const rect = svRectCache.current
    if (!rect) return
    const x = Math.max(0, Math.min(rect.width, (e as PointerEvent).clientX - rect.left))
    const y = Math.max(0, Math.min(rect.height, (e as PointerEvent).clientY - rect.top))
    const newSV = { s: (x / rect.width) * 100, v: 100 - (y / rect.height) * 100 }
    svRefState.current = newSV
    const next = svToHex(hRef.current, newSV.s, newSV.v)
    // transform в пикселях — GPU, ноль layout
    if (cursorRef.current) {
      cursorRef.current.style.transform = `translate(${x - CURSOR_SIZE / 2}px, ${y - CURSOR_SIZE / 2}px)`
      cursorRef.current.style.background = next
      cursorRef.current.style.borderColor = contrastText(next)
    }
    if (previewRef.current) previewRef.current.style.background = next
    scheduleOnChange(next)
  }, [scheduleOnChange])

  const handleHuePointer = useCallback((e: PointerEvent | React.PointerEvent) => {
    const rect = hueRectCache.current
    if (!rect) return
    const y = Math.max(0, Math.min(rect.height, (e as PointerEvent).clientY - rect.top))
    const newH = (y / rect.height) * 360
    hRef.current = newH
    const next = svToHex(newH, svRefState.current.s, svRefState.current.v)
    if (hueThumbRef.current) hueThumbRef.current.style.transform = `translate(-50%, ${y - THUMB_HEIGHT / 2}px)`
    if (svBgRef.current) svBgRef.current.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${newH}, 100%, 50%))`
    if (cursorRef.current) { cursorRef.current.style.background = next; cursorRef.current.style.borderColor = contrastText(next) }
    if (previewRef.current) previewRef.current.style.background = next
    scheduleOnChange(next)
  }, [scheduleOnChange])

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (draggingSV.current) handleSVPointer(e)
      else if (draggingHue.current) handleHuePointer(e)
    }
    const onUp = () => {
      if (draggingSV.current || draggingHue.current) {
        draggingSV.current = false
        draggingHue.current = false
        isDragging.current = false
        svRectCache.current = null
        hueRectCache.current = null
        if (throttleRef.current !== null) { clearTimeout(throttleRef.current); throttleRef.current = null }
        const finalH = hRef.current
        const finalSV = svRefState.current
        const finalHex = svToHex(finalH, finalSV.s, finalSV.v)
        setH(finalH); setSV({ ...finalSV }); setHex(finalHex)
        onChangeRef.current(finalHex)
        onCommitRef.current?.(finalHex)
        pendingHexRef.current = null
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (throttleRef.current !== null) clearTimeout(throttleRef.current)
    }
  }, [handleSVPointer, handleHuePointer])

  const onHexInput = (raw: string) => {
    setHex(raw)
    const norm = normalizeHex(raw)
    if (norm && isValidHex(raw)) {
      const hsl = hexToHsl(norm)
      if (hsl) { setH(hsl.h); hRef.current = hsl.h
        const newSV = hexToSV(norm); setSV(newSV); svRefState.current = newSV }
      onChange(norm)
    }
  }
  const onHexBlur = () => {
    const norm = normalizeHex(hex)
    if (norm) { onChange(norm); onCommit?.(norm) } else setHex(value)
  }

  const rgb = hexToRgb(hex) || { r: 255, g: 255, b: 255 }

  const pickEyeDropper = async () => {
    const EyeDropper = (window as any).EyeDropper
    if (!EyeDropper) return
    try {
      const res = await new EyeDropper().open()
      const c = res.sRGBHex as string
      setHex(c)
      const hsl = hexToHsl(c)
      if (hsl) { setH(hsl.h); hRef.current = hsl.h
        const newSV = hexToSV(c); setSV(newSV); svRefState.current = newSV }
      onChange(c); onCommit?.(c)
    } catch {}
  }

  return (
    <div className={`colorpicker ${className || ''}`}>
      <div className="colorpicker-sv-wrap">
        <div
          ref={svRef}
          className="colorpicker-sv"
          onPointerDown={(e) => {
            draggingSV.current = true; isDragging.current = true
            svRectCache.current = svRef.current!.getBoundingClientRect()
            ;(e.target as Element).setPointerCapture?.(e.pointerId)
            handleSVPointer(e)
          }}
        >
          <div ref={svBgRef} className="colorpicker-sv-bg" />
          <div ref={cursorRef} className="colorpicker-cursor" />
        </div>
      </div>

      <div className="colorpicker-controls">
        <div
          className="colorpicker-hue"
          onPointerDown={(e) => {
            draggingHue.current = true; isDragging.current = true
            hueRectCache.current = (e.currentTarget as HTMLElement).getBoundingClientRect()
            ;(e.target as Element).setPointerCapture?.(e.pointerId)
            handleHuePointer(e)
          }}
        >
          <div ref={hueThumbRef} className="colorpicker-hue-thumb" />
        </div>
        <div ref={previewRef} className="colorpicker-preview" />
      </div>

      <div className="colorpicker-inputs">
        <label className="colorpicker-field">
          <span>HEX</span>
          <input value={hex} onChange={(e) => onHexInput(e.target.value)} onBlur={onHexBlur} spellCheck={false} />
        </label>
        <label className="colorpicker-field">
          <span>R</span>
          <input type="number" min={0} max={255} value={Math.round(rgb.r)}
            onChange={(e) => {
              const v = Math.max(0, Math.min(255, Number(e.target.value) || 0))
              const next = `#${v.toString(16).padStart(2, '0')}${Math.round(rgb.g).toString(16).padStart(2, '0')}${Math.round(rgb.b).toString(16).padStart(2, '0')}`
              setHex(next)
              const hsl = hexToHsl(next)
              if (hsl) { setH(hsl.h); hRef.current = hsl.h; const ns = hexToSV(next); setSV(ns); svRefState.current = ns }
              onChange(next)
            }}
          />
        </label>
        <label className="colorpicker-field">
          <span>G</span>
          <input type="number" min={0} max={255} value={Math.round(rgb.g)}
            onChange={(e) => {
              const v = Math.max(0, Math.min(255, Number(e.target.value) || 0))
              const next = `#${Math.round(rgb.r).toString(16).padStart(2, '0')}${v.toString(16).padStart(2, '0')}${Math.round(rgb.b).toString(16).padStart(2, '0')}`
              setHex(next)
              const hsl = hexToHsl(next)
              if (hsl) { setH(hsl.h); hRef.current = hsl.h; const ns = hexToSV(next); setSV(ns); svRefState.current = ns }
              onChange(next)
            }}
          />
        </label>
        <label className="colorpicker-field">
          <span>B</span>
          <input type="number" min={0} max={255} value={Math.round(rgb.b)}
            onChange={(e) => {
              const v = Math.max(0, Math.min(255, Number(e.target.value) || 0))
              const next = `#${Math.round(rgb.r).toString(16).padStart(2, '0')}${Math.round(rgb.g).toString(16).padStart(2, '0')}${v.toString(16).padStart(2, '0')}`
              setHex(next)
              const hsl = hexToHsl(next)
              if (hsl) { setH(hsl.h); hRef.current = hsl.h; const ns = hexToSV(next); setSV(ns); svRefState.current = ns }
              onChange(next)
            }}
          />
        </label>
        {(window as any).EyeDropper && (
          <button type="button" className="colorpicker-eyedropper" onClick={pickEyeDropper} title="Пипетка">
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
              <motion.button key={i + c} className="colorpicker-recent-swatch" style={{ background: c }}
                onClick={() => {
                  setHex(c)
                  const hsl = hexToHsl(c)
                  if (hsl) { setH(hsl.h); hRef.current = hsl.h; const ns = hexToSV(c); setSV(ns); svRefState.current = ns }
                  onChange(c); onCommit?.(c)
                }}
                whileHover={{ scale: 1.15 }} whileTap={{ scale: 0.95 }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default memo(ColorPicker)
