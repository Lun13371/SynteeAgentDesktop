// ── DotWizard: создание/редактирование Dot'а ─────────────────────────────
// Задача-в-фокусе: имя + задача сразу, остальное (расписание, наблюдение,
// webhook, правила, модель) — в сворачиваемом блоке «Триггеры и настройки».
import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import AppIcon, { type IconName } from '../../components/ui/AppIcon/AppIcon'
import ModelSelector from '../../components/ui/ModelSelector/ModelSelector'
import { useToast } from '../../components/ui/Toast/Toast'
import { DOT_ICON_PRESETS, DOT_COLOR_PRESETS, type Dot, type DotConfig } from '../../../../shared/types'
import { DotBlob } from './DotBlob'

interface WizardState {
  name: string
  icon: string
  color: string
  purpose: string
  rules: string
  scheduleKind: 'none' | 'cron' | 'interval'
  scheduleValue: string
  watchPaths: string
  webhookEnabled: boolean
  modelId: string | null
  modelProvider: string | null
}

const INITIAL: WizardState = {
  name: '',
  icon: 'eye',
  color: '#7c6cff',
  purpose: '',
  rules: '',
  scheduleKind: 'none',
  scheduleValue: '3600',
  watchPaths: '',
  webhookEnabled: false,
  modelId: null,
  modelProvider: null,
}

export function DotWizard({ dot, onClose }: { dot?: Dot | null; onClose: () => void }) {
  const { add: toast } = useToast()
  const [st, setSt] = useState<WizardState>(() => dot ? {
    name: dot.name,
    icon: dot.icon,
    color: dot.color,
    purpose: dot.purpose,
    rules: dot.rules ?? '',
    scheduleKind: dot.schedule?.kind ?? 'none',
    scheduleValue: dot.schedule?.value ?? '3600',
    watchPaths: (dot.watchPaths ?? []).join('\n'),
    webhookEnabled: !!dot.webhookEnabled,
    modelId: dot.modelId ?? null,
    modelProvider: dot.modelProvider ?? null,
  } : INITIAL)
  const [advanced, setAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)
  const set = (patch: Partial<WizardState>) => setSt(s => ({ ...s, ...patch }))

  // Esc — закрыть. Фокус в имя — только при создании (не воруем фокус при правке).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    if (!dot) nameInputRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, dot])

  const validate = (): string => {
    if (!st.name.trim()) return 'Придумай имя Dot’у'
    if (!st.purpose.trim()) return 'Опиши задачу — это мозг Dot’а'
    if (st.scheduleKind === 'cron') {
      const f = st.scheduleValue.trim().split(/\s+/)
      if (f.length !== 5) return 'Cron — 5 полей: «мин час день месяц день_недели», напр. «0 9 * * *»'
    }
    if (st.scheduleKind === 'interval') {
      const sec = Number(st.scheduleValue)
      if (!Number.isFinite(sec) || sec < 60) return 'Интервал — минимум 60 секунд'
    }
    if (st.watchPaths.trim() && st.watchPaths.trim().split('\n').some(p => !p.trim())) {
      return 'Пустая строка в путях наблюдения'
    }
    return ''
  }

  const save = async () => {
    const err = validate()
    if (err) { setError(err); return }
    setError('')
    setSaving(true)
    try {
      const input = {
        name: st.name.trim(),
        icon: st.icon,
        color: st.color,
        purpose: st.purpose.trim(),
        rules: st.rules.trim() || undefined,
        schedule: st.scheduleKind !== 'none'
          ? { kind: st.scheduleKind as 'cron' | 'interval', value: st.scheduleValue.trim() }
          : undefined,
        watchPaths: st.watchPaths.trim()
          ? st.watchPaths.split('\n').map(p => p.trim()).filter(Boolean)
          : undefined,
        webhookEnabled: st.webhookEnabled,
        modelId: st.modelId,
        modelProvider: st.modelProvider,
      }
      const res = dot
        ? await window.syntee.dots.update(dot.id, input as Partial<DotConfig>)
        : await window.syntee.dots.create(input)
      if (!res.ok) {
        setError(res.error ?? 'Не удалось сохранить')
        return
      }
      toast(dot ? 'Dot обновлён' : `Dot «${st.name.trim()}» создан`, 'success')
      onClose()
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dot-wizard-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <motion.div
        className="dot-wizard"
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 380, damping: 30 }}
      >
        <div>
          <div className="dot-wizard-title">{dot ? 'Настройка Dot’а' : 'Новый Dot'}</div>
          <div className="dot-wizard-sub">
            Dot — всегда-живущий агент: спит в фоне, просыпается по триггеру, работает в read-only режиме и сам решает — сообщить или промолчать.
          </div>
        </div>

        {/* Имя + превью капли */}
        <div className="dot-wizard-field">
          <span className="dot-wizard-label">Имя</span>
          <div className="dot-wizard-row" style={{ alignItems: 'center' }}>
            <DotBlob color={st.color} icon={st.icon} size={44} />
            <input
              ref={nameInputRef}
              className={`dot-wizard-input${error && !st.name.trim() ? ' dot-wizard-input--invalid' : ''}`}
              value={st.name}
              onChange={e => set({ name: e.target.value })}
              placeholder="Наблюдатель за ценами"
              maxLength={40}
            />
          </div>
        </div>

        {/* Задача — главный фокус визарда */}
        <div className="dot-wizard-field">
          <span className="dot-wizard-label">Задача</span>
          <textarea
            className={`dot-wizard-textarea dot-wizard-textarea--task${error && !st.purpose.trim() ? ' dot-wizard-input--invalid' : ''}`}
            value={st.purpose}
            onChange={e => set({ purpose: e.target.value })}
            placeholder="Опиши одним абзацем, что Dot должен делать при каждом пробуждении. Например: «Проверяй цену на RTX 5090 в DNS. Если упадёт ниже 150 000 ₽ — сообщи. Иначе молчи»."
            maxLength={2000}
          />
          <span className="dot-wizard-hint">
            Это попадает в системный промпт каждого пробуждения. Пиши конкретно: что проверять и что считать «изменением».
          </span>
        </div>

        {/* Иконка + цвет */}
        <div className="dot-wizard-row">
          <div className="dot-wizard-field">
            <span className="dot-wizard-label">Иконка</span>
            <div className="dot-wizard-icons">
              {DOT_ICON_PRESETS.map(ic => (
                <button
                  key={ic}
                  type="button"
                  className={`dot-wizard-icon-btn${st.icon === ic ? ' dot-wizard-icon-btn--active' : ''}`}
                  style={st.icon === ic ? { borderColor: st.color, color: st.color } : undefined}
                  onClick={() => set({ icon: ic })}
                >
                  <AppIcon name={ic as IconName} size="sm" />
                </button>
              ))}
            </div>
          </div>
          <div className="dot-wizard-field">
            <span className="dot-wizard-label">Цвет</span>
            <div className="dot-wizard-colors">
              {DOT_COLOR_PRESETS.map(c => (
                <button
                  key={c}
                  type="button"
                  className={`dot-wizard-color${st.color === c ? ' dot-wizard-color--active' : ''}`}
                  style={{ background: c }}
                  onClick={() => set({ color: c })}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Модель — видна сразу; подпись и селектор в одну строку */}
        <div className="dot-wizard-field">
          <div className="dot-wizard-model-row">
            <span className="dot-wizard-label">Модель</span>
            <ModelSelector
              modelId={st.modelId ?? ''}
              providerId={st.modelProvider ?? undefined}
              onChange={(modelId, providerId) => void set({ modelId, modelProvider: providerId })}
            />
          </div>
          <span className="dot-wizard-hint">
            Пусто = глобальная модель Dots (или main). Фоновые проверки не требуют топ-модели.
          </span>
        </div>

        {/* Триггеры и настройки — сворачиваемый блок */}
        <button
          type="button"
          className="dot-wizard-advanced-toggle"
          onClick={() => setAdvanced(v => !v)}
        >
          <AppIcon name={advanced ? 'chevronDown' : 'chevronRight'} size="xs" />
          <span>Триггеры и настройки</span>
          <span className="dot-wizard-advanced-summary">
            {st.scheduleKind === 'none' && !st.watchPaths.trim() && !st.webhookEnabled
              ? 'только ручные пробуждения'
              : [
                st.scheduleKind === 'interval' ? 'интервал' : st.scheduleKind === 'cron' ? 'cron' : null,
                st.watchPaths.trim() ? 'файлы' : null,
                st.webhookEnabled ? 'webhook' : null,
              ].filter(Boolean).join(' + ') || 'настроено'}
          </span>
        </button>

        {/* Сворачиваемый блок — CSS-аккордеон (grid-template-rows 0fr→1fr).
            Анимация высоты без JS-замеров framer-motion: контент НИКОГДА не
            клиппится (1fr всегда подстраивается под содержимое — даже когда
            textarea растёт), работает в обе стороны, и модалка скроллится. */}
        <div className={`dot-wizard-advanced-wrap${advanced ? ' dot-wizard-advanced-wrap--open' : ''}`}>
          <div className="dot-wizard-advanced">
            {/* Расписание */}
            <div className="dot-wizard-field">
              <span className="dot-wizard-label">Расписание пробуждения</span>
              <div className="dot-wizard-row">
                <select
                  className="dot-wizard-input"
                  value={st.scheduleKind}
                  onChange={e => set({ scheduleKind: e.target.value as WizardState['scheduleKind'] })}
                >
                  <option value="none">Без расписания</option>
                  <option value="interval">По интервалу</option>
                  <option value="cron">Cron</option>
                </select>
                {st.scheduleKind === 'interval' && (
                  <select
                    className="dot-wizard-input"
                    value={st.scheduleValue}
                    onChange={e => set({ scheduleValue: e.target.value })}
                  >
                    <option value="300">каждые 5 минут</option>
                    <option value="900">каждые 15 минут</option>
                    <option value="3600">каждый час</option>
                    <option value="10800">каждые 3 часа</option>
                    <option value="43200">каждые 12 часов</option>
                    <option value="86400">раз в день</option>
                  </select>
                )}
                {st.scheduleKind === 'cron' && (
                  <input
                    className="dot-wizard-input"
                    value={st.scheduleValue}
                    onChange={e => set({ scheduleValue: e.target.value })}
                    placeholder="0 9 * * * (каждый день в 9:00)"
                  />
                )}
              </div>
              {st.scheduleKind === 'cron' && (
                <span className="dot-wizard-hint">5 полей: минута час день месяц день-недели. «0 9 * * 1-5» = будни в 9:00.</span>
              )}
            </div>

            {/* Наблюдение за файлами */}
            <div className="dot-wizard-field">
              <span className="dot-wizard-label">Наблюдение за файлами/папками</span>
              <textarea
                className="dot-wizard-textarea"
                style={{ minHeight: 52 }}
                value={st.watchPaths}
                onChange={e => set({ watchPaths: e.target.value })}
                placeholder={'C:\\Projects\\notes\nD:\\Downloads'}
              />
              <span className="dot-wizard-hint">По одному пути на строку. Изменения будят Dot’а (с дебаунсом 3с).</span>
            </div>

            {/* Webhook */}
            <div className="dot-wizard-field">
              <div className="dots-settings-row">
                <div>
                  <span className="dots-settings-label">Webhook-триггер</span>
                  <div className="dots-settings-hint">POST-запрос на локальный URL будит Dot’а</div>
                </div>
                <button
                  type="button"
                  className={`dots-toggle${st.webhookEnabled ? ' dots-toggle--on' : ''}`}
                  onClick={() => set({ webhookEnabled: !st.webhookEnabled })}
                  aria-label="Webhook"
                />
              </div>
            </div>

            {/* Правила */}
            <div className="dot-wizard-field">
              <span className="dot-wizard-label">Правила-границы</span>
              <textarea
                className="dot-wizard-textarea"
                style={{ minHeight: 52 }}
                value={st.rules}
                onChange={e => set({ rules: e.target.value })}
                placeholder="Не сообщай об изменениях меньше 5%. Не пиши длиннее трёх абзацев."
                maxLength={2000}
              />
            </div>
          </div>
        </div>

        {error && <div className="dot-wizard-error">{error}</div>}

        <div className="dot-wizard-footer">
          <button type="button" className="dots-header-btn" onClick={onClose}>Отмена</button>
          <button
            type="button"
            className="dots-header-btn dots-header-btn--primary"
            onClick={() => void save()}
            disabled={saving}
          >
            <AppIcon name={saving ? 'loader' : 'check'} size="xs" animation={saving ? 'spin' : 'none'} />
            {saving ? 'Сохранение…' : dot ? 'Сохранить' : 'Создать Dot’а'}
          </button>
        </div>
      </motion.div>
    </div>
  )
}
