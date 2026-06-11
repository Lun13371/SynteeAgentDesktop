import { useEffect, useRef } from 'react'
import { useUIStore } from '../../../store/ui.store'
import './AnimatedBackground.css'

export default function AnimatedBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { animatedBackground, theme } = useUIStore()

  useEffect(() => {
    if (!animatedBackground) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animId: number
    let w = canvas.width = canvas.offsetWidth
    let h = canvas.height = canvas.offsetHeight

    // Частицы
    const particles = Array.from({ length: 40 }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.5 + 0.5,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      alpha: Math.random() * 0.3 + 0.05,
    }))

    const getColor = () => {
      if (theme === 'midnight') return '77, 159, 255'
      if (theme === 'forest') return '76, 175, 96'
      if (theme === 'light') return '0, 0, 0'
      return '255, 255, 255'
    }

    const draw = () => {
      ctx.clearRect(0, 0, w, h)
      const color = getColor()

      for (const p of particles) {
        p.x += p.vx
        p.y += p.vy
        if (p.x < 0) p.x = w
        if (p.x > w) p.x = 0
        if (p.y < 0) p.y = h
        if (p.y > h) p.y = 0

        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${color}, ${p.alpha})`
        ctx.fill()
      }

      // Линии между близкими частицами
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x
          const dy = particles[i].y - particles[j].y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < 120) {
            ctx.beginPath()
            ctx.moveTo(particles[i].x, particles[i].y)
            ctx.lineTo(particles[j].x, particles[j].y)
            ctx.strokeStyle = `rgba(${color}, ${0.06 * (1 - dist / 120)})`
            ctx.lineWidth = 0.5
            ctx.stroke()
          }
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
  }, [animatedBackground, theme])

  if (!animatedBackground) return null

  return <canvas ref={canvasRef} className="animated-bg" />
}
