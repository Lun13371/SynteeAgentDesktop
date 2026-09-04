/**
 * pluginPanel store — состояние iframe-панелей плагинов.
 *
 * Две модели:
 *  - modal: одна открытая модальная панель (PluginPanel), legacy v1;
 *  - right-табы: полноценные табы правой панели (plugin:{pluginId}:{panelId})
 *    с бейджами — открываются/закрываются из push-событий main
 *    (plugins:panel-action), сайдбар-кнопок и меню правой панели.
 */
import { create } from 'zustand'
import { useRightPanelTabsStore } from './rightPanelTabs.store'
import { useUIStore, buildPluginTabId } from './ui.store'
import { useFileTabsStore } from './fileTabs.store'

interface PluginPanelStore {
  /** Открытая modal-панель: pluginId + заголовок (legacy registerUi type='panel'). */
  open: { pluginId: string; title: string } | null
  /** Бейджи табов правой панели: ключ — полный id таба plugin:{pluginId}:{panelId}. */
  badges: Record<string, number | null>
  openPanel: (pluginId: string, title: string) => void
  closePanel: () => void
  setBadge: (tabId: string, badge: number | null) => void
  openPluginTab: (pluginId: string, panelId: string, _title?: string) => void
  closePluginTab: (pluginId: string, panelId: string) => void
}

export const usePluginPanelStore = create<PluginPanelStore>((set) => ({
  open: null,
  badges: {},
  openPanel: (pluginId, title) => set({ open: { pluginId, title } }),
  closePanel: () => set({ open: null }),
  setBadge: (tabId, badge) => set(s => ({
    badges: badge == null
      ? (() => { const next = { ...s.badges }; delete next[tabId]; return next })()
      : { ...s.badges, [tabId]: badge },
  })),
  openPluginTab: (pluginId, panelId, _title) => {
    const tabId = buildPluginTabId(pluginId, panelId)
    useRightPanelTabsStore.getState().openPanel(tabId)
    useUIStore.getState().setAgentPanelTab(tabId)
    useUIStore.getState().setAgentPanelOpen(true)
    // Активный файловый таб перекрывает контент панелей — сбрасываем его.
    useFileTabsStore.getState().setActiveFileTab(null)
  },
  closePluginTab: (pluginId, panelId) => {
    const tabId = buildPluginTabId(pluginId, panelId)
    useRightPanelTabsStore.getState().closePanel(tabId)
    // Если закрыли активный таб — переключаемся на оставшийся (или sidechat).
    const ui = useUIStore.getState()
    if (ui.agentPanelTab === tabId) {
      const remaining = useRightPanelTabsStore.getState().openPanels
      if (remaining.length > 0) {
        ui.setAgentPanelTab(remaining[0])
      } else {
        useRightPanelTabsStore.getState().openPanel('sidechat')
        ui.setAgentPanelTab('sidechat')
      }
    }
  },
}))
