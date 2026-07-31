import { useState, useEffect, useCallback } from 'react'
import RightPanel from '../RightPanel/RightPanel'
import { useUIStore } from '../../../store/ui.store'
import { useChatStore } from '../../../store/chat.store'

/**
 * Изолирует состояние правой панели (agentPanelOpen, focusAgentId) от App.
 * Без этого любое изменение agentPanelOpen вызывало ре-рендер App →
 * ChatPage (виртуализация), AnimatedBackground (canvas), TitleBar.
 *
 * Стор падает в false мгновенно при закрытии (чтобы toggle в топ-баре
 * всегда читал актуальное состояние). Но панель удерживается смонтированной
 * через локальный флаг exiting, пока RightPanel проигрывает exit-анимацию
 * (widthMV→0). onExitComplete сбрасывает exiting → размаунт.
 *
 * exiting выставается синхронно в render (а не в useEffect), иначе
 * `return null` срабатывает раньше эффекта и панель размонтируется до анимации.
 */
export default function RightPanelHost() {
  const [focusAgentId, setFocusAgentId] = useState<string | null>(null)
  const agentPanelOpen = useUIStore(s => s.agentPanelOpen)
  const setAgentPanelOpen = useUIStore(s => s.setAgentPanelOpen)
  const currentChatId = useChatStore(s => s.currentChatId)

  const [exiting, setExiting] = useState(false)
  const [prevOpen, setPrevOpen] = useState(agentPanelOpen)

  // Синхронно в render (React перерендерит с новым state до коммита):
  // exiting=true при open→close (удерживаем панель для exit-анимации),
  // exiting=false при close→open (отмена exit при reopen).
  if (prevOpen !== agentPanelOpen) {
    setPrevOpen(agentPanelOpen)
    if (prevOpen && !agentPanelOpen) setExiting(true)
    else if (!prevOpen && agentPanelOpen) setExiting(false)
  }

  useEffect(() => {
    const handler = (e: Event) => {
      const agentId = (e as CustomEvent<{ agentId: string }>).detail?.agentId ?? null
      setFocusAgentId(agentId)
      setAgentPanelOpen(true)
      window.syntee.settings.set('agentPanelOpen', true)
    }
    window.addEventListener('open-agent-panel', handler)
    return () => window.removeEventListener('open-agent-panel', handler)
  }, [setAgentPanelOpen])

  const handleClose = useCallback(() => {
    setAgentPanelOpen(false)
    setFocusAgentId(null)
    window.syntee.settings.set('agentPanelOpen', false)
  }, [setAgentPanelOpen])

  const handleExitComplete = useCallback(() => setExiting(false), [])

  if (!agentPanelOpen && !exiting) return null

  return (
    <RightPanel
      open={agentPanelOpen}
      onClose={handleClose}
      onExitComplete={handleExitComplete}
      focusAgentId={focusAgentId}
      currentChatId={currentChatId}
    />
  )
}

