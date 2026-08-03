import { useState } from 'react'
import { Reorder } from 'framer-motion'
import AppIcon from '../../ui/AppIcon/AppIcon'
import ChatTabContextMenu from './ChatTabContextMenu'
import { useChatStore } from '../../../store/chat.store'
import { useNavStore } from '../../../store/nav.store'
import { useTabsStore, tabActions } from '../../../store/tabs.store'
import type { MenuPos } from '../../../utils/contextMenuPosition'
import type { Chat } from '../../../../../shared/types'

// Вкладки открытых чатов в шапке — как в браузере: переключение по клику,
// drag&drop для перестановки (Reorder из framer-motion, прецедент —
// QueuePanel), закрытие крестиком или средней кнопкой мыши, контекстное
// меню по правому клику (открыть/сплит/закрыть вкладку).
// Данные чатов — из chat.store, порядок вкладок — из tabs.store, действия
// (select/create) — через tabActions (мост в ChatPage, который keep-alive).
// no-drag на вкладках и «+»: шапка — drag-region окна, без no-drag клики
// не дошли бы до renderer. Пустое место полосы остаётся drag-зоной.
// В конце полосы — чип открытого сплит-чата (второй чат 50/50): индикатор
// + крестик закрытия сплита.
export default function ChatTabs() {
  const openTabIds = useTabsStore(s => s.openTabIds)
  const reorderTabs = useTabsStore(s => s.reorderTabs)
  const closeTab = useTabsStore(s => s.closeTab)
  const chats = useChatStore(s => s.chats)
  const currentChatId = useChatStore(s => s.currentChatId)
  const runStatusByChat = useChatStore(s => s.runStatusByChat)
  const splitChatId = useChatStore(s => s.splitChatId)
  const setSplitChat = useChatStore(s => s.setSplitChat)
  const [ctxMenu, setCtxMenu] = useState<{ chat: Chat; pos: MenuPos } | null>(null)

  // Значения Reorder.Group должны 1:1 соответствовать Reorder.Item —
  // фильтруем вкладки без живого чата (гонка удаления/переименования).
  const chatById = new Map(chats.map(c => [c.id, c]))
  const tabIds = openTabIds.filter(id => chatById.has(id))

  const handleClose = (id: string) => {
    const neighbor = closeTab(id)
    // Закрыли активную — переключаемся на соседнюю (правая, иначе левая).
    if (id === currentChatId && neighbor) {
      useNavStore.getState().setMainPage('chat')
      tabActions.selectChat?.(neighbor)
    }
  }

  // Клик по вкладке / «+» из любой страницы (настройки, мессенджер) —
  // возвращаем на страницу чата, иначе переключение было бы не видно.
  const handleSelect = (id: string) => {
    if (id === currentChatId) return
    useNavStore.getState().setMainPage('chat')
    tabActions.selectChat?.(id)
  }

  // «+» — новый чат в контексте текущего (чат проекта → чат в том же проекте).
  const handleCreate = () => {
    useNavStore.getState().setMainPage('chat')
    tabActions.createInContext?.()
  }

  // Правый клик по вкладке — контекстное меню (открыть/сплит/закрыть).
  const handleCtx = (e: React.MouseEvent, chat: Chat) => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ chat, pos: { x: e.clientX, y: e.clientY } })
  }

  // Чип сплит-чата в конце полосы — показывает что открыто 2 чата.
  const splitChat = splitChatId ? chatById.get(splitChatId) : undefined

  return (
    <div className="titlebar-tabs">
      <Reorder.Group
        as="div"
        axis="x"
        values={tabIds}
        onReorder={reorderTabs}
        className="titlebar-tabs-list"
      >
        {tabIds.map(id => {
          const chat = chatById.get(id)!
          const status = runStatusByChat[id]?.status
          const running = status === 'running' || status === 'queued'
          const active = id === currentChatId
          return (
            <Reorder.Item
              as="div"
              key={id}
              value={id}
              className={`titlebar-tab no-drag ${active ? 'titlebar-tab--active' : ''}`}
              onClick={() => handleSelect(id)}
              onContextMenu={e => handleCtx(e, chat)}
              onAuxClick={(e: React.MouseEvent) => {
                // Средняя кнопка — закрытие, как в браузере.
                // preventDefault — не дать Chromium включить auto-scroll.
                e.preventDefault()
                if (e.button === 1 && tabIds.length > 1) handleClose(id)
              }}
              title={chat.title}
              transition={{ type: 'spring', stiffness: 500, damping: 35 }}
            >
              {running ? (
                <span className="titlebar-tab-spinner" title={status === 'queued' ? 'В очереди' : 'Работает'} />
              ) : (
                chat.color && <span className="titlebar-tab-color" style={{ background: chat.color }} />
              )}
              <span className="titlebar-tab-title">{chat.title}</span>
              {/* Последнюю вкладку закрыть нельзя — всегда есть хотя бы одна. */}
              {tabIds.length > 1 && (
                <button
                  className="titlebar-tab-close"
                  onPointerDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); handleClose(id) }}
                  title="Закрыть вкладку"
                >
                  <AppIcon name="x" size="xs" />
                </button>
              )}
            </Reorder.Item>
          )
        })}
      </Reorder.Group>
      <button
        type="button"
        className="titlebar-tab-add no-drag"
        onClick={handleCreate}
        title="Новый чат"
      >
        <AppIcon name="plus" size="sm" />
      </button>

      {/* Чип сплит-чата: виден пока открыта вторая половина экрана.
          Крестик закрывает сплит (вкладка чата остаётся). */}
      {splitChat && (() => {
        const splitStatus = runStatusByChat[splitChat.id]?.status
        const splitRunning = splitStatus === 'running' || splitStatus === 'queued'
        return (
        <div className="titlebar-split-chip no-drag" title={`Сплит: ${splitChat.title}`}>
          <AppIcon name="columns" size="xs" tone="accent" />
          {splitRunning ? (
            <span className="titlebar-tab-spinner" title={splitStatus === 'queued' ? 'В очереди' : 'Работает'} />
          ) : (
            splitChat.color && <span className="titlebar-tab-color" style={{ background: splitChat.color }} />
          )}
          <span className="titlebar-split-chip-title">{splitChat.title}</span>
          <button
            className="titlebar-tab-close titlebar-split-chip-close"
            onClick={() => setSplitChat(null)}
            title="Закрыть сплит"
          >
            <AppIcon name="x" size="xs" />
          </button>
        </div>
        )
      })()}

      <ChatTabContextMenu
        chat={ctxMenu?.chat ?? null}
        pos={ctxMenu?.pos ?? null}
        onClose={() => setCtxMenu(null)}
        onSelectChat={handleSelect}
        onCloseTab={handleClose}
        tabsCount={tabIds.length}
      />
    </div>
  )
}
