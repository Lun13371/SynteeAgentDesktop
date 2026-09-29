import { useEffect, useRef } from 'react'
import { useSettingsStore } from '../../../store/settings.store'
import { useUIStore } from '../../../store/ui.store'
import { subscribeAudioVisualizer, type AudioFrame } from '../../../utils/systemAudioVisualizer'

function hexWithAlpha(color: string, alpha: number): string {
  const match = color.match(/^#([\da-f]{6})$/i)
  if (!match) return `rgba(77, 159, 255, ${alpha})`
  const value = Number.parseInt(match[1], 16)
  return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`
}

interface AudioVisualizerLayerProps {
  demo?: boolean
}

export function AudioVisualizerLayer({ demo = false }: AudioVisualizerLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const settingEnabled = useSettingsStore(s => !!s.settings.audioVisualizerEnabled)
  const enabled = demo || settingEnabled
  const preset = useSettingsStore(s => (s.settings.audioVisualizerPreset as string) || 'full')
  const colorMode = useSettingsStore(s => (s.settings.audioVisualizerColorMode as string) || 'accent')
  const customColor = useSettingsStore(s => (s.settings.audioVisualizerColor as string) || '#4d9fff')
  const intensity = useSettingsStore(s => (s.settings.audioVisualizerIntensity as number) ?? 55)
  const sensitivity = useSettingsStore(s => (s.settings.audioVisualizerSensitivity as number) ?? 100)
  const accent = useUIStore(s => s.accentColor)
  const gradient = useUIStore(s => s.accentGradient)
  const frameRef = useRef<AudioFrame | null>(null)

  useEffect(() => subscribeAudioVisualizer(frame => { frameRef.current = frame }, demo), [demo])

  useEffect(() => {
    const canvas = canvasRef.current
    const box = canvas?.parentElement
    const ctx = canvas?.getContext('2d')
    if (!canvas || !box || !ctx || !enabled) return
    let raf = 0
    let active = 0
    let startedAt = 0
    let hue = 0
    let width = 0
    let height = 0
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      width = rect.width
      height = rect.height
      const nextWidth = Math.round(width * dpr)
      const nextHeight = Math.round(height * dpr)
      if (canvas.width === nextWidth && canvas.height === nextHeight) return
      canvas.width = nextWidth
      canvas.height = nextHeight
      // CSS inset stretches the absolute canvas. Only the bitmap dimensions
      // are assigned here, otherwise ResizeObserver can enter a feedback loop.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(box)
    resize()

    const colorAt = (offset: number) => {
      if (colorMode === 'rainbow') return `hsl(${(hue + offset * 75) % 360} 90% 65%)`
      if (colorMode === 'gradient' && gradient.enabled) {
        const g = ctx.createLinearGradient(0, 0, width, height)
        g.addColorStop(0, accent)
        g.addColorStop(1, gradient.color2)
        return g
      }
      return colorMode === 'custom' ? customColor : accent
    }
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      const frame = frameRef.current
      const level = frame?.level ?? 0
      const gain = sensitivity / 100
      const target = level * gain > 0.018 ? Math.min(1, level * gain) : 0
      active += (target - active) * (target > active ? 0.24 : 0.055)
      hue = (hue + 0.14) % 360
      ctx.clearRect(0, 0, width, height)
      if (active < 0.01) { startedAt = 0; return }
      if (!startedAt) startedAt = now
      const fade = Math.min(1, (now - startedAt) / 450)
      const power = Math.min(1, active * fade * (intensity / 55))
      const inset = 1.5
      const radius = 16
      const perimeter = 2 * (width + height - 4 * radius) + 2 * Math.PI * radius
      const count = frame?.bands.length || 48
      const bandActive = preset === 'spectrum' || preset === 'full'
      const fluid = preset === 'fluid' || preset === 'full'
      const particles = preset === 'pulse' || preset === 'full'

      if (fluid) {
        const g = ctx.createRadialGradient(width / 2, height / 2, 3, width / 2, height / 2, Math.max(width, height) * 0.75)
        g.addColorStop(0, hexWithAlpha(accent, Math.min(0.18, power * 0.14)))
        g.addColorStop(1, hexWithAlpha(accent, 0))
        ctx.fillStyle = g
        ctx.fillRect(0, 0, width, height)
      }

      ctx.save()
      ctx.shadowBlur = 9 + power * 22
      ctx.shadowColor = colorAt(0) as string
      ctx.lineWidth = 1.5 + power * 2
      ctx.strokeStyle = colorAt(0) as string
      ctx.globalAlpha = Math.min(0.85, power * 1.25)
      ctx.beginPath()
      ctx.roundRect(inset, inset, width - inset * 2, height - inset * 2, radius)
      ctx.stroke()
      ctx.restore()

      if (bandActive && frame) {
        const step = perimeter / count
        ctx.save()
        ctx.lineCap = 'round'
        for (let i = 0; i < count; i++) {
          const amp = frame.bands[i] * gain
          if (amp < 0.05) continue
          const pos = i * step
          const p = pointOnRoundedRect(pos, width, height, radius, inset)
          ctx.beginPath()
          ctx.fillStyle = colorAt(i / count) as string
          ctx.globalAlpha = Math.min(0.95, amp * power * 2.3)
          ctx.shadowBlur = 4 + amp * 12
          ctx.shadowColor = colorAt(i / count) as string
          ctx.arc(p.x, p.y, 1 + amp * 2.5, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.restore()
      }
      if (particles && active > 0.34) {
        ctx.save()
        for (let i = 0; i < 7; i++) {
          const x = (Math.sin(now * 0.001 + i * 8.2) * 0.5 + 0.5) * width
          const y = (Math.cos(now * 0.0013 + i * 5.7) * 0.5 + 0.5) * height
          ctx.globalAlpha = Math.min(0.65, (active - 0.3) * 0.8)
          ctx.fillStyle = colorAt(i / 7) as string
          ctx.fillRect(x, y, 1.5, 1.5)
        }
        ctx.restore()
      }
    }
    const pointOnRoundedRect = (distance: number, w: number, h: number, r: number, pad: number) => {
      const x = pad, y = pad, rw = w - 2 * pad, rh = h - 2 * pad
      const straight = [rw - 2 * r, Math.PI * r / 2, rh - 2 * r, Math.PI * r / 2, rw - 2 * r, Math.PI * r / 2, rh - 2 * r, Math.PI * r / 2]
      let d = distance
      const segments: Array<[number, number, number, number]> = [
        [x + r, y, straight[0], 0], [x + rw - r, y + r, straight[1], -Math.PI / 2],
        [x + rw, y + r, straight[2], 0], [x + rw - r, y + rh - r, straight[3], 0],
        [x + rw - r, y + rh, straight[4], Math.PI / 2], [x + r, y + rh - r, straight[5], Math.PI / 2],
        [x, y + rh - r, straight[6], Math.PI], [x + r, y + r, straight[7], Math.PI],
      ]
      for (let i = 0; i < segments.length; i++) {
        const [cx, cy, length, angle] = segments[i]
        if (d <= length) {
          if (i % 2 === 0) {
            if (i === 0) return { x: cx + d, y: cy }
            if (i === 2) return { x: cx, y: cy + d }
            if (i === 4) return { x: cx - d, y: cy }
            return { x: cx, y: cy - d }
          }
          const a = angle + (d / length) * (Math.PI / 2)
          return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }
        }
        d -= length
      }
      return { x: x + r, y }
    }
    raf = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(raf); observer.disconnect() }
  }, [enabled, preset, colorMode, customColor, intensity, sensitivity, accent, gradient])

  if (!enabled) return null
  return <canvas ref={canvasRef} className="chat-input-audio-visualizer" aria-hidden="true" />
}
