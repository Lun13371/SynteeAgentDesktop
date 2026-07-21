import { useEffect, useRef } from 'react'
import './ResizeHandle.css'

interface ResizeHandleProps {
  onResize: (newWidth: number) => void
  onResizeEnd?: () => void
  side: 'right'
}

export default function ResizeHandle({ onResize, onResizeEnd, side }: ResizeHandleProps) {
  const draggingRef = useRef(false)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!draggingRef.current) return
      e.preventDefault()
      const clientX = e.clientX
      if (frameRef.current !== null) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        if (side === 'right') {
          const newWidth = window.innerWidth - clientX
          onResize(newWidth)
        }
      })
    }
    const handleUp = () => {
      if (draggingRef.current) {
        draggingRef.current = false
        document.body.classList.remove('resize-handle-active')
        onResizeEnd?.()
      }
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [onResize, onResizeEnd, side])

  const handleDown = (e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    document.body.classList.add('resize-handle-active')
  }

  return <div className="resize-handle resize-handle--right" onMouseDown={handleDown} role="separator" aria-orientation="vertical" />
}
