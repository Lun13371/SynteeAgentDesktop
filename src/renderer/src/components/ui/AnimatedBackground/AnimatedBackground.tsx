import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from '../../../store/ui.store'
import './AnimatedBackground.css'

export type BgStyle = 'particles' | 'matrix' | 'waves' | 'aurora' | 'fireflies' | 'none'

function getAccentRgb(theme: string): string {
  if (theme === 'midnight') return '77, 159, 255'
  if (theme === 'forest') return '76, 175, 96'
  if (theme === 'light') return '0, 0, 0'
  return '255, 255, 255'
}

function drawParticles(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  particles: Array<{ x: number; y: number; r: number; vx: number; vy: number; alpha: number }>,
  color: string
) {
  ctx.clearRect(0, 0, w, h)
  for (const p of particles) {
    p.x += p.vx; p.y += p.vy
    if (p.x < 0) p.x = w; if (p.x > w) p.x = 0
    if (p.y < 0) p.y = h; if (p.y > h) p.y = 0
    ctx.beginPath()
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${color}, ${p.alpha})`
    ctx.fill()
  }
  for (let i = 0; i < particles.length; i++) {
    for (let j = i + 1; j < particles.length; j++) {
      const dx = particles[i].x - particles[j].x
      const dy = particles[i].y - particles[j].y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < 120) {
        ctx.beginPath()
        ctx.moveTo(particles[i].x, particles[i].y)
        ctx.lineTo(particles[j].x, particles[j].y)
        ctx.strokeStyle = `rgba(${color}, ${0.07 * (1 - dist / 120)})`
        ctx.lineWidth = 0.5
        ctx.stroke()
      }
    }
  }
}

export default function AnimatedBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { animatedBackground, bgStyle, theme } = useUIStore(useShallow(s => ({
    animatedBackground: s.animatedBackground,
    bgStyle: s.bgStyle,
    theme: s.theme,
  })))
  const style: BgStyle = (bgStyle as BgStyle) || 'particles'

  useEffect(() => {
    if (!animatedBackground || style === 'none') return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animId: number
    let w = canvas.width = canvas.offsetWidth
    let h = canvas.height = canvas.offsetHeight
    const color = getAccentRgb(theme)
    let t = 0

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

    // --- WAVES ---
    // nothing extra needed

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

    const draw = () => {
      t += 1
      ctx.clearRect(0, 0, w, h)

      if (style === 'particles') {
        drawParticles(ctx, w, h, particles, color)

      } else if (style === 'matrix') {
        ctx.fillStyle = 'rgba(0,0,0,0.04)'
        ctx.fillRect(0, 0, w, h)
        ctx.fillStyle = `rgba(${color}, 0.55)`
        ctx.font = '14px monospace'
        for (let i = 0; i < drops.length; i++) {
          const ch = matrixChars[Math.floor(Math.random() * matrixChars.length)]
          ctx.fillText(ch, i * 16, drops[i] * 16)
          if (drops[i] * 16 > h && Math.random() > 0.975) drops[i] = 0
          drops[i] += 0.35
        }

      } else if (style === 'waves') {
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
        for (const layer of auroraLayers) {
          layer.phase += layer.speed
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
        for (const f of flies) {
          f.x += f.vx; f.y += f.vy
          if (f.x < 0) f.x = w; if (f.x > w) f.x = 0
          if (f.y < 0) f.y = h; if (f.y > h) f.y = 0
          f.phase += f.speed
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
      }

      animId = requestAnimationFrame(draw)
    }

    draw()

    const onResize = () => {
      w = canvas.width = canvas.offsetWidth
      h = canvas.height = canvas.offsetHeight
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(animId)
      window.removeEventListener('resize', onResize)
    }
  }, [animatedBackground, bgStyle, theme, style])

  if (!animatedBackground || style === 'none') return null
  return <canvas ref={canvasRef} className="animated-bg" />
}
