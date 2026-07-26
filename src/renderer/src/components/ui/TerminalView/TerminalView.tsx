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
import { useTerminalStore } from '../../../store/terminal.store'
import AppIcon from '../AppIcon/AppIcon'
import './TerminalView.css'

interface TerminalViewProps {
  sessionId: string
  /** Автофокус при mount. */
  autoFocus?: boolean
  className?: string
}

export default function TerminalView({ sessionId, autoFocus, className }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const aiBusy = useTerminalStore(s => s.aiBusySessionIds.has(sessionId))

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

    // ResizeObserver: при изменении размеров контейнера — fit + сообщаем PTY.
    // Debounce 100мс — во время анимации панели (framer-motion, ~60fps) RO
    // стреляет каждый кадр, вызывая синхронный fit() + IPC на каждый кадр.
    // При 5+ сессиях в BottomDock это создавало флуд IPC + блокировку main.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const doFit = () => {
      const dims = fitTerminal(sessionId)
      if (dims) window.syntee.pty.resize(sessionId, dims.cols, dims.rows)
    }
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(doFit, 100)
    })
    ro.observe(container)

    // Начальный fit после того как контейнер получил размеры
    requestAnimationFrame(() => {
      doFit()
      if (autoFocus) focusTerminal(sessionId)
    })

    return () => {
      ro.disconnect()
      if (resizeTimer) clearTimeout(resizeTimer)
      // НЕ диспозим Terminal — он переживает unmount (reparenting).
      // Dispose только при закрытии сессии (через store.closeSession → disposeTerminal).
    }
  }, [sessionId, autoFocus])

  return (
    <div ref={containerRef} className={`terminal-view ${aiBusy ? 'terminal-view--ai-busy' : ''} ${className ?? ''}`}>
      {aiBusy && (
        <div className="terminal-view__ai-badge">
          <AppIcon name="bot" size="xs" tone="accent" />
          <span>AI выполняет команду…</span>
        </div>
      )}
    </div>
  )
}
