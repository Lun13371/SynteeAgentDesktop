/**
 * Рендерит xterm-инстанс для sessionId. Использует terminalRegistry —
 * один Terminal на sessionId переживает unmount/mount (reparenting между
 * right-tab и bottom-dock) без потери буфера.
 *
 * Логика:
 * 1. getOrCreateTerminal(sessionId) — создаёт/переиспользует Terminal.
 * 2. attachToContainer(sessionId, div) — аттачит term.element в div.
 * 3. flushPreMount — пишет буфер вывода накопленный до первого mount.
 * 4. ResizeObserver → fit() + pty.resize(cols, rows).
 * 5. term.onData → pty.write (ввод юзера).
 */
import { useEffect, useRef } from 'react'
import { attachToContainer, flushPreMount, fitTerminal, focusTerminal, getOrCreateTerminal } from '../../../utils/terminalRegistry'
import './TerminalView.css'

interface TerminalViewProps {
  sessionId: string
  /** Автофокус при mount. */
  autoFocus?: boolean
  className?: string
}

export default function TerminalView({ sessionId, autoFocus, className }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Создаём/переиспользуем Terminal. onData → пишем в PTY.
    getOrCreateTerminal({
      sessionId,
      onData: (data) => { window.syntee.pty.write(sessionId, data) },
    })
    attachToContainer(sessionId, container)
    flushPreMount(sessionId)

    // ResizeObserver: при изменении размеров контейнера — fit + сообщаем PTY
    const ro = new ResizeObserver(() => {
      const dims = fitTerminal(sessionId)
      if (dims) window.syntee.pty.resize(sessionId, dims.cols, dims.rows)
    })
    ro.observe(container)

    // Начальный fit после того как контейнер получил размеры
    requestAnimationFrame(() => {
      const dims = fitTerminal(sessionId)
      if (dims) window.syntee.pty.resize(sessionId, dims.cols, dims.rows)
      if (autoFocus) focusTerminal(sessionId)
    })

    return () => {
      ro.disconnect()
      // НЕ диспозим Terminal — он переживает unmount (reparenting).
      // Dispose только при закрытии сессии (через store.closeSession → disposeTerminal).
    }
  }, [sessionId, autoFocus])

  return <div ref={containerRef} className={`terminal-view ${className ?? ''}`} />
}
