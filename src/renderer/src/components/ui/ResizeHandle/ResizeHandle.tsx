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

  // Callbacks в refs — useEffect не пересоздаётся при ре-рендере родителя.
  const onResizeRef = useRef(onResize)
  const onResizeEndRef = useRef(onResizeEnd)
  useEffect(() => {
    onResizeRef.current = onResize
    onResizeEndRef.current = onResizeEnd
  })

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
          onResizeRef.current(newWidth)
        }
      })
    }
    const handleUp = () => {
      if (draggingRef.current) {
        draggingRef.current = false
        document.body.classList.remove('resize-handle-active')
        onResizeEndRef.current?.()
      }
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [side])

  const handleDown = (e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    document.body.classList.add('resize-handle-active')
  }

  return <div className="resize-handle resize-handle--right" onMouseDown={handleDown} role="separator" aria-orientation="vertical" />
}
