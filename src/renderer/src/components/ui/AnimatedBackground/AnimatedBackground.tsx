import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from '../../../store/ui.store'
import './AnimatedBackground.css'

export type BgStyle = 'particles' | 'matrix' | 'waves' | 'aurora' | 'fireflies' | 'starfield' | 'nebula' | 'topographic' | 'geometric' | 'none'

const FALLBACK_RGB = '255, 255, 255'

function getAccentRgb(): string {
  if (typeof window === 'undefined') return FALLBACK_RGB
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim()
  if (raw) return raw
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  if (accent && accent.startsWith('#') && accent.length >= 7) {
    const r = parseInt(accent.slice(1, 3), 16)
    const g = parseInt(accent.slice(3, 5), 16)
    const b = parseInt(accent.slice(5, 7), 16)
    if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return `${r}, ${g}, ${b}`
  }
  return FALLBACK_RGB
}

const CELL = 120
const CONN_DIST_SQ = CELL * CELL
const FRAME_MS = 1000 / 30

export default function AnimatedBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { animatedBackground, bgStyle, theme, accentColor } = useUIStore(useShallow(s => ({
    animatedBackground: s.animatedBackground,
    bgStyle: s.bgStyle,
    theme: s.theme,
    accentColor: s.accentColor,
  })))
  const style: BgStyle = (bgStyle as BgStyle) || 'particles'

  useEffect(() => {
    if (!animatedBackground || style === 'none') return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animId: number | null = null
    let running = false
    let w = canvas.width = canvas.offsetWidth
    let h = canvas.height = canvas.offsetHeight
    const color = getAccentRgb()
    let t = 0
    let lastTime = 0

    // --- PARTICLES ---
    const particles = Array.from({ length: 45 }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      r: Math.random() * 1.5 + 0.5,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      alpha: Math.random() * 0.3 + 0.05,
    }))

    // --- MATRIX ---
    const cols = Math.floor(w / 16)
    const drops = Array.from({ length: cols }, () => Math.random() * -50)
    const matrixChars = 'アイウエオカキクケコサシスセソタチツテトナニヌネノ01'

    // --- AURORA ---
    const auroraLayers = [
      { amp: 0.06, freq: 0.8, phase: 0, speed: 0.003, y: 0.35, col: `rgba(${color}, 0.07)` },
      { amp: 0.05, freq: 1.1, phase: 1.5, speed: 0.004, y: 0.45, col: `rgba(${color}, 0.05)` },
      { amp: 0.07, freq: 0.6, phase: 3.0, speed: 0.002, y: 0.55, col: `rgba(${color}, 0.06)` },
    ]

    // --- FIREFLIES ---
    const flies = Array.from({ length: 30 }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.4,
      vy: (Math.random() - 0.5) * 0.4,
      r: Math.random() * 2.5 + 1,
      phase: Math.random() * Math.PI * 2,
      speed: Math.random() * 0.02 + 0.01,
    }))

    // --- STARFIELD ---
    const stars = Array.from({ length: 140 }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      r: Math.random() * 1.2 + 0.3,
      twinkle: Math.random() * Math.PI * 2,
      speed: Math.random() * 0.04 + 0.01,
      depth: Math.random() * 0.6 + 0.2,
    }))

    // --- NEBULA ---
    const nebulaBlobs = Array.from({ length: 5 }, (_, i) => ({
      x: Math.random() * w, y: Math.random() * h,
      r: Math.max(120, Math.min(w, h) * (0.25 + i * 0.05)),
      vx: (Math.random() - 0.5) * 0.15,
      vy: (Math.random() - 0.5) * 0.15,
      phase: Math.random() * Math.PI * 2,
      hueShift: (i / 5) * 60 - 30,
    }))

    // --- TOPOGRAPHIC ---
    let topoSeed = Math.random() * 1000

    // --- GEOMETRIC ---
    const geoShapes = Array.from({ length: 8 }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      r: Math.random() * 40 + 20,
      sides: 3 + Math.floor(Math.random() * 4),
      rot: Math.random() * Math.PI * 2,
      vRot: (Math.random() - 0.5) * 0.008,
      vx: (Math.random() - 0.5) * 0.25,
      vy: (Math.random() - 0.5) * 0.25,
    }))

    const draw = (now: number) => {
      if (!running) return
      const dt = now - lastTime
      if (dt < FRAME_MS) {
        animId = requestAnimationFrame(draw)
        return
      }
      const scale = Math.min(dt / 16.667, 3)
      lastTime = now
      t += scale

      if (style === 'particles') {
        ctx.clearRect(0, 0, w, h)
        for (const p of particles) {
          p.x += p.vx * scale; p.y += p.vy * scale
          if (p.x < 0) p.x = w; if (p.x > w) p.x = 0
          if (p.y < 0) p.y = h; if (p.y > h) p.y = 0
        }
        for (const p of particles) {
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(${color}, ${p.alpha})`
          ctx.fill()
        }
        // Spatial grid for O(n) neighbor lookup instead of O(n²)
        const grid = new Map<string, number[]>()
        for (let i = 0; i < particles.length; i++) {
          const cx = Math.floor(particles[i].x / CELL)
          const cy = Math.floor(particles[i].y / CELL)
          const key = cx + ',' + cy
          let arr = grid.get(key)
          if (!arr) { arr = []; grid.set(key, arr) }
          arr.push(i)
        }
        ctx.lineWidth = 0.5
        for (let i = 0; i < particles.length; i++) {
          const cx = Math.floor(particles[i].x / CELL)
          const cy = Math.floor(particles[i].y / CELL)
          for (let dxc = -1; dxc <= 1; dxc++) {
            for (let dyc = -1; dyc <= 1; dyc++) {
              const neighbors = grid.get((cx + dxc) + ',' + (cy + dyc))
              if (!neighbors) continue
              for (const j of neighbors) {
                if (j <= i) continue
                const ddx = particles[i].x - particles[j].x
                const ddy = particles[i].y - particles[j].y
                const distSq = ddx * ddx + ddy * ddy
                if (distSq < CONN_DIST_SQ) {
                  const dist = Math.sqrt(distSq)
                  ctx.beginPath()
                  ctx.moveTo(particles[i].x, particles[i].y)
                  ctx.lineTo(particles[j].x, particles[j].y)
                  ctx.strokeStyle = `rgba(${color}, ${0.07 * (1 - dist / 120)})`
                  ctx.stroke()
                }
              }
            }
          }
        }

      } else if (style === 'matrix') {
        ctx.fillStyle = `rgba(0,0,0,${Math.min(0.04 * scale, 1)})`
        ctx.fillRect(0, 0, w, h)
        ctx.fillStyle = `rgba(${color}, 0.55)`
        ctx.font = '14px monospace'
        for (let i = 0; i < drops.length; i++) {
          const ch = matrixChars[Math.floor(Math.random() * matrixChars.length)]
          ctx.fillText(ch, i * 16, drops[i] * 16)
          if (drops[i] * 16 > h && Math.random() > 0.975) drops[i] = 0
          drops[i] += 0.35 * scale
        }

      } else if (style === 'waves') {
        ctx.clearRect(0, 0, w, h)
        for (let wave = 0; wave < 3; wave++) {
          const offset = wave * (Math.PI * 2 / 3)
          const amp = h * (0.04 + wave * 0.015)
          const freq = 0.004 + wave * 0.001
          const speed = t * (0.008 + wave * 0.003)
          const yBase = h * (0.3 + wave * 0.2)
          ctx.beginPath()
          ctx.moveTo(0, yBase)
          for (let x = 0; x <= w; x += 4) {
            const y = yBase + Math.sin(x * freq + speed + offset) * amp
            ctx.lineTo(x, y)
          }
          ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath()
          ctx.fillStyle = `rgba(${color}, ${0.05 - wave * 0.01})`
          ctx.fill()
        }

      } else if (style === 'aurora') {
        ctx.clearRect(0, 0, w, h)
        for (const layer of auroraLayers) {
          layer.phase += layer.speed * scale
          const yBase = h * layer.y
          const gradient = ctx.createLinearGradient(0, yBase - h * layer.amp * 2, 0, yBase + h * layer.amp * 2)
          gradient.addColorStop(0, 'transparent')
          gradient.addColorStop(0.5, layer.col)
          gradient.addColorStop(1, 'transparent')
          ctx.beginPath()
          ctx.moveTo(0, yBase)
          for (let x = 0; x <= w; x += 6) {
            const y = yBase + Math.sin(x * layer.freq * 0.004 + layer.phase) * h * layer.amp
            ctx.lineTo(x, y)
          }
          ctx.lineTo(w, h * 1.5); ctx.lineTo(0, h * 1.5); ctx.closePath()
          ctx.fillStyle = gradient
          ctx.fill()
        }

      } else if (style === 'fireflies') {
        ctx.clearRect(0, 0, w, h)
        for (const f of flies) {
          f.x += f.vx * scale; f.y += f.vy * scale
          if (f.x < 0) f.x = w; if (f.x > w) f.x = 0
          if (f.y < 0) f.y = h; if (f.y > h) f.y = 0
          f.phase += f.speed * scale
          const pulse = (Math.sin(f.phase) + 1) / 2
          const alpha = pulse * 0.5 + 0.05
          const radius = f.r * (0.7 + pulse * 0.6)
          const grad = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, radius * 4)
          grad.addColorStop(0, `rgba(${color}, ${alpha})`)
          grad.addColorStop(1, 'transparent')
          ctx.beginPath()
          ctx.arc(f.x, f.y, radius * 4, 0, Math.PI * 2)
          ctx.fillStyle = grad
          ctx.fill()
          ctx.beginPath()
          ctx.arc(f.x, f.y, radius, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(${color}, ${alpha * 1.5})`
          ctx.fill()
        }

      } else if (style === 'starfield') {
        ctx.fillStyle = `rgba(0, 0, 0, ${Math.min(0.18 * scale, 1)})`
        ctx.fillRect(0, 0, w, h)
        const mx = (Math.sin(t * 0.002) * 0.5) * 30
        const my = (Math.cos(t * 0.0015) * 0.5) * 20
        for (const s of stars) {
          s.twinkle += s.speed * scale
          const tw = (Math.sin(s.twinkle) + 1) / 2
          const alpha = tw * 0.7 + 0.15
          const px = s.x + mx * s.depth
          const py = s.y + my * s.depth
          ctx.beginPath()
          ctx.arc(px, py, s.r * (0.8 + tw * 0.5), 0, Math.PI * 2)
          ctx.fillStyle = `rgba(${color}, ${alpha})`
          ctx.fill()
          if (tw > 0.85 && s.r > 0.9) {
            ctx.strokeStyle = `rgba(${color}, ${alpha * 0.4})`
            ctx.lineWidth = 0.5
            ctx.beginPath()
            ctx.moveTo(px - s.r * 3, py); ctx.lineTo(px + s.r * 3, py)
            ctx.moveTo(px, py - s.r * 3); ctx.lineTo(px, py + s.r * 3)
            ctx.stroke()
          }
        }

      } else if (style === 'nebula') {
        ctx.fillStyle = `rgba(0, 0, 0, ${Math.min(0.12 * scale, 1)})`
        ctx.fillRect(0, 0, w, h)
        ctx.globalCompositeOperation = 'lighter'
        for (const b of nebulaBlobs) {
          b.x += b.vx * scale; b.y += b.vy * scale
          b.phase += 0.005 * scale
          if (b.x < -b.r) b.x = w + b.r; if (b.x > w + b.r) b.x = -b.r
          if (b.y < -b.r) b.y = h + b.r; if (b.y > h + b.r) b.y = -b.r
          const pulse = (Math.sin(b.phase) + 1) / 2
          const r = Math.max(20, b.r * (0.85 + pulse * 0.25))
          const grad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r)
          const hslHue = (parseInt(color.split(',')[0]) + b.hueShift) % 360
          grad.addColorStop(0, `hsla(${hslHue}, 70%, 60%, 0.10)`)
          grad.addColorStop(0.5, `rgba(${color}, 0.04)`)
          grad.addColorStop(1, 'transparent')
          ctx.beginPath()
          ctx.arc(b.x, b.y, r, 0, Math.PI * 2)
          ctx.fillStyle = grad
          ctx.fill()
        }
        ctx.globalCompositeOperation = 'source-over'

      } else if (style === 'topographic') {
        ctx.clearRect(0, 0, w, h)
        topoSeed += 0.003 * scale
        ctx.lineWidth = 0.7
        const step = 28
        for (let level = 0; level < 16; level++) {
          const levelOffset = level * step
          ctx.beginPath()
          let first = true
          for (let x = 0; x <= w; x += 8) {
            const n = Math.sin(x * 0.008 + topoSeed + level * 0.5) *
                      Math.cos(x * 0.013 + topoSeed * 1.3 + level * 0.3) *
                      (40 + level * 3)
            const y = h * 0.5 + n + levelOffset - 16 * step / 2
            if (first) { ctx.moveTo(x, y); first = false }
            else ctx.lineTo(x, y)
          }
          const alpha = 0.05 + (level / 16) * 0.06
          ctx.strokeStyle = `rgba(${color}, ${alpha})`
          ctx.stroke()
        }

      } else if (style === 'geometric') {
        ctx.clearRect(0, 0, w, h)
        for (const g of geoShapes) {
          g.x += g.vx * scale; g.y += g.vy * scale; g.rot += g.vRot * scale
          if (g.x < -g.r) g.x = w + g.r; if (g.x > w + g.r) g.x = -g.r
          if (g.y < -g.r) g.y = h + g.r; if (g.y > h + g.r) g.y = -g.r
          ctx.beginPath()
          for (let i = 0; i <= g.sides; i++) {
            const a = g.rot + (i / g.sides) * Math.PI * 2
            const px = g.x + Math.cos(a) * g.r
            const py = g.y + Math.sin(a) * g.r
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
          }
          ctx.closePath()
          ctx.strokeStyle = `rgba(${color}, 0.10)`
          ctx.lineWidth = 1
          ctx.stroke()
          ctx.fillStyle = `rgba(${color}, 0.025)`
          ctx.fill()
        }
      }

      if (running) animId = requestAnimationFrame(draw)
    }

    const start = () => {
      if (running) return
      running = true
      lastTime = 0
      animId = requestAnimationFrame(draw)
    }
    const stop = () => {
      running = false
      if (animId !== null) { cancelAnimationFrame(animId); animId = null }
    }

    const onVisibility = () => { if (document.hidden) stop(); else start() }
    const onBlur = () => stop()
    const onFocus = () => start()

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)

    start()

    const onResize = () => {
      w = canvas.width = canvas.offsetWidth
      h = canvas.height = canvas.offsetHeight
    }
    window.addEventListener('resize', onResize)

    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('resize', onResize)
    }
  }, [animatedBackground, bgStyle, theme, accentColor, style])

  if (!animatedBackground || style === 'none') return null
  return <canvas ref={canvasRef} className="animated-bg" />
}
