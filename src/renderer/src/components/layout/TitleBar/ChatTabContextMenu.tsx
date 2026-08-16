import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import type { Chat } from '../../../../../shared/types'
import AppIcon from '../../ui/AppIcon/AppIcon'
import { getContextMenuPosition, type MenuPos } from '../../../utils/contextMenuPosition'
import { useChatStore } from '../../../store/chat.store'
import { useNavStore } from '../../../store/nav.store'
import { openInSplit } from '../../../store/tabs.store'
import { springHover, whileHoverListItem, whileTapListItem } from '../../../utils/motionPresets'
// Классы chat-ctx-menu/ctx-item/ctx-divider — общие с сайдбар-меню.
import '../../ui/ChatContextMenu/ChatContextMenu.css'

export interface ChatTabContextMenuProps {
  chat: Chat | null
  pos: MenuPos | null
  onClose: () => void
  /** Функция выбора чата (ChatPage.selectChat через tabActions). */
  onSelectChat?: (id: string) => void
  /** Закрытие вкладки — через хендлер ChatTabs (переключение на соседнюю,
   *  если закрытая была активной). */
  onCloseTab: (id: string) => void
  /** Сколько всего вкладок открыто — последнюю закрыть нельзя. */
  tabsCount: number
}

// ── Контекстное меню вкладки чата в шапке (правый клик) ────────────────────
// Короткое меню: навигация/сплит/закрытие вкладки. Управление чатом
// (переименовать/закрепить/архив/удалить) — в контекстном меню сайдбара.
export default function ChatTabContextMenu({ chat, pos, onClose, onSelectChat, onCloseTab, tabsCount }: ChatTabContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const splitChatId = useChatStore(s => s.splitChatId)
  const currentChatId = useChatStore(s => s.currentChatId)
  const setSplitChat = useChatStore(s => s.setSplitChat)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  if (!chat || !pos) return null

  const { openUp, ...menuStyle } = getContextMenuPosition(pos)
  const isActive = chat.id === currentChatId
  const isSplit = chat.id === splitChatId

  return createPortal(
    <AnimatePresence>
      {chat && pos && (
        <motion.div
          ref={ref}
          className="chat-ctx-menu"
          style={{ position: 'fixed', ...menuStyle, zIndex: 9999 }}
          initial={{ opacity: 0, scale: 0.95, y: openUp ? 6 : -6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -4 }}
          transition={{ type: 'spring', stiffness: 500, damping: 32 }}
        >
          {!isActive && (
            <CtxItem icon="appWindow" label="Открыть" onClick={() => { onSelectChat?.(chat.id); onClose() }} />
          )}
          {isSplit ? (
            <CtxItem icon="columns" label="Закрыть сплит" onClick={() => { setSplitChat(null); onClose() }} />
          ) : !isActive && (
            // Меню доступно с любой страницы (шапка видна всегда) — после
            // открытия сплита возвращаемся на страницу чата, иначе сплит
            // открылся бы «невидимо» (ChatPage скрыт под настройками).
            <CtxItem icon="columns" label="Открыть в сплите" onClick={() => {
              if (openInSplit(chat)) useNavStore.getState().setMainPage('chat')
              onClose()
            }} />
          )}
          {tabsCount > 1 && (
            <>
              <div className="ctx-divider" />
              <CtxItem icon="x" label="Закрыть вкладку" onClick={() => { onCloseTab(chat.id); onClose() }} />
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}

function CtxItem({ icon, label, onClick }: { icon: 'appWindow' | 'columns' | 'x'; label: string; onClick: () => void }) {
  return (
    <motion.button
      className="ctx-item"
      onClick={onClick}
      whileHover={whileHoverListItem}
      whileTap={whileTapListItem}
      transition={springHover}
    >
      <AppIcon name={icon} size="sm" />
      <span>{label}</span>
    </motion.button>
  )
}
