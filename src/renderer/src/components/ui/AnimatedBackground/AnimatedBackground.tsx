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

// Мягкие стили (медленное движение, soft glow) — рендерим на 20fps вместо
// 30. Для пульсирующих glow/aurora/waves/topographic разница 20 vs 30 fps
// визуально неразличима (движение ~0.003 рад/кадр), но CPU/GPU работа
// меньше на 33%. Резкие стили (particles/matrix/starfield/geometric)
// оставляем на 30fps — там движение заметнее.
const SOFT_STYLES = new Set(['aurora', 'fireflies', 'nebula', 'waves', 'topographic'])
const SOFT_FRAME_MS = 1000 / 20
const SHARP_FRAME_MS = 1000 / 30

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
    const FRAME_MS = SOFT_STYLES.has(style) ? SOFT_FRAME_MS : SHARP_FRAME_MS

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
    // Кэшируем градиенты — их координаты и color stops не меняются между
    // кадрами (yBase = h * layer.y — константа). Раньше createLinearGradient
    // звался 3× на кадр → GC-давление. Теперь один раз.
    const auroraGradients = auroraLayers.map(layer => {
      const yBase = h * layer.y
      const g = ctx.createLinearGradient(0, yBase - h * layer.amp * 2, 0, yBase + h * layer.amp * 2)
      g.addColorStop(0, 'transparent')
      g.addColorStop(0.5, layer.col)
      g.addColorStop(1, 'transparent')
      return g
    })

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

    // ── Sprite caching для fireflies/nebula ──────────────────────────────
    // Раньше каждый кадр звал createRadialGradient (30×/5× за кадр) →
    // GC-давление + растеризация. Теперь pre-renderим спрайт один раз и
    // рисуем через drawImage (GPU, без аллокаций). Визуально идентично:
    // тот же radial gradient, та же alpha-композиция.
    const SPRITE_SIZE = 128
    function makeRadialSprite(stops: Array<[number, string]>): HTMLCanvasElement {
      const c = document.createElement('canvas')
      c.width = c.height = SPRITE_SIZE
      const cx = c.getContext('2d')!
      const half = SPRITE_SIZE / 2
      const g = cx.createRadialGradient(half, half, 0, half, half, half)
      for (const [off, col] of stops) g.addColorStop(off, col)
      cx.fillStyle = g
      cx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE)
      return c
    }
    const fireflyGlow = style === 'fireflies'
      ? makeRadialSprite([[0, `rgba(${color}, 1)`], [1, 'transparent']])
      : null
    const nebulaSprites: HTMLCanvasElement[] | null = style === 'nebula'
      ? nebulaBlobs.map(b => {
          const hslHue = (parseInt(color.split(',')[0]) + b.hueShift) % 360
          return makeRadialSprite([
            [0, `hsla(${hslHue}, 70%, 60%, 0.10)`],
            [0.5, `rgba(${color}, 0.04)`],
            [1, 'transparent'],
          ])
        })
      : null

    // Переиспользуем Map для spatial grid particles вместо new Map() каждый
    // кадр — снижает GC-давление (45 элементов × ~10 ячеек × 30fps = много
    // аллокаций). Clear+reuse массивов из пула.
    const gridCache = new Map<string, number[]>()
    const gridArrPool: number[][] = []
    let gridArrIdx = 0

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
        // Reuse Map + arrays from pool to avoid per-frame allocations.
        gridCache.clear()
        gridArrIdx = 0
        for (let i = 0; i < particles.length; i++) {
          const cx = Math.floor(particles[i].x / CELL)
          const cy = Math.floor(particles[i].y / CELL)
          const key = cx + ',' + cy
          let arr = gridCache.get(key)
          if (!arr) {
            arr = gridArrPool[gridArrIdx++] ?? (gridArrPool[gridArrIdx - 1] = [])
            arr.length = 0
            gridCache.set(key, arr)
          }
          arr.push(i)
        }
        ctx.lineWidth = 0.5
        for (let i = 0; i < particles.length; i++) {
          const cx = Math.floor(particles[i].x / CELL)
          const cy = Math.floor(particles[i].y / CELL)
          for (let dxc = -1; dxc <= 1; dxc++) {
            for (let dyc = -1; dyc <= 1; dyc++) {
              const neighbors = gridCache.get((cx + dxc) + ',' + (cy + dyc))
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
        for (let li = 0; li < auroraLayers.length; li++) {
          const layer = auroraLayers[li]
          layer.phase += layer.speed * scale
          const yBase = h * layer.y
          ctx.beginPath()
          ctx.moveTo(0, yBase)
          for (let x = 0; x <= w; x += 6) {
            const y = yBase + Math.sin(x * layer.freq * 0.004 + layer.phase) * h * layer.amp
            ctx.lineTo(x, y)
          }
          ctx.lineTo(w, h * 1.5); ctx.lineTo(0, h * 1.5); ctx.closePath()
          ctx.fillStyle = auroraGradients[li]
          ctx.fill()
        }

      } else if (style === 'fireflies') {
        ctx.clearRect(0, 0, w, h)
        const glow = fireflyGlow!
        for (const f of flies) {
          f.x += f.vx * scale; f.y += f.vy * scale
          if (f.x < 0) f.x = w; if (f.x > w) f.x = 0
          if (f.y < 0) f.y = h; if (f.y > h) f.y = 0
          f.phase += f.speed * scale
          const pulse = (Math.sin(f.phase) + 1) / 2
          const alpha = pulse * 0.5 + 0.05
          const radius = f.r * (0.7 + pulse * 0.6)
          // Glow через спрайт (вместо createRadialGradient каждый кадр).
          const glowD = radius * 8
          ctx.globalAlpha = alpha
          ctx.drawImage(glow, f.x - glowD / 2, f.y - glowD / 2, glowD, glowD)
          ctx.globalAlpha = 1
          // Ядро — дешёвый solid fill.
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
        const sprites = nebulaSprites!
        for (let bi = 0; bi < nebulaBlobs.length; bi++) {
          const b = nebulaBlobs[bi]
          b.x += b.vx * scale; b.y += b.vy * scale
          b.phase += 0.005 * scale
          if (b.x < -b.r) b.x = w + b.r; if (b.x > w + b.r) b.x = -b.r
          if (b.y < -b.r) b.y = h + b.r; if (b.y > h + b.r) b.y = -b.r
          const pulse = (Math.sin(b.phase) + 1) / 2
          const r = Math.max(20, b.r * (0.85 + pulse * 0.25))
          // Спрайт вместо createRadialGradient (3-stop gradient baked).
          const d = r * 2
          ctx.drawImage(sprites[bi], b.x - r, b.y - r, d, d)
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
