/**
 * PluginSidebarSlots — декларативные UI-вклады плагинов в слот 'sidebar'
 * (низ сайдбара, над кнопкой «Расширения»).
 *
 * type='button' → выполняет команду плагина (registerCommand) — результат
 *                показывается тостом (короткий) или открывает панель.
 * type='panel'  → открывает iframe-панель кастомного UI плагина.
 *
 * Данные — extensions.store.plugins (ui-вклады приходят из запущенных
 * плагинов). Клик по кнопке типа 'button' выполняет команду и показывает
 * результат тостом.
 */
import './PluginSidebarSlots.css'
import { motion } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import { useExtensionsStore } from '../../../store/extensions.store'
import { usePluginPanelStore } from '../../../store/pluginPanel.store'
import { useToast } from '../Toast/Toast'

export default function PluginSidebarSlots(): JSX.Element | null {
  const plugins = useExtensionsStore(s => s.plugins)
  const openPanel = usePluginPanelStore(s => s.openPanel)
  const openPluginTab = usePluginPanelStore(s => s.openPluginTab)
  const toast = useToast(s => s.add)

  // Собираем UI-вклады из запущенных включённых плагинов. В одном ряду
  // показываем sidebar-, right- и modal-кнопки; различие только в обработчике:
  //   right + panel → таб правой панели (openPluginTab)
  //   modal/sidebar + panel → модальная панель (openPanel)
  //   button → выполнить команду плагина
  const contributions = plugins
    .filter(p => p.state.enabled && p.status === 'running')
    .flatMap(p => p.ui.map(u => ({ ...u, pluginName: p.manifest.name })))

  if (contributions.length === 0) return null

  const handleClick = async (c: (typeof contributions)[number]) => {
    if (c.type === 'panel') {
      if (c.slot === 'right' && c.panelId) {
        openPluginTab(c.pluginId, c.panelId, c.label)
      } else {
        openPanel(c.pluginId, `${c.label} · ${c.pluginName}`)
      }
      return
    }
    // button → выполняем команду плагина, результат — тостом
    // (короткий показ целиком, длинный обрезаем).
    try {
      const res = await window.syntee.plugins.executeCommand({
        chatId: '',
        pluginId: c.pluginId,
        name: c.command ?? '',
        args: '',
        text: `/${c.command ?? ''}`,
      }) as { ok: boolean; output?: string; error?: string }
      const text = res.ok
        ? (res.output || 'Готово')
        : `Ошибка: ${res.error ?? 'неизвестно'}`
      toast(text.slice(0, 300), res.ok ? 'success' : 'error')
    } catch (e) {
      toast(`Ошибка: ${(e as Error).message}`, 'error')
    }
  }

  return (
    <div className="plugin-slots">
      {contributions.map((c, i) => (
        <motion.button
          key={`${c.pluginId}-${c.label}-${i}`}
          type="button"
          className="plugin-slot-btn"
          title={`${c.label} · ${c.pluginName}`}
          onClick={() => handleClick(c)}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.96 }}
        >
          <AppIcon name={c.icon || 'puzzle'} size="xs" />
          <span className="plugin-slot-btn-label">{c.label}</span>
        </motion.button>
      ))}
    </div>
  )
}
