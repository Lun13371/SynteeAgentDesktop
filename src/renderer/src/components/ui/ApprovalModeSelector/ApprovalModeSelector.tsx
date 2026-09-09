import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import type { ApprovalMode, AutoModeSettings, PermissionScope, ProjectPermissionOverride } from '../../../../../shared/types'
import { DEFAULT_AUTO_MODE_SETTINGS } from '../../../../../shared/types'
import AppIcon from '../AppIcon/AppIcon'
import Toggle from '../Toggle/Toggle'
import { chatColumnRight } from '../../../utils/popupAnchor'
import './ApprovalModeSelector.css'

const MODES: { value: ApprovalMode; label: string; icon: string; desc: string }[] = [
  { value: 'ask',  label: 'Спрашивать',    icon: 'alertCircle', desc: 'Подтверждать каждое действие' },
  { value: 'auto', label: 'Авто',          icon: 'zap',         desc: 'Авто для безопасных, спрашивать по настройкам защиты' },
  { value: 'full', label: 'Полный доступ', icon: 'shield',      desc: 'Выполнять всё без подтверждений' },
]

/** Гранулярные тогглы авто-режима (порядок = порядок в панели). */
const AUTO_TOGGLES: Array<{ key: keyof AutoModeSettings; label: string; desc: string }> = [
  { key: 'askOnDangerous',   label: 'Опасные',       desc: 'Удаление, реестр, force push' },
  { key: 'askOnWarn',        label: 'Потенциально опасные',   desc: 'chmod, eval' },
  { key: 'askGitPush',       label: 'Git push',               desc: 'push в удалённый репо' },
  { key: 'askNetwork',       label: 'Сеть',        desc: 'npm/pip install, curl, ssh' },
  { key: 'askOutsideWorkdir', label: 'Вне папки',     desc: 'Файлы и команды вне workdir' },
]

/** Оценочная высота дропдауна. */
const DROPDOWN_H = 170

const MODE_LABELS: Record<ApprovalMode, string> = {
  ask: 'Спрашивать',
  auto: 'Авто',
  full: 'Полный доступ',
}

interface ApprovalModeSelectorProps {
  /** Эффективный режим: проектный override ?? глобальный. */
  value: ApprovalMode
  /**
   * Выбор режима. scope='project' → писать в override проекта,
   * 'global' → в глобальные agentSettings. mode=null (только в project-scope,
   * из селекта «Как глобально») → сбросить проектный override режима.
   */
  onChange: (mode: ApprovalMode | null, scope: PermissionScope) => void
  compact?: boolean
  /** id проекта чата — открывает scope-переключатель «Только этот проект». */
  projectId?: string | null
  projectName?: string
  /** Глобальный режим (для пометки «проектный override активен»). */
  globalMode?: ApprovalMode
  /** Глобальные настройки авто-режима (agentPermissions.autoMode). */
  globalAuto?: Partial<AutoModeSettings>
  /** Проектный override разрешений (null = нет). */
  projectOverride?: ProjectPermissionOverride | null
  /** Изменение гранулярных настроек авто-режима в выбранном scope. */
  onAutoChange?: (patch: Partial<AutoModeSettings>, scope: PermissionScope) => void
}

export default function ApprovalModeSelector({
  value, onChange, compact,
  projectId, projectName,
  globalMode, globalAuto, projectOverride,
  onAutoChange,
}: ApprovalModeSelectorProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; openUp: boolean } | null>(null)
  const [scope, setScope] = useState<PermissionScope>('global')
  const [autoPanelOpen, setAutoPanelOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const current = MODES.find(m => m.value === value) || MODES[0]

  const hasProject = !!projectId
  const overrideActive = hasProject && !!projectOverride
    && (projectOverride.approvalMode !== undefined || !!projectOverride.auto)

  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom
    const openUp = spaceBelow < DROPDOWN_H + 12
    const dropW = 272
    const left = Math.max(8, Math.min(r.left, chatColumnRight(btnRef.current) - dropW))
    setPos({
      top: openUp ? r.top - 8 : r.bottom + 6,
      left,
      openUp,
    })
    setOpen(o => !o)
  }

  useEffect(() => {
    if (open) {
      setScope(overrideActive ? 'project' : 'global')
      setAutoPanelOpen(false)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const effAuto: AutoModeSettings = scope === 'project' && hasProject
    ? { ...DEFAULT_AUTO_MODE_SETTINGS, ...globalAuto, ...projectOverride?.auto }
    : { ...DEFAULT_AUTO_MODE_SETTINGS, ...globalAuto }

  const handleModeSelect = (mode: ApprovalMode) => {
    onChange(mode, scope)
    setOpen(false)
  }

  const handleAutoToggle = (key: keyof AutoModeSettings, v: boolean) => {
    onAutoChange?.({ [key]: v }, scope)
  }

  const projModeValue = projectOverride?.approvalMode ?? ''

  return (
    <div className={`approval-selector ${compact ? 'approval-selector--compact' : ''}`}>
      <motion.button
        ref={btnRef}
        className={`approval-btn approval-btn--${value}`}
        onClick={handleOpen}
        whileTap={{ scale: 0.95 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        title={current.desc}
      >
        <AppIcon name={current.icon as 'zap'} size="xs" />
        {!compact && <span className="approval-btn-label">{current.label}</span>}
        {overrideActive && <span className="approval-btn-project-dot" title="Для этого проекта заданы свои настройки" />}
        <AppIcon name={open ? 'chevronUp' : 'chevronDown'} size="xs" />
      </motion.button>

      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              className="approval-dropdown"
              style={{
                position: 'fixed',
                left: pos.left,
                ...(pos.openUp
                  ? { bottom: window.innerHeight - pos.top, top: 'auto' }
                  : { top: pos.top }),
                zIndex: 9999,
              }}
              initial={{ opacity: 0, y: pos.openUp ? 6 : -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: pos.openUp ? 6 : -6 }}
              transition={{ type: 'spring', stiffness: 420, damping: 30 }}
              onMouseDown={e => e.stopPropagation()}
            >
              {MODES.map(mode => {
                const isAuto = mode.value === 'auto'
                const isActive = value === mode.value
                return (
                  <div key={mode.value} className="approval-mode-block">
                    <motion.button
                      className={`approval-option ${isActive ? 'approval-option--active' : ''}`}
                      onClick={() => handleModeSelect(mode.value)}
                      whileHover={{ x: 3 }}
                      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                    >
                      <div className={`approval-option-icon approval-option-icon--${mode.value}`}>
                        <AppIcon name={mode.icon as 'zap'} size="xs" />
                      </div>
                      <div className="approval-option-text">
                        <span className="approval-option-label">
                          {mode.label}
                          {overrideActive && projectOverride?.approvalMode === mode.value && (
                            <span className="approval-project-badge">проект</span>
                          )}
                        </span>
                        <span className="approval-option-desc">{mode.desc}</span>
                      </div>
                      {isActive && <AppIcon name="check" size="xs" tone="accent" />}
                    </motion.button>

                    {/* ── Панель настроек авто-режима: под опцией «Авто» ── */}
                    {isAuto && isActive && (
                      <div className="approval-auto-panel">
                        {/* Свёрнутая строка-кнопка */}
                        {!autoPanelOpen && (
                          <button
                            className="approval-auto-collapsed"
                            onClick={(e) => { e.stopPropagation(); setAutoPanelOpen(true) }}
                          >
                            <AppIcon name="settings" size="xs" />
                            <span>Настройки</span>
                            {hasProject && overrideActive && (
                              <span className="approval-auto-collapsed-hint">проект</span>
                            )}
                            <AppIcon name="chevronDown" size="xs" />
                          </button>
                        )}

                        {/* Развёрнутый вид */}
                        <AnimatePresence initial={false}>
                          {autoPanelOpen && (
                            <motion.div
                              className="approval-settings-panel"
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                            >
                              {/* Шапка: заголовок + кнопка свернуть */}
                              <div className="approval-auto-header">
                                <span className="approval-auto-title">Настройки</span>
                                <button
                                  className="approval-auto-collapse-btn"
                                  onClick={(e) => { e.stopPropagation(); setAutoPanelOpen(false) }}
                                  title="Свернуть"
                                >
                                  <AppIcon name="chevronUp" size="xs" />
                                </button>
                              </div>

                              {/* Scope: глобально / этот проект */}
                              {hasProject && (
                                <div className="approval-scope">
                                  <button
                                    className={`approval-scope-btn ${scope === 'global' ? 'approval-scope-btn--active' : ''}`}
                                    onClick={() => setScope('global')}
                                  >Все проекты</button>
                                  <button
                                    className={`approval-scope-btn ${scope === 'project' ? 'approval-scope-btn--active' : ''}`}
                                    onClick={() => setScope('project')}
                                    title={projectName}
                                  >Этот проект</button>
                                </div>
                              )}

                              {/* Проектный override режима подтверждения */}
                              {scope === 'project' && hasProject && (
                                <label className="approval-mode-override">
                                  <span>Режим проекта</span>
                                  <select
                                    value={projModeValue}
                                    onChange={e => {
                                      const v = e.target.value
                                      onChange(v ? (v as ApprovalMode) : null, 'project')
                                    }}
                                  >
                                    <option value="">Как глобально{globalMode ? ` (${MODE_LABELS[globalMode]})` : ''}</option>
                                    <option value="ask">Спрашивать</option>
                                    <option value="auto">Авто</option>
                                    <option value="full">Полный доступ</option>
                                  </select>
                                </label>
                              )}

                              {/* Гранулярные тогглы авто-режима */}
                              <div className="approval-auto-toggles">
                                <div className="approval-auto-subtitle">
                                  Спрашивать:
                                  {scope === 'project' && hasProject && (
                                    <span className="approval-auto-scope-hint">
                                      {projectOverride?.auto ? 'переопределено' : 'как глобально'}
                                    </span>
                                  )}
                                </div>
                                {AUTO_TOGGLES.map(t => (
                                  <div key={t.key} className="approval-setting-row" title={t.desc}>
                                    <div className="approval-setting-row-text">
                                      <span className="approval-setting-row-label">{t.label}</span>
                                      <span className="approval-setting-row-desc">{t.desc}</span>
                                    </div>
                                    <Toggle
                                      value={effAuto[t.key]}
                                      onChange={v => handleAutoToggle(t.key, v)}
                                      aria-label={t.label}
                                    />
                                  </div>
                                ))}
                              </div>

                              <div className="approval-settings-hint">
                                {scope === 'project' && hasProject
                                  ? 'Только для этого проекта'
                                  : 'Запрещённые папки — в Настройки → Безопасность'}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    )}
                  </div>
                )
              })}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  )
}
