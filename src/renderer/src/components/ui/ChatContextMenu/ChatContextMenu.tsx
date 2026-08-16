import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import type { Chat } from '../../../../../shared/types'
import AppIcon from '../AppIcon/AppIcon'
import { getContextMenuPosition } from '../../../utils/contextMenuPosition'
import { useChatStore } from '../../../store/chat.store'
import { openInSplit } from '../../../store/tabs.store'
import { whileHoverTiny, whileTapTiny, whileHoverListItem, whileTapListItem, springHover } from '../../../utils/motionPresets'
import './ChatContextMenu.css'

export interface ContextMenuPos { x: number; y: number }

interface Props {
  chat: Chat | null
  pos: ContextMenuPos | null
  onClose: () => void
  /** Открыть чат вкладкой в шапке в фоне (не переключаясь на него). */
  onOpenInTab?: (chat: Chat) => void
  onRename: (chat: Chat) => void
  onPin: (chat: Chat) => void
  onArchive: (chat: Chat) => void
  onDuplicate: (chat: Chat) => void
  onShare?: (chat: Chat) => void
  onExport: (chat: Chat, fmt: 'txt' | 'md') => void
  onDelete: (chat: Chat) => void
  onColor: (chat: Chat, color: string | null) => void
}

const COLORS = [
  { value: '#f87171', label: 'Красный' },
  { value: '#fb923c', label: 'Оранжевый' },
  { value: '#facc15', label: 'Жёлтый' },
  { value: '#4ade80', label: 'Зелёный' },
  { value: '#60a5fa', label: 'Синий' },
  { value: '#a78bfa', label: 'Фиолетовый' },
]

export default function ChatContextMenu({ chat, pos, onClose, onOpenInTab, onRename, onPin, onArchive, onDuplicate, onShare, onExport, onDelete, onColor }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  // Для пунктов сплита: активный чат нельзя открыть в сплите (он и так на
  // экране), текущий сплит-чат предлагаем закрыть.
  const currentChatId = useChatStore(s => s.currentChatId)
  const splitChatId = useChatStore(s => s.splitChatId)
  const setSplitChat = useChatStore(s => s.setSplitChat)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  if (!chat || !pos) return null

  // Реальная высота меню не измеряется: в нижней половине окна меню
  // открывается ВВЕРХ от клика — низ не уйдёт за окно независимо от высоты.
  // (Хардкод menuH = 320 занижал высоту с опциональными пунктами → обрезка.)
  const { openUp, ...menuStyle } = getContextMenuPosition(pos)

  // Divider после блока «открыть во вкладке/в сплите» — если виден хотя бы
  // один из этих пунктов (для активного не-сплит чата скрыты оба).
  const hasOpenBlock = !!onOpenInTab || chat.id === splitChatId || chat.id !== currentChatId

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
          {/* Цветные метки */}
          <div className="ctx-colors">
            <motion.button className={`ctx-color-dot ctx-color-dot--none ${!chat.color ? 'active' : ''}`}
              onClick={() => { onColor(chat, null); onClose() }} title="Без цвета" whileHover={whileHoverTiny} whileTap={whileTapTiny} transition={springHover}>×</motion.button>
            {COLORS.map(c => (
              <motion.button key={c.value} className={`ctx-color-dot ${chat.color === c.value ? 'active' : ''}`}
                style={{ background: c.value }}
                onClick={() => { onColor(chat, c.value); onClose() }}
                title={c.label}
                whileHover={whileHoverTiny}
                whileTap={whileTapTiny}
                transition={springHover}
              />
            ))}
          </div>
          <div className="ctx-divider" />

          {/* Открыть вкладкой в шапке — в фоне, без переключения (как «Открыть
              в новой вкладке» в браузере). Клик по чату и так открывает вкладку
              с переключением, поэтому пункт только про фоновое открытие. */}
          {onOpenInTab && (
            <CtxItem icon="appWindow" label="Открыть во вкладке" onClick={() => { onOpenInTab(chat); onClose() }} />
          )}

          {/* Сплит: чат во второй половине экрана. Активный чат открыть нельзя
              (он и так на экране), для текущего сплит-чата — пункт закрытия. */}
          {chat.id === splitChatId ? (
            <CtxItem icon="columns" label="Закрыть сплит" onClick={() => { setSplitChat(null); onClose() }} />
          ) : chat.id !== currentChatId && (
            <CtxItem icon="columns" label="Открыть в сплите" onClick={() => { openInSplit(chat); onClose() }} />
          )}
          {hasOpenBlock && <div className="ctx-divider" />}

          <CtxItem icon="edit" label="Переименовать" onClick={() => { onRename(chat); onClose() }} />
          <CtxItem icon="pin" label={chat.isPinned ? 'Открепить' : 'Закрепить'} onClick={() => { onPin(chat); onClose() }} />
          <CtxItem icon="archive" label={chat.isArchived ? 'Разархивировать' : 'Архивировать'} onClick={() => { onArchive(chat); onClose() }} />
          <CtxItem icon="copy" label="Дублировать" onClick={() => { onDuplicate(chat); onClose() }} />
          {onShare && (
            <CtxItem icon="messageSquare" label="Поделиться с другом" onClick={() => { onShare(chat); onClose() }} />
          )}
          {/* Открыть рабочую директорию в системном проводнике — только для
              чатов с привязанной папкой (новые Code-чаты после фичи workdir). */}
          {chat.workdir && (
            <CtxItem
              icon="folder"
              label="Открыть папку в проводнике"
              onClick={() => { window.syntee.shell.openPath(chat.workdir!); onClose() }}
            />
          )}

          <div className="ctx-divider" />
          <div className="ctx-submenu-label">Экспорт</div>
          <CtxItem icon="fileText" label="Markdown (.md)" onClick={() => { onExport(chat, 'md'); onClose() }} indent />
          <CtxItem icon="fileText" label="Текст (.txt)" onClick={() => { onExport(chat, 'txt'); onClose() }} indent />

          <div className="ctx-divider" />
          <CtxItem icon="trash" label="Удалить" danger onClick={() => { onDelete(chat); onClose() }} />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}

function CtxItem({ icon, label, onClick, danger, indent }: { icon: string; label: string; onClick: () => void; danger?: boolean; indent?: boolean }) {
  return (
    <motion.button className={`ctx-item ${danger ? 'ctx-item--danger' : ''} ${indent ? 'ctx-item--indent' : ''}`} onClick={onClick} whileHover={whileHoverListItem} whileTap={whileTapListItem} transition={springHover}>
      <AppIcon name={icon as 'edit'} size="sm" />
      <span>{label}</span>
    </motion.button>
  )
}
