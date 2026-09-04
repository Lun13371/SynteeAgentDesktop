/**
 * PluginsTab — вкладка «Плагины» в ExtensionsPopover.
 *
 * Список локальных плагинов (тулы + логика в utilityProcess):
 *   - карточка: имя, версия, статус (running/stopped/error), toggle
 *   - разворот: описание (markdown), права, тулы, журнал, Reload / Удалить
 *   - установка из папки (нативный диалог → копирование в plugins dir)
 *
 * Данные — из extensions.store (loadPlugins через IPC plugins:getAll),
 * push-события plugins:changed / plugins:logs обновляют список в реалтайме.
 */
import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import AppIcon from '../AppIcon/AppIcon'
import { useExtensionsStore } from '../../../store/extensions.store'
import { usePluginPanelStore } from '../../../store/pluginPanel.store'
import type { PluginRuntime, ExtensionScope } from '../../../../../shared/types'
import './PluginsTab.css'

/** Текстовая подпись области применения (локальная копия scopeLabel). */
function pluginScopeLabel(scope: ExtensionScope): string {
  if (scope.type === 'global') return 'глобально'
  const n = scope.projectIds?.length ?? 0
  if (n === 0) return 'нет проектов'
  if (n === 1) return '1 проект'
  return `${n} проекта`
}

const STATUS_META: Record<PluginRuntime['status'], { label: string; color: string }> = {
  running: { label: 'запущен', color: 'var(--success, #4ade80)' },
  stopped: { label: 'остановлен', color: 'var(--text-muted, #94a3b8)' },
  error: { label: 'ошибка', color: 'var(--danger, #f87171)' },
  starting: { label: 'запуск…', color: 'var(--warning, #f59e0b)' },
}

export default function PluginsTab({ projectId, projects }: { projectId?: string; projects: Array<{ id: string; name: string }> }) {
  const plugins = useExtensionsStore(s => s.plugins)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  /** Consent-диалог: плагин ждёт подтверждения прав перед включением. */
  const [pendingConsent, setPendingConsent] = useState<PluginRuntime | null>(null)
  const openPanel = usePluginPanelStore(s => s.openPanel)

  const toggleEnabled = async (p: PluginRuntime) => {
    // Первое включение плагина с правами → consent-диалог.
    if (!p.state.enabled && !p.state.consented && (p.manifest.permissions?.length ?? 0) > 0) {
      setPendingConsent(p)
      return
    }
    setBusy(p.id)
    try {
      await window.syntee.plugins.setState({ pluginId: p.id, enabled: !p.state.enabled })
      await useExtensionsStore.getState().loadPlugins(projectId)
    } catch (e) {
      window.alert(`Не удалось ${p.state.enabled ? 'выключить' : 'включить'} плагин: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  /** Consent подтверждён → включаем плагин. */
  const confirmConsent = async () => {
    const p = pendingConsent
    setPendingConsent(null)
    if (!p) return
    setBusy(p.id)
    try {
      await window.syntee.plugins.setState({ pluginId: p.id, consented: true })
      await window.syntee.plugins.setState({ pluginId: p.id, enabled: true })
      await useExtensionsStore.getState().loadPlugins(projectId)
    } catch (e) {
      window.alert(`Не удалось включить плагин: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const setScope = async (p: PluginRuntime, scope: ExtensionScope) => {
    await window.syntee.plugins.setState({ pluginId: p.id, scope })
    await useExtensionsStore.getState().loadPlugins(projectId)
  }

  const reload = async (p: PluginRuntime) => {
    setBusy(p.id)
    try {
      await window.syntee.plugins.reload(p.id)
      await useExtensionsStore.getState().loadPlugins(projectId)
    } finally {
      setBusy(null)
    }
  }

  const uninstall = async (p: PluginRuntime) => {
    if (!window.confirm(`Удалить плагин «${p.manifest.name}»? Папка плагина будет удалена с диска.`)) return
    setBusy(p.id)
    try {
      await window.syntee.plugins.uninstall({ pluginId: p.id, source: p.source, dir: p.dir })
      await useExtensionsStore.getState().loadPlugins(projectId)
    } finally {
      setBusy(null)
    }
  }

  const installFromFolder = async () => {
    setBusy('__install')
    try {
      const res = await window.syntee.plugins.installFromFolder() as { ok: boolean; canceled?: boolean; error?: string }
      if (!res.ok && !res.canceled && res.error) {
        window.alert(res.error)
      }
      await useExtensionsStore.getState().loadPlugins(projectId)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="ext-catalog-cta">
        <div className="ext-catalog-cta-actions">
          <button
            className="ext-action-btn"
            onClick={async () => {
              const paths = await window.syntee.plugins.getPaths() as { globalPluginsDir: string }
              window.syntee.shell.openPath(paths.globalPluginsDir)
            }}
            title="Открыть папку плагинов"
          >
            <AppIcon name="folder" size="xs" />
            Папка плагинов
          </button>
        </div>
        <button
          className="ext-action-btn ext-action-btn--primary"
          onClick={installFromFolder}
          disabled={busy === '__install'}
        >
          <AppIcon name="download" size="xs" />
          Установить из папки…
        </button>
      </div>

      {plugins.length === 0 && (
        <div className="ext-empty">
          <div className="ext-empty-icon"><AppIcon name="puzzle" size="xl" tone="muted" /></div>
          <div>
            Плагины не найдены.<br />
            Плагин — папка с <code>plugin.json</code> + JS-кодом:<br />
            тулы для AI, логика, хранилище. Установите из папки<br />
            или создайте в <code>userData/plugins/</code>.
          </div>
        </div>
      )}

      {plugins.map(p => {
        const isOpen = expanded === p.id
        const enabled = p.state.enabled
        const status = STATUS_META[p.status]
        return (
          <div key={p.id} className={`ext-card${enabled ? ' ext-card--enabled' : ''}`}>
            <div className="ext-card-head">
              <span className="ext-card-icon">
                <AppIcon name="puzzle" size="sm" tone={enabled ? 'accent' : 'muted'} />
              </span>
              <div className="ext-card-main">
                <div className="ext-card-name">
                  {p.manifest.name}
                  <span className="ext-card-version">v{p.manifest.version}</span>
                  <span
                    className="plugin-status-badge"
                    style={{ color: status.color }}
                    title={p.error || status.label}
                  >
                    ● {status.label}
                  </span>
                  <span className={`ext-card-source ext-card-source--${p.source === 'global' ? 'user' : 'project'}`}>
                    {p.source === 'global' ? 'глобальный' : 'проект'}
                  </span>
                  {p.state.scope.type === 'projects' && (
                    <span className="ext-card-source ext-card-source--project" title="Область применения">
                      {pluginScopeLabel(p.state.scope)}
                    </span>
                  )}
                </div>
                {p.manifest.description && <div className="ext-card-desc">{p.manifest.description}</div>}
                {p.error && <div className="plugin-error-line">{p.error}</div>}
              </div>
              <button
                className={`ext-toggle${enabled ? ' ext-toggle--on' : ''}`}
                onClick={() => toggleEnabled(p)}
                disabled={busy === p.id}
                title={enabled ? 'Выключить' : 'Включить'}
                aria-label={enabled ? 'Выключить' : 'Включить'}
              />
            </div>

            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  className="ext-card-details"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                  style={{ overflow: 'hidden' }}
                >
                  {/* Область применения */}
                  <div className="ext-card-row ext-card-row--start">
                    <span className="ext-card-row-label">Область</span>
                    <div className="plugin-scope-controls">
                      <button
                        className={`ext-installed-filter${p.state.scope.type === 'global' ? ' ext-installed-filter--active' : ''}`}
                        onClick={() => setScope(p, { type: 'global' })}
                      >Все чаты</button>
                      {projects.map(pr => {
                        const active = p.state.scope.type === 'projects' && p.state.scope.projectIds?.includes(pr.id)
                        return (
                          <button
                            key={pr.id}
                            className={`ext-installed-filter${active ? ' ext-installed-filter--active' : ''}`}
                            onClick={() => {
                              const cur = p.state.scope.type === 'projects' ? (p.state.scope.projectIds ?? []) : []
                              const next = active ? cur.filter(id => id !== pr.id) : [...cur, pr.id]
                              setScope(p, next.length > 0 ? { type: 'projects', projectIds: next } : { type: 'global' })
                            }}
                          >{pr.name}</button>
                        )
                      })}
                    </div>
                  </div>

                  {/* Права */}
                  {p.manifest.permissions && p.manifest.permissions.length > 0 && (
                    <div className="ext-card-row ext-card-row--start">
                      <span className="ext-card-row-label">Права</span>
                      <div className="plugin-perms">
                        {p.manifest.permissions.map(perm => (
                          <span key={perm} className="plugin-perm-badge">{perm}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Тулы */}
                  <div className="ext-card-row ext-card-row--start">
                    <span className="ext-card-row-label">Тулы</span>
                    {p.tools.length > 0 ? (
                      <div className="plugin-tools">
                        {p.tools.map(t => (
                          <span key={t.name} className="plugin-tool-badge" title={t.description}>{t.shortName}</span>
                        ))}
                      </div>
                    ) : (
                      <span className="ext-card-row-value">нет (плагин не зарегистрировал тулы)</span>
                    )}
                  </div>

                  {/* Команды */}
                  {p.commands.length > 0 && (
                    <div className="ext-card-row ext-card-row--start">
                      <span className="ext-card-row-label">Команды</span>
                      <div className="plugin-tools">
                        {p.commands.map(c => (
                          <span key={c.name} className="plugin-cmd-badge" title={c.description}>/{c.name}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* UI-вклады */}
                  {p.ui.length > 0 && (
                    <div className="ext-card-row ext-card-row--start">
                      <span className="ext-card-row-label">UI</span>
                      <div className="plugin-tools">
                        {p.ui.map((u, i) => (
                          <button
                            key={i}
                            className="plugin-ui-badge"
                            title={u.type === 'panel' ? 'Открыть панель' : `Выполнить /${u.command}`}
                            onClick={() => {
                              if (u.type === 'panel') {
                                openPanel(p.id, `${u.label} · ${p.manifest.name}`)
                              }
                            }}
                          >
                            {u.label} · {u.type === 'panel' ? 'панель' : 'кнопка'}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Настройки (config из манифеста) */}
                  {p.manifest.config && p.manifest.config.length > 0 && (
                    <PluginConfigForm plugin={p} onSaved={() => useExtensionsStore.getState().loadPlugins(projectId)} />
                  )}

                  {/* Полное описание */}
                  {p.readmeContent && (
                    <>
                      <div className="ext-card-row ext-card-row--start">
                        <span className="ext-card-row-label">Описание</span>
                      </div>
                      <div className="plugin-readme">
                        <ReactMarkdown>{p.readmeContent}</ReactMarkdown>
                      </div>
                    </>
                  )}

                  {/* Журнал */}
                  {p.logs.length > 0 && (
                    <div className="ext-logs-box">
                      <div className="ext-logs-box-header">
                        <span className="ext-logs-box-title">
                          <AppIcon name="terminal" size="xs" />
                          Журнал
                          <span className="ext-logs-box-title-count">{p.logs.length}</span>
                        </span>
                      </div>
                      <div className="ext-logs-box-list">
                        {p.logs.slice(-50).map((entry, i) => (
                          <div key={i} className="ext-log-entry">
                            <span className="ext-log-entry-time">
                              {new Date(entry.ts).toLocaleTimeString('ru')}
                            </span>
                            <span
                              className="ext-log-entry-msg"
                              style={{ color: entry.level === 'error' ? 'var(--danger, #f87171)' : entry.level === 'warn' ? 'var(--warning, #f59e0b)' : undefined }}
                            >
                              {entry.message}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            <div className="ext-actions">
              <button className="ext-action-btn" onClick={() => setExpanded(isOpen ? null : p.id)}>
                <AppIcon name={isOpen ? 'chevronUp' : 'chevronDown'} size="xs" />
                {isOpen ? 'Свернуть' : 'Подробнее'}
              </button>
              <button className="ext-action-btn" onClick={() => reload(p)} disabled={busy === p.id}>
                <AppIcon name="refreshCw" size="xs" />
                Перезагрузить
              </button>
              <button
                className="ext-action-btn ext-action-btn--danger"
                onClick={() => uninstall(p)}
                disabled={busy === p.id}
              >
                <AppIcon name="trash" size="xs" />
                Удалить
              </button>
            </div>
          </div>
        )
      })}

      {/* Consent-диалог: подтверждение прав при первом включении. */}
      <AnimatePresence>
        {pendingConsent && (
          <motion.div
            className="ext-modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onMouseDown={e => { if (e.target === e.currentTarget) setPendingConsent(null) }}
          >
            <motion.div
              className="plugin-consent"
              initial={{ opacity: 0, y: 16, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            >
              <div className="plugin-consent-title">
                <AppIcon name="shieldAlert" size="md" tone="accent" />
                Подтверждение прав плагина
              </div>
              <div className="plugin-consent-text">
                Плагин <b>{pendingConsent.manifest.name}</b> (v{pendingConsent.manifest.version})
                {pendingConsent.manifest.author ? <> от {pendingConsent.manifest.author}</> : null} запрашивает доступ:
              </div>
              <div className="plugin-perms">
                {pendingConsent.manifest.permissions?.map(perm => (
                  <span key={perm} className="plugin-perm-badge">{PERMISSION_LABELS[perm] ?? perm}</span>
                ))}
              </div>
              <div className="plugin-consent-note">
                Отключить плагин можно в любой момент тумблером. Права гейтят доступ к API хоста
                (сеть, буфер обмена, уведомления, файлы).
              </div>
              <div className="plugin-consent-actions">
                <button className="ext-action-btn" onClick={() => setPendingConsent(null)}>Отмена</button>
                <button className="ext-action-btn ext-action-btn--primary" onClick={confirmConsent}>
                  <AppIcon name="check" size="xs" />
                  Разрешить и включить
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

/** Человекочитаемые названия прав. */
const PERMISSION_LABELS: Record<string, string> = {
  'net': 'сеть (HTTP-запросы)',
  'fs:read': 'чтение файлов',
  'fs:write': 'запись файлов (в папке плагина)',
  'clipboard': 'буфер обмена',
  'notifications': 'уведомления',
  'ui': 'элементы интерфейса',
}

/** Форма настроек плагина (манифест config → поля, значения → pluginsConfig). */
function PluginConfigForm({ plugin, onSaved }: { plugin: PluginRuntime; onSaved: () => void }) {
  const fields = plugin.manifest.config ?? []
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...plugin.configValues }))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await window.syntee.plugins.setConfig({ pluginId: plugin.id, values })
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="ext-card-row ext-card-row--start">
        <span className="ext-card-row-label">Настройки</span>
      </div>
      <div className="plugin-config-form">
        {fields.map(f => (
          <div key={f.key} className="plugin-config-field">
            <label className="plugin-config-label" title={f.description}>{f.label}</label>
            {f.type === 'boolean' ? (
              <button
                className={`ext-toggle${values[f.key] ? ' ext-toggle--on' : ''}`}
                onClick={() => setValues(v => ({ ...v, [f.key]: !v[f.key] }))}
                aria-label={f.label}
              />
            ) : (
              <input
                className="plugin-config-input"
                type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
                value={String(values[f.key] ?? '')}
                placeholder={f.placeholder}
                onChange={e => setValues(v => ({
                  ...v,
                  [f.key]: f.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value,
                }))}
              />
            )}
            {f.description && <div className="plugin-config-hint">{f.description}</div>}
          </div>
        ))}
        <button className="ext-action-btn ext-action-btn--primary" onClick={save} disabled={saving}>
          <AppIcon name={saved ? 'check' : 'save'} size="xs" />
          {saved ? 'Сохранено' : saving ? 'Сохранение…' : 'Сохранить'}
        </button>
      </div>
    </>
  )
}
