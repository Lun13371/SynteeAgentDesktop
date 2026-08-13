import { useState, useEffect, useCallback } from 'react'
import RightPanel from '../RightPanel/RightPanel'
import { useUIStore } from '../../../store/ui.store'
import { useChatStore } from '../../../store/chat.store'

/**
 * Изолирует состояние правой панели (agentPanelOpen, focusAgentId) от App.
 * Без этого любое изменение agentPanelOpen вызывало ре-рендер App →
 * ChatPage (виртуализация), AnimatedBackground (canvas), TitleBar.
 *
 * Keep-alive: RightPanel ВСЕГДА смонтирована. При закрытии панель
 * анимируется к width=0/opacity=0, но не размонтируется — всё
 * внутреннее состояние (табы, терминал, файлы, ввод) сохраняется.
 * pointer-events:none на скрытой панели предотвращает перехват кликов.
 */
export default function RightPanelHost() {
  const [focusAgentId, setFocusAgentId] = useState<string | null>(null)
  const agentPanelOpen = useUIStore(s => s.agentPanelOpen)
  const setAgentPanelOpen = useUIStore(s => s.setAgentPanelOpen)
  const currentChatId = useChatStore(s => s.currentChatId)

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

  return (
    <RightPanel
      open={agentPanelOpen}
      onClose={handleClose}
      focusAgentId={focusAgentId}
      currentChatId={currentChatId}
    />
  )
}