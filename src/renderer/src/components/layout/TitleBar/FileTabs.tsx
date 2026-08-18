import { useState } from 'react'
import { Reorder, motion } from 'framer-motion'
import AppIcon from '../../ui/AppIcon/AppIcon'
import FileTabContextMenu from './FileTabContextMenu'
import { useFileTabsStore } from '../../../store/fileTabs.store'
import { useNavStore } from '../../../store/nav.store'
import type { MenuPos } from '../../../utils/contextMenuPosition'
import { springHover, whileHoverTiny, whileTapTiny } from '../../../utils/motionPresets'
import './TitleBar.css'

// ── Вкладки открытых файлов в шапке (как в VSCode) ─────────────────────
// Второй ряд под ChatTabs. Показывается только когда есть открытые файлы.
// Drag&drop для перестановки, контекстное меню по правому клику,
// dirty indicator (точка) для несохранённых файлов, conflict indicator
// (жёлтый значок) для файлов изменённых внешне.

// Цветовая метка типа файла (как в FileExplorer)
const FILE_TYPE_COLORS: Record<string, string> = {
  ts: '#3178c6', tsx: '#3178c6',
  js: '#f7df1e', jsx: '#f7df1e', mjs: '#f7df1e',
  json: '#f0a000',
  css: '#264de4', scss: '#cc6699',
  html: '#e34c26',
  md: '#519aba',
  py: '#3572a5',
  go: '#00add8',
  rs: '#dea584',
  sh: '#89e051', bash: '#89e051',
  yml: '#cb171e', yaml: '#cb171e',
}

function getFileColor(name: string): string | undefined {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return FILE_TYPE_COLORS[ext]
}

export default function FileTabs() {
  const openFileTabs = useFileTabsStore(s => s.openFileTabs)
  const activeFileTabId = useFileTabsStore(s => s.activeFileTabId)
  const reorderFileTabs = useFileTabsStore(s => s.reorderFileTabs)
  const closeFileTab = useFileTabsStore(s => s.closeFileTab)
  const setActiveFileTab = useFileTabsStore(s => s.setActiveFileTab)
  const [ctxMenu, setCtxMenu] = useState<{ tabId: string; pos: MenuPos } | null>(null)

  // Не показываем полосу файлов если нет открытых табов
  if (openFileTabs.length === 0) return null

  const tabIds = openFileTabs.map(t => t.id)

  const handleClose = (id: string) => {
    closeFileTab(id)
  }

  const handleSelect = (id: string) => {
    if (id === activeFileTabId) return
    // Переходим на страницу чата (где живёт FileEditorPane)
    useNavStore.getState().setMainPage('chat')
    setActiveFileTab(id)
  }

  const handleCtx = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ tabId, pos: { x: e.clientX, y: e.clientY } })
  }

  return (
    <div className="titlebar-filetabs">
      <Reorder.Group
        as="div"
        axis="x"
        values={tabIds}
        onReorder={(newIds) => reorderFileTabs(newIds)}
        className="titlebar-filetabs-list"
      >
        {openFileTabs.map(tab => {
          const fileColor = getFileColor(tab.name)
          const active = tab.id === activeFileTabId
          return (
            <Reorder.Item
              as="div"
              key={tab.id}
              value={tab.id}
              className={`titlebar-filetab no-drag ${active ? 'titlebar-filetab--active' : ''}`}
              onClick={() => handleSelect(tab.id)}
              onContextMenu={e => handleCtx(e, tab.id)}
              onAuxClick={(e: React.MouseEvent) => {
                e.preventDefault()
                if (e.button === 1) handleClose(tab.id)
              }}
              title={tab.relPath}
              transition={{ type: 'spring', stiffness: 500, damping: 35 }}
            >
              {/* Цветовая метка типа файла */}
              <span
                className="titlebar-filetab__color"
                style={{ background: fileColor ?? 'var(--text-muted)' }}
              />
              <span className="titlebar-filetab__title">{tab.name}</span>
              {/* Dirty indicator — точка для несохранённых правок */}
              {tab.dirty && (
                <span className="titlebar-filetab__dirty" title="Несохранённые изменения" />
              )}
              {/* Conflict indicator — жёлтый значок */}
              {tab.conflict && !tab.dirty && (
                <span className="titlebar-filetab__conflict" title="Файл изменён внешне" />
              )}
              {/* Кнопка закрытия */}
              <motion.button
                className="titlebar-filetab__close"
                onPointerDown={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); handleClose(tab.id) }}
                title="Закрыть"
                whileHover={whileHoverTiny}
                whileTap={whileTapTiny}
                transition={springHover}
              >
                <AppIcon name="x" size="xs" />
              </motion.button>
            </Reorder.Item>
          )
        })}
      </Reorder.Group>

      <FileTabContextMenu
        tabId={ctxMenu?.tabId ?? null}
        pos={ctxMenu?.pos ?? null}
        onClose={() => setCtxMenu(null)}
        tabsCount={openFileTabs.length}
      />
    </div>
  )
}
