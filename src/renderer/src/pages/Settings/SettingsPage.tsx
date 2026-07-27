import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useSettingsStore } from '../../store/settings.store'
import { useUIStore, DEFAULT_THEME_SCHEDULE } from '../../store/ui.store'
import { useNavStore } from '../../store/nav.store'
import { useToast } from '../../components/ui/Toast/Toast'
import AppIcon, { type IconName } from '../../components/ui/AppIcon/AppIcon'
import Toggle from '../../components/ui/Toggle/Toggle'
import ColorPicker from '../../components/ui/ColorPicker/ColorPicker'
import CustomThemeEditor from '../../components/settings/CustomThemeEditor/CustomThemeEditor'
import AISettingsTab from '../../components/settings/AISettingsTab/AISettingsTab'
import ContextSettingsTab from '../../components/settings/ContextSettingsTab/ContextSettingsTab'
import IndexingSettingsTab from '../../components/settings/IndexingSettingsTab/IndexingSettingsTab'
import ProfileSection from '../../components/settings/ProfileSection/ProfileSection'
import ModelStatusSection from '../../components/settings/ModelStatusSection/ModelStatusSection'
import ApprovalModeSelector from '../../components/ui/ApprovalModeSelector/ApprovalModeSelector'
import ResetButton from '../../components/ui/ResetButton/ResetButton'
import { MSG_ANIM_VARIANTS } from '../../components/ui/MessageBubble/MessageBubble'
import { applyFontToDOM, applyAccentToDOM, applyGlassToDOM, applyDensityToDOM, applyGradientAccentToDOM, applyCustomThemeToDOM, applyBgImageToDOM, applyRainbowAccentToDOM } from '../../App'
import { DEFAULT_AGENT_SETTINGS, type AgentSettings as SharedAgentSettings, type CustomTheme } from '../../../../shared/types'
import './SettingsPage.css'

type Section =
  | 'profile' | 'general' | 'ai' | 'voice' | 'hotkeys' | 'modelStatus'
  | 'agent' | 'data' | 'appearance' | 'integrations' | 'context' | 'indexing'

interface SectionDef { id: Section; label: string; icon: IconName }
interface SectionGroup { title: string; items: SectionDef[] }

// Сайдбар сгруппирован по категориям — как в VS Code / Notion.
// Каждая группа получает uppercase-подзаголовок (см. .settings-nav-group-title).
const SECTION_GROUPS: SectionGroup[] = [
  {
    title: 'Аккаунт',
    items: [
      { id: 'profile', label: 'Профиль', icon: 'user' },
    ],
  },
  {
    title: 'Внешний вид',
    items: [
      { id: 'general',      label: 'Общие',       icon: 'settings' },
      { id: 'appearance',   label: 'Внешний вид', icon: 'palette' },
    ],
  },
  {
    title: 'ИИ и контекст',
    items: [
      { id: 'ai',         label: 'ИИ и Модели', icon: 'brain' },
      { id: 'modelStatus', label: 'Статус моделей', icon: 'server' },
      { id: 'context',    label: 'Контекст',    icon: 'layers' },
      { id: 'indexing',   label: 'Индексация',  icon: 'cpu' },
      { id: 'agent',      label: 'Агент',       icon: 'bot' },
    ],
  },
  {
    title: 'Управление',
    items: [
      { id: 'voice',   label: 'Голос',           icon: 'mic' },
      { id: 'hotkeys', label: 'Горячие клавиши', icon: 'shield' },
    ],
  },
  {
    title: 'Система',
    items: [
      { id: 'integrations', label: 'Интеграции', icon: 'link' },
      { id: 'data',         label: 'Данные',     icon: 'database' },
    ],
  },
]

export default function SettingsPage() {
  const navSection = useNavStore(s => s.settingsSection)
  const setNavSection = useNavStore(s => s.setSettingsSection)
  const setMainPage = useNavStore(s => s.setMainPage)
  const [section, setSection] = useState<Section>(
    (navSection as Section) || 'general'
  )
  const { settings, load, set } = useSettingsStore()
  const uiStore = useUIStore()
  const { setTheme, setAccentColor, setBgStyle, setMsgAnim,
    setAvatarStyle, setShowTime, setUserMarkdown, setUiSounds, setSendEffect,
    setGlassBlur, setDensity, setAccentGradient, setRainbowAccent, setBgImage,
    setCustomThemes, setActiveCustomThemeId, setThemeSchedule, setRecentAccents } = uiStore
  const { add: toast } = useToast()

  // Синхронизация: при изменении settingsSection извне (openSettings) — переключаемся.
  useEffect(() => {
    if (navSection && (navSection !== section)) {
      setSection(navSection as Section)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navSection])

  // Обратная синхронизация: локальный выбор юзера пишем в nav store.
  const handleSectionChange = (s: Section) => {
    setSection(s)
    setNavSection(s)
  }

  useEffect(() => { load() }, [])

  const handleSet = async (key: string, value: unknown) => {
    await set(key, value)
    if (key === 'theme') {
      setTheme(value as any)
      if (value === 'custom') {
        const ct = useUIStore.getState().customThemes.find(t => t.id === useUIStore.getState().activeCustomThemeId)
        if (ct) applyCustomThemeToDOM(ct)
      } else {
        applyCustomThemeToDOM(null)
      }
    }
    if (key === 'accentColor') {
      setAccentColor(value as string)
      if (!useUIStore.getState().rainbowAccent) applyAccentToDOM(value as string)
    }
    if (key === 'bgStyle') setBgStyle(value as string)
    if (key === 'msgAnim') setMsgAnim(value as string)
    if (key === 'avatarStyle') setAvatarStyle(value as any)
    if (key === 'showTime') setShowTime(value as any)
    if (key === 'userMarkdown') setUserMarkdown(value as boolean)
    if (key === 'uiSounds') setUiSounds(value as boolean)
    if (key === 'sendEffect') setSendEffect(value as boolean)
    if (key === 'glassBlur') { setGlassBlur(value as number); applyGlassToDOM(value as number) }
    if (key === 'density') { setDensity(value as any); applyDensityToDOM(value as any) }
    if (key === 'accentGradient') {
      setAccentGradient(value as any)
      const ag = value as any
      applyGradientAccentToDOM(ag.enabled, ag.color2, ag.angle, useUIStore.getState().accentColor)
    }
    if (key === 'rainbowAccent') {
      setRainbowAccent(value as boolean)
      if (value as boolean) {
        applyRainbowAccentToDOM(true)
      } else {
        applyRainbowAccentToDOM(false)
        applyAccentToDOM(useUIStore.getState().accentColor)
      }
    }
    if (key === 'bgImage') { setBgImage(value as any); applyBgImageToDOM(value as any) }
    if (key === 'customThemes') {
      setCustomThemes(value as CustomTheme[])
      const activeId = useUIStore.getState().activeCustomThemeId
      if (useUIStore.getState().theme === 'custom' && activeId) {
        const ct = (value as CustomTheme[]).find(t => t.id === activeId)
        if (ct) applyCustomThemeToDOM(ct)
      }
    }
    if (key === 'activeCustomThemeId') {
      setActiveCustomThemeId(value as any)
      if (useUIStore.getState().theme === 'custom' && value) {
        const ct = useUIStore.getState().customThemes.find(t => t.id === value)
        if (ct) applyCustomThemeToDOM(ct)
      }
    }
    if (key === 'themeSchedule') setThemeSchedule(value as any)
    if (key === 'recentAccents') setRecentAccents(value as string[])
    if (key === 'fontFamily') applyFontToDOM(value as string)
  }

  return (
    <div className="settings-root">
      {/* Сайдбар разделов (сгруппированный) */}
      <nav className="settings-nav glass">
        <button
          type="button"
          className="settings-back-btn"
          onClick={() => setMainPage('chat')}
          title="Назад к чату"
        >
          <AppIcon name="chevronLeft" size="sm" />
          <span>Назад</span>
        </button>
        <div className="settings-nav-title">Настройки</div>
        {SECTION_GROUPS.map(group => (
          <div key={group.title} className="settings-nav-group">
            <div className="settings-nav-group-title">{group.title}</div>
            {group.items.map(s => (
              <motion.button
                key={s.id}
                className={`settings-nav-item no-drag ${section === s.id ? 'settings-nav-item--active' : ''}`}
                onClick={() => handleSectionChange(s.id)}
                whileTap={{ scale: 0.97 }}
              >
                {/* Скользящий активный индикатор: один motion.div с layoutId,
                    который "переезжает" между пунктами через shared layout-анимацию. */}
                {section === s.id && (
                  <motion.span
                    layoutId="settings-nav-active"
                    className="settings-nav-active-pill"
                    transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                  />
                )}
                <AppIcon name={s.icon} size="sm" tone={section === s.id ? 'accent' : 'muted'} />
                <span className="settings-nav-item-label">{s.label}</span>
              </motion.button>
            ))}
          </div>
        ))}
      </nav>

      {/* Контент */}
      <div className="settings-content">
        <motion.div
          key={section}
          className="settings-section"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 320, damping: 30 }}
        >
            {section === 'profile' && (
              <ProfileSection />
            )}
            {section === 'general' && (
              <GeneralSection settings={settings} onSet={handleSet} />
            )}
            {section === 'ai' && (
              <AISettingsTab />
            )}
            {section === 'modelStatus' && (
              <ModelStatusSection />
            )}
            {section === 'context' && (
              <ContextSettingsTab />
            )}
            {section === 'indexing' && (
              <IndexingSettingsTab />
            )}
            {section === 'appearance' && (
              <AppearanceSection settings={settings} onSet={handleSet} />
            )}
            {section === 'voice' && (
              <VoiceSection settings={settings} onSet={handleSet} />
            )}
            {section === 'hotkeys' && (
              <HotkeysSection settings={settings} onSet={handleSet} />
            )}
            {section === 'agent' && (
              <AgentSection settings={settings} onSet={handleSet} />
            )}
            {section === 'integrations' && (
              <IntegrationsSection settings={settings} onSet={handleSet} />
            )}
            {section === 'data' && (
              <DataSection settings={settings} onSet={handleSet} toast={toast} />
            )}
          </motion.div>
      </div>
    </div>
  )
}

// ===== Разделы =====

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="settings-section-title">{children}</h2>
}

function Field({ label, description, children, block }: {
  label: string; description?: string; children: React.ReactNode; block?: boolean
}) {
  return (
    <div className={`settings-field${block ? ' settings-field--block' : ''}`}>
      <div className="settings-field-label">
        <span>{label}</span>
        {description && <p className="settings-field-desc">{description}</p>}
      </div>
      <div className="settings-field-control">{children}</div>
    </div>
  )
}

function GeneralSection({ settings, onSet }: { settings: Record<string, unknown>; onSet: (k: string, v: unknown) => void }) {
  return (
    <>
      <SectionTitle>Общие</SectionTitle>
      <Field label="Имя пользователя" description="Syntee будет обращаться к вам по имени">
        <input
          className="settings-input"
          value={(settings['userName'] as string) || ''}
          onChange={e => onSet('userName', e.target.value)}
          placeholder="Введите имя..."
        />
      </Field>
      <Field label="Запуск с Windows">
        <Toggle value={!!settings['autostart']} onChange={v => onSet('autostart', v)} />
      </Field>
      <Field label="Язык интерфейса">
        <select className="settings-select" value={(settings['language'] as string) || 'ru'} onChange={e => onSet('language', e.target.value)}>
          <option value="ru">Русский</option>
          <option value="en">English</option>
        </select>
      </Field>
      <Field label="При закрытии окна">
        <select className="settings-select" value={(settings['closeAction'] as string) || 'tray'} onChange={e => onSet('closeAction', e.target.value)}>
          <option value="tray">Убрать в трей</option>
          <option value="quit">Выйти</option>
        </select>
      </Field>
      <Field label="Счётчик контекста" description="Кружок с заполнением контекста в поле ввода">
        <Toggle value={(settings['showContextRing'] as boolean) ?? true} onChange={v => onSet('showContextRing', v)} />
      </Field>
    </>
  )
}

// Превью анимации — мини-демо при наведении
function AnimPreview({ animId, active, onClick }: { animId: string; active: boolean; onClick: () => void }) {
  const [key, setKey] = useState(0)
  const v = MSG_ANIM_VARIANTS[animId]

  return (
    <button
      className={`anim-preview-btn ${active ? 'anim-preview-btn--active' : ''}`}
      onClick={onClick}
      onMouseEnter={() => setKey(k => k + 1)}
      title={v.desc}
    >
      <div className="anim-preview-canvas">
        <AnimatePresence mode="wait">
          <motion.div
            key={key}
            className="anim-preview-bubble anim-preview-bubble--ai"
            initial={v.initial}
            animate={v.animate}
            transition={v.transition}
          >
            Ассистент
          </motion.div>
        </AnimatePresence>
        <AnimatePresence mode="wait">
          <motion.div
            key={key + 1000}
            className="anim-preview-bubble anim-preview-bubble--user"
            initial={v.initial}
            animate={v.animate}
            transition={{ ...v.transition, delay: (v.transition as any).duration ? ((v.transition as any).duration as number) * 0.4 : 0.08 }}
          >
            Вы
          </motion.div>
        </AnimatePresence>
      </div>
      <span className="anim-preview-label">{v.label}</span>
      <span className="anim-preview-desc">{v.desc}</span>
    </button>
  )
}


const BG_STYLES = [
  { id: 'particles',   label: 'Частицы',    icon: '✦', desc: 'Точки с линиями' },
  { id: 'matrix',      label: 'Матрица',    icon: '⌨', desc: 'Дождь символов' },
  { id: 'waves',       label: 'Волны',      icon: '〜', desc: 'Плавные волны' },
  { id: 'aurora',      label: 'Аврора',     icon: '◈', desc: 'Северное сияние' },
  { id: 'fireflies',   label: 'Светлячки',  icon: '✺', desc: 'Мерцающие огни' },
  { id: 'starfield',   label: 'Звёзды',     icon: '✧', desc: 'Звёздное поле с параллаксом' },
  { id: 'nebula',      label: 'Туманность', icon: '◉', desc: 'Облака космоса' },
  { id: 'topographic', label: 'Топо',       icon: '⌒', desc: 'Контурные линии' },
  { id: 'geometric',   label: 'Геометрия',  icon: '⬡', desc: 'Вращающиеся фигуры' },
  { id: 'none',        label: 'Выкл',       icon: '✕', desc: 'Без анимации' },
]
// 9 тем: 4 тёмных + 2 светлых + 3 цветных. Каждая — bg, surface, text,
// accent цвета для мини-превью интерфейса в selector.
const THEMES = [
  { id: 'dark',     label: 'Тёмная',     group: 'dark',  colors: { bg: '#0e0e12', surface: '#1c1c24', text: '#e8e8ec', accent: '#e8e8ec' } },
  { id: 'midnight', label: 'Полночь',    group: 'dark',  colors: { bg: '#060912', surface: '#0f1525', text: '#e0e8ff', accent: '#4d9fff' } },
  { id: 'forest',   label: 'Лес',        group: 'dark',  colors: { bg: '#070e09', surface: '#122014', text: '#d4f0d8', accent: '#4caf60' } },
  { id: 'slate',    label: 'Сталь',      group: 'dark',  colors: { bg: '#0a0d14', surface: '#1a1f2c', text: '#e2e8f0', accent: '#5b8def' } },
  { id: 'amber',    label: 'Янтарь',     group: 'dark',  colors: { bg: '#100a05', surface: '#26190e', text: '#f5e6d3', accent: '#ff9b3d' } },
  { id: 'rose',     label: 'Роза',       group: 'dark',  colors: { bg: '#120810', surface: '#2a1620', text: '#fce8ee', accent: '#ff6b9d' } },
  { id: 'crimson',  label: 'Багровый',   group: 'dark',  colors: { bg: '#100406', surface: '#281012', text: '#ffe8ea', accent: '#ff5a4d' } },
  { id: 'light',    label: 'Светлая',    group: 'light', colors: { bg: '#f4f1ec', surface: '#f3efe8', text: '#2a2620', accent: '#4a3f2f' } },
  { id: 'paper',    label: 'Бумага',     group: 'light', colors: { bg: '#f6f8fa', surface: '#f0f3f6', text: '#1f2328', accent: '#0969da' } },
]

// Preset цвета для accent picker — меняет только --accent, не всю тему.
const ACCENT_PRESETS = [
  '#4d9fff', // blue
  '#4caf60', // green
  '#ff6b9d', // pink
  '#ff9b3d', // amber
  '#ff5a4d', // red
  '#a78bfa', // purple
  '#facc15', // yellow
  '#06b6d4', // cyan
]
// Только шрифты, подключённые локально в styles/fonts.css.
// Plus Jakarta Sans / Geist / DM Sans убраны — грузились с Google Fonts
// CDN (без интернета fallback), Geist ещё и без кириллицы.
const FONTS = ['Inter', 'system']

function AppearanceSection({ settings, onSet }: { settings: Record<string, unknown>; onSet: (k: string, v: unknown) => void }) {
  const [accentPickerOpen, setAccentPickerOpen] = useState(false)
  const [accentPickerPos, setAccentPickerPos] = useState<{ top: number; left: number } | null>(null)
  const accentBtnRef = useRef<HTMLButtonElement>(null)
  const [themeEditorOpen, setThemeEditorOpen] = useState(false)
  const customThemes = (settings['customThemes'] as CustomTheme[]) || []
  const activeCustomThemeId = settings['activeCustomThemeId'] as string | null
  const recentAccents = (settings['recentAccents'] as string[]) || []
  const rainbowAccent = settings['rainbowAccent'] as boolean
  const accentGradient = (settings['accentGradient'] as { enabled: boolean; color2: string; angle: number }) || { enabled: false, color2: '#a78bfa', angle: 135 }
  const bgImage = settings['bgImage'] as { src: string; blur: number; opacity: number; tint: string; tintStrength: number } | null
  const themeSchedule = (settings['themeSchedule'] as any) || DEFAULT_THEME_SCHEDULE
  const fileInputRef = useRef<HTMLInputElement>(null)

  const commitAccent = (c: string) => {
    onSet('accentColor', c)
    const next = [c, ...recentAccents.filter(x => x !== c)].slice(0, 8)
    onSet('recentAccents', next)
  }

  const allThemes = [
    ...THEMES,
    ...customThemes.map(t => ({
      id: t.id,
      label: t.name,
      group: t.base,
      colors: {
        bg: t.colors.bodyBg,
        surface: t.colors.bgSecondary,
        text: t.colors.textPrimary,
        accent: t.colors.accent,
      },
      isCustom: true,
    })),
  ]

  const onPickBgImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    // Получаем расширение файла
    const ext = file.name.split('.').pop()?.toLowerCase() || 'png'
    // Читаем как ArrayBuffer и отправляем в main для сохранения в userData
    const buf = await file.arrayBuffer()
    const savedPath = await window.syntee.bgImage.save(new Uint8Array(buf), ext)
    if (!savedPath) {
      toast('Не удалось сохранить картинку фона', 'error')
      return
    }
    onSet('bgImage', { src: savedPath, blur: bgImage?.blur ?? 8, opacity: bgImage?.opacity ?? 40, tint: bgImage?.tint ?? '#000000', tintStrength: bgImage?.tintStrength ?? 30 })
  }

  return (
    <>
      <SectionTitle>Внешний вид</SectionTitle>
      <Field label="Тема" description="Выберите цветовую палитру" block>
        <div className="settings-theme-cards">
          {allThemes.map(t => {
            const isActive = settings['theme'] === t.id || (t.id === activeCustomThemeId && settings['theme'] === 'custom')
            return (
              <motion.button
                key={t.id}
                type="button"
                className={`settings-theme-card${isActive ? ' settings-theme-card--active' : ''}`}
                onClick={() => onSet('theme', t.id === activeCustomThemeId ? 'custom' : t.id)}
                whileTap={{ scale: 0.96 }}
                whileHover={{ y: -2 }}
                transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                title={t.label}
              >
                <div
                  className="settings-theme-card__preview"
                  style={{ background: t.colors.bg, borderColor: t.colors.accent + '22' }}
                >
                  <div className="settings-theme-card__sidebar" style={{ background: t.colors.surface }} />
                  <div className="settings-theme-card__content">
                    <div className="settings-theme-card__bubble settings-theme-card__bubble--left" style={{ background: t.colors.surface, borderColor: t.colors.text + '18' }} />
                    <div className="settings-theme-card__bubble settings-theme-card__bubble--right" style={{ background: t.colors.accent }} />
                  </div>
                  <div className="settings-theme-card__dot" style={{ background: t.colors.accent, boxShadow: `0 0 8px ${t.colors.accent}66` }} />
                </div>
                <div className="settings-theme-card__label">{t.label}</div>
                {isActive && (
                  <motion.div
                    className="settings-theme-card__check"
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                    style={{ background: t.colors.accent }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  </motion.div>
                )}
              </motion.button>
            )
          })}
          <motion.button
            type="button"
            className="settings-theme-card settings-theme-card--add"
            onClick={() => setThemeEditorOpen(v => !v)}
            whileTap={{ scale: 0.96 }}
            whileHover={{ y: -2 }}
            title="Создать кастомную тему"
          >
            <div className="settings-theme-card__preview settings-theme-card__preview--add">
              <span>+</span>
            </div>
            <div className="settings-theme-card__label">Создать</div>
          </motion.button>
        </div>
      </Field>

      <AnimatePresence>
        {themeEditorOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 32 }}
            style={{ overflow: 'hidden' }}
          >
            <CustomThemeEditor
              themes={customThemes}
              activeId={activeCustomThemeId}
              onChange={(themes, activeId) => {
                onSet('customThemes', themes)
                if (activeId !== undefined) onSet('activeCustomThemeId', activeId)
              }}
              onApply={(id) => {
                onSet('activeCustomThemeId', id)
                onSet('theme', 'custom')
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <Field label="Цвет акцента" description="Дополнительный акцент поверх темы">
        <div className="settings-accent-picker">
          {ACCENT_PRESETS.map(c => {
            const isActive = (settings['accentColor'] as string) === c && !rainbowAccent
            return (
              <motion.button
                key={c}
                type="button"
                className={`settings-accent-swatch${isActive ? ' settings-accent-swatch--active' : ''}`}
                style={{ background: c }}
                onClick={() => { commitAccent(c) }}
                whileTap={{ scale: 0.85 }}
                whileHover={{ scale: 1.15 }}
                transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                title={c}
                disabled={rainbowAccent}
              >
                {isActive && (
                  <motion.svg
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                    width="12" height="12" viewBox="0 0 24 24" fill="none"
                    stroke={c === '#facc15' ? '#000' : '#fff'}
                    strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12"/>
                  </motion.svg>
                )}
              </motion.button>
            )
          })}
          <motion.button
            type="button"
            className={`settings-accent-swatch settings-accent-swatch--custom${accentPickerOpen ? ' settings-accent-swatch--active' : ''}`}
            ref={accentBtnRef}
            onClick={() => {
              if (!accentPickerOpen && accentBtnRef.current) {
                const r = accentBtnRef.current.getBoundingClientRect()
                setAccentPickerPos({ top: r.bottom + 8, left: r.left })
              }
              setAccentPickerOpen(v => !v)
            }}
            whileTap={{ scale: 0.85 }}
            whileHover={{ scale: 1.15 }}
            title="Свой цвет"
            disabled={rainbowAccent}
            style={{ background: rainbowAccent ? 'conic-gradient(red, orange, yellow, green, blue, purple, red)' : (settings['accentColor'] as string) || '#fff' }}
          >
            <span className="settings-accent-swatch-plus">＋</span>
          </motion.button>
        </div>
      </Field>

      {createPortal(
        <AnimatePresence>
          {accentPickerOpen && !rainbowAccent && accentPickerPos && (
            <>
              <div className="settings-accent-popover-overlay" onClick={() => setAccentPickerOpen(false)} />
              <motion.div
                className="settings-accent-popover"
                style={{ top: accentPickerPos.top, left: accentPickerPos.left }}
                initial={{ opacity: 0, scale: 0.9, y: -8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: -8 }}
                transition={{ type: 'spring', stiffness: 400, damping: 28 }}
              >
                <ColorPicker
                  value={(settings['accentColor'] as string) || '#ffffff'}
                  onChange={(c) => {
                    useUIStore.getState().setAccentColor(c)
                    if (!useUIStore.getState().rainbowAccent) applyAccentToDOM(c)
                  }}
                  onCommit={commitAccent}
                  recent={recentAccents}
                />
              </motion.div>
            </>
          )}
        </AnimatePresence>,
        document.body
      )}

      <Field label="Радужный акцент" description="Accent медленно циклит по всем цветам">
        <Toggle value={!!rainbowAccent} onChange={v => onSet('rainbowAccent', v)} />
      </Field>

      <Field label="Градиентный акцент" description="Accent как градиент из двух цветов">
        <Toggle value={!!accentGradient.enabled} onChange={v => onSet('accentGradient', { ...accentGradient, enabled: v })} disabled={rainbowAccent} />
      </Field>
      <AnimatePresence>
        {accentGradient.enabled && !rainbowAccent && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 32 }}
            style={{ overflow: 'hidden' }}
          >
            <Field label="Второй цвет градиента">
              <div className="settings-accent-picker">
                {ACCENT_PRESETS.map(c => (
                  <motion.button
                    key={c}
                    type="button"
                    className={`settings-accent-swatch${accentGradient.color2 === c ? ' settings-accent-swatch--active' : ''}`}
                    style={{ background: c }}
                    onClick={() => onSet('accentGradient', { ...accentGradient, color2: c })}
                    whileTap={{ scale: 0.85 }}
                    whileHover={{ scale: 1.15 }}
                  />
                ))}
              </div>
            </Field>
            <Field label="Угол градиента" description={`${accentGradient.angle}°`}>
              <input
                type="range" min={0} max={360} value={accentGradient.angle}
                onChange={e => onSet('accentGradient', { ...accentGradient, angle: Number(e.target.value) })}
                className="settings-slider"
              />
            </Field>
          </motion.div>
        )}
      </AnimatePresence>

      <Field label="Шрифт">
        <select className="settings-select" value={(settings['fontFamily'] as string) || 'Inter'} onChange={e => onSet('fontFamily', e.target.value)}>
          {FONTS.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
      </Field>

      <Field label="Плотность интерфейса" description="Компактный / Комфортный / Просторный">
        <div className="settings-theme-grid">
          {[
            { id: 'compact', label: 'Компактно' },
            { id: 'comfortable', label: 'Комфорт' },
            { id: 'spacious', label: 'Просторно' },
          ].map(d => (
            <motion.button
              key={d.id}
              className={`settings-theme-btn ${(settings['density'] || 'comfortable') === d.id ? 'settings-theme-btn--active' : ''}`}
              style={{ background: 'var(--bg-tertiary)', fontSize: 12 }}
              onClick={() => onSet('density', d.id)}
              whileTap={{ scale: 0.94 }}
            >{d.label}</motion.button>
          ))}
        </div>
      </Field>

      <Field label="Стекло (Glass blur)" description={`${settings['glassBlur'] ?? 20}px — размытие Liquid Glass`}>
        <input
          type="range" min={0} max={40} value={(settings['glassBlur'] as number) ?? 20}
          onChange={e => onSet('glassBlur', Number(e.target.value))}
          className="settings-slider"
        />
      </Field>

      <Field label="Стиль фона" description="Анимация на заднем плане" block>
        <div className="settings-bg-grid">
          {BG_STYLES.map(s => (
            <motion.button
              key={s.id}
              className={`settings-bg-btn ${(settings['bgStyle'] || 'particles') === s.id ? 'settings-bg-btn--active' : ''}`}
              onClick={() => { onSet('bgStyle', s.id); onSet('animatedBackground', s.id !== 'none') }}
              whileTap={{ scale: 0.94 }}
              title={s.desc}
            >
              <span className="settings-bg-icon">{s.icon}</span>
              <span className="settings-bg-label">{s.label}</span>
            </motion.button>
          ))}
        </div>
      </Field>

      <Field label="Фоновое изображение" description="Картинка как фон (под анимацией)" block>
        <div className="settings-bgimage-controls">
          <input ref={fileInputRef} type="file" accept="image/*" onChange={onPickBgImage} style={{ display: 'none' }} />
          <motion.button
            className="settings-btn"
            whileTap={{ scale: 0.95 }}
            onClick={() => fileInputRef.current?.click()}
          >Загрузить</motion.button>
          {bgImage && (
            <>
              <motion.button
                className="settings-btn settings-btn--danger"
                whileTap={{ scale: 0.95 }}
                onClick={() => { window.syntee.bgImage.clear(); onSet('bgImage', null) }}
              >Очистить</motion.button>
            </>
          )}
        </div>
        {bgImage && (
          <div className="settings-bgimage-sliders">
            <label>
              <span>Размытие: {bgImage.blur}px</span>
              <input type="range" min={0} max={40} value={bgImage.blur}
                onChange={e => onSet('bgImage', { ...bgImage, blur: Number(e.target.value) })} className="settings-slider" />
            </label>
            <label>
              <span>Непрозрачность: {bgImage.opacity}%</span>
              <input type="range" min={0} max={100} value={bgImage.opacity}
                onChange={e => onSet('bgImage', { ...bgImage, opacity: Number(e.target.value) })} className="settings-slider" />
            </label>
            <label>
              <span>Затемнение: {bgImage.tintStrength}%</span>
              <input type="range" min={0} max={100} value={bgImage.tintStrength}
                onChange={e => onSet('bgImage', { ...bgImage, tint: '#000000', tintStrength: Number(e.target.value) })} className="settings-slider" />
            </label>
          </div>
        )}
      </Field>

      <Field label="Анимация сообщений" description="Наведи на карточку чтобы увидеть превью" block>
        <div className="anim-preview-grid">
          {Object.entries(MSG_ANIM_VARIANTS).map(([id]) => (
            <AnimPreview
              key={id}
              animId={id}
              active={(settings['msgAnim'] || 'slide') === id}
              onClick={() => onSet('msgAnim', id)}
            />
          ))}
        </div>
      </Field>

      <Field label="Аватар ассистента" description="Иконка рядом с ответами">
        <div className="settings-theme-grid">
          {[
            { id: 'hex',    label: '⬡ Гекс'   },
            { id: 'circle', label: '● Круг'    },
            { id: 'letter', label: 'S Буква'   },
            { id: 'emoji',  label: '🤖 Эмодзи' },
            { id: 'none',   label: '✕ Нет'     },
          ].map(a => (
            <motion.button
              key={a.id}
              className={`settings-theme-btn ${(settings['avatarStyle'] || 'hex') === a.id ? 'settings-theme-btn--active' : ''}`}
              style={{ background: 'var(--bg-tertiary)', fontSize: 12 }}
              onClick={() => onSet('avatarStyle', a.id)}
              whileTap={{ scale: 0.94 }}
            >{a.label}</motion.button>
          ))}
        </div>
      </Field>

      <Field label="Время сообщений" description="Когда показывать время рядом с сообщением">
        <div className="settings-theme-grid">
          {[
            { id: 'always', label: 'Всегда'   },
            { id: 'hover',  label: 'При наведении' },
            { id: 'never',  label: 'Никогда'  },
          ].map(t => (
            <motion.button
              key={t.id}
              className={`settings-theme-btn ${(settings['showTime'] || 'hover') === t.id ? 'settings-theme-btn--active' : ''}`}
              style={{ background: 'var(--bg-tertiary)', fontSize: 12 }}
              onClick={() => onSet('showTime', t.id)}
              whileTap={{ scale: 0.94 }}
            >{t.label}</motion.button>
          ))}
        </div>
      </Field>

      <Field label="Markdown в своих сообщениях" description="Рендерить жирный, курсив, код в ваших сообщениях">
        <Toggle value={!!(settings['userMarkdown'])} onChange={v => onSet('userMarkdown', v)} />
      </Field>

      <Field label="Звуки интерфейса" description="Звук отправки и получения сообщений">
        <Toggle value={settings['uiSounds'] !== false} onChange={v => onSet('uiSounds', v)} />
      </Field>

      <Field label="Эффект отправки" description="Ripple-вспышка на кнопке при отправке">
        <Toggle value={settings['sendEffect'] !== false} onChange={v => onSet('sendEffect', v)} />
      </Field>

      <Field label="Автосмена темы" description="День → светлая, ночь → тёмная">
        <Toggle value={!!themeSchedule.enabled} onChange={v => onSet('themeSchedule', { ...themeSchedule, enabled: v })} />
      </Field>
      <AnimatePresence>
        {themeSchedule.enabled && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 32 }}
            style={{ overflow: 'hidden' }}
          >
            <Field label="Дневная тема">
              <select className="settings-select" value={themeSchedule.dayTheme} onChange={e => onSet('themeSchedule', { ...themeSchedule, dayTheme: e.target.value })}>
                {THEMES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                {customThemes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="Ночная тема">
              <select className="settings-select" value={themeSchedule.nightTheme} onChange={e => onSet('themeSchedule', { ...themeSchedule, nightTheme: e.target.value })}>
                {THEMES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                {customThemes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="День начинается в">
              <input type="time" className="settings-input" value={themeSchedule.dayTime} onChange={e => onSet('themeSchedule', { ...themeSchedule, dayTime: e.target.value })} />
            </Field>
            <Field label="Ночь начинается в">
              <input type="time" className="settings-input" value={themeSchedule.nightTime} onChange={e => onSet('themeSchedule', { ...themeSchedule, nightTime: e.target.value })} />
            </Field>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

function VoiceSection({ settings, onSet }: { settings: Record<string, unknown>; onSet: (k: string, v: unknown) => void }) {
  return (
    <>
      <SectionTitle>Голос</SectionTitle>
      <Field label="Wake word" description="Слово для активации голосового режима">
        <input className="settings-input" value={(settings['wakeWord'] as string) || 'синти'} onChange={e => onSet('wakeWord', e.target.value)} />
      </Field>
      <Field label="Голос ассистента">
        <select className="settings-select" value={(settings['voiceId'] as string) || 'alloy'} onChange={e => onSet('voiceId', e.target.value)}>
          {['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      </Field>
      <div className="settings-info-note">
        Модели STT и TTS задаются в разделе <strong>ИИ и Модели</strong> → Назначения ролей.
      </div>
    </>
  )
}

function HotkeysSection({ settings, onSet }: { settings: Record<string, unknown>; onSet: (k: string, v: unknown) => void }) {
  const hotkeys = (settings['hotkeys'] as Record<string, string>) || {}
  const [recording, setRecording] = useState<string | null>(null)
  const [pressed, setPressed] = useState<string>('')

  const KEYS = [
    { id: 'mainWindow',    label: 'Открыть/скрыть окно',       icon: '🪟' },
    { id: 'overlay',       label: 'Оверлей (Circle to Search)', icon: '🔍' },
    { id: 'voice',         label: 'Голосовой режим',            icon: '🎤' },
    { id: 'spotlight',     label: 'Spotlight строка',           icon: '⚡' },
    { id: 'quickQuestion', label: 'Быстрый вопрос',            icon: '💬' },
  ]

  const formatKey = (e: KeyboardEvent): string => {
    const parts: string[] = []
    if (e.ctrlKey)  parts.push('Ctrl')
    if (e.altKey)   parts.push('Alt')
    if (e.shiftKey) parts.push('Shift')
    if (e.metaKey)  parts.push('Meta')
    const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key
    if (!['Control','Alt','Shift','Meta'].includes(e.key)) parts.push(key)
    return parts.join('+')
  }

  useEffect(() => {
    if (!recording) return
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      const combo = formatKey(e)
      setPressed(combo)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault()
      const combo = formatKey(e)
      if (combo && !['Ctrl','Alt','Shift','Meta'].every(m => combo === m)) {
        onSet('hotkeys', { ...hotkeys, [recording]: combo })
        setRecording(null)
        setPressed('')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [recording, hotkeys, onSet])

  const renderBind = (bind: string) => {
    if (!bind) return <span className="hk-empty">Не задано</span>
    return bind.split('+').map((k, i) => (
      <span key={i} className="hk-key">{k}</span>
    ))
  }

  return (
    <>
      <SectionTitle>Горячие клавиши</SectionTitle>
      <div className="hk-list">
        {KEYS.map(k => (
          <div key={k.id} className="hk-row">
            <div className="hk-info">
              <span className="hk-icon">{k.icon}</span>
              <span className="hk-label">{k.label}</span>
            </div>
            <div className="hk-bind-wrap">
              <button
                className={`hk-bind-btn ${recording === k.id ? 'hk-bind-btn--recording' : ''}`}
                onClick={() => { setRecording(recording === k.id ? null : k.id); setPressed('') }}
              >
                {recording === k.id
                  ? (pressed
                      ? <>{pressed.split('+').map((p, i) => <span key={i} className="hk-key hk-key--live">{p}</span>)}</>
                      : <span className="hk-recording-hint">Нажмите клавиши...</span>)
                  : renderBind(hotkeys[k.id] || '')}
              </button>
              {hotkeys[k.id] && recording !== k.id && (
                <button className="hk-clear" onClick={() => onSet('hotkeys', { ...hotkeys, [k.id]: '' })} title="Очистить">×</button>
              )}
            </div>
          </div>
        ))}
      </div>
      {recording && (
        <div className="hk-overlay-hint">
          <span>Нажмите комбинацию клавиш для <strong>{KEYS.find(k => k.id === recording)?.label}</strong></span>
          <button onClick={() => { setRecording(null); setPressed('') }}>Отмена</button>
        </div>
      )}
    </>
  )
}

function AgentSection({ settings, onSet }: { settings: Record<string, unknown>; onSet: (k: string, v: unknown) => void }) {
  const [agentSettings, setAgentSettings] = useState<SharedAgentSettings>(DEFAULT_AGENT_SETTINGS)

  useEffect(() => {
    window.syntee.agent.getSettings().then((s: SharedAgentSettings) => {
      setAgentSettings(prev => ({ ...prev, ...s }))
    }).catch(() => {})
  }, [])

  const updateAgent = (patch: Partial<SharedAgentSettings>) => {
    const next = { ...agentSettings, ...patch }
    setAgentSettings(next)
    window.syntee.agent.setSettings(next).catch(() => {})
  }

  const perms = (settings['agentPermissions'] as Record<string, unknown>) || {}

  const OUTPUT_MODES = [
    { value: 'compact',  label: 'Компактный', desc: 'Только иконки инструментов в одну строку' },
    { value: 'normal',   label: 'Обычный',    desc: 'Название + первый аргумент каждого шага' },
    { value: 'detailed', label: 'Подробный',  desc: 'Все аргументы и результаты, раскрываются' },
  ]

  return (
    <>
      <SectionTitle>Агент и Безопасность</SectionTitle>

      <Field label="Режим подтверждения действий" description="Когда агент запрашивает подтверждение перед выполнением">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <ApprovalModeSelector
            value={agentSettings.approvalMode as import('../../../../../shared/types').ApprovalMode}
            onChange={mode => updateAgent({ approvalMode: mode })}
          />
          <ResetButton current={agentSettings.approvalMode} defaultValue={DEFAULT_AGENT_SETTINGS.approvalMode} onReset={() => updateAgent({ approvalMode: DEFAULT_AGENT_SETTINGS.approvalMode })} />
        </div>
      </Field>

      <Field label="Режим размышлений" description="AI показывает ход своих мыслей перед ответом — цепочка рассуждений видна в свёрнутом блоке">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Toggle value={agentSettings.enableThinking} onChange={v => updateAgent({ enableThinking: v })} />
          <ResetButton current={agentSettings.enableThinking} defaultValue={DEFAULT_AGENT_SETTINGS.enableThinking} onReset={() => updateAgent({ enableThinking: DEFAULT_AGENT_SETTINGS.enableThinking })} />
        </div>
      </Field>

      <Field label="Вывод инструментов" description="Как отображать цепочку действий агента в чате">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {OUTPUT_MODES.map(m => (
              <button
                key={m.value}
                className={`settings-chip ${agentSettings.toolOutputMode === m.value ? 'settings-chip--active' : ''}`}
                onClick={() => updateAgent({ toolOutputMode: m.value })}
                title={m.desc}
              >
                {m.label}
              </button>
            ))}
          </div>
          <ResetButton current={agentSettings.toolOutputMode} defaultValue={DEFAULT_AGENT_SETTINGS.toolOutputMode} onReset={() => updateAgent({ toolOutputMode: DEFAULT_AGENT_SETTINGS.toolOutputMode })} />
        </div>
      </Field>

      <Field label="Параллельных суб-агентов" description="Сколько дочерних агентов можно держать активными одновременно">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <select
            className="settings-input"
            value={agentSettings.maxParallelSubAgents}
            onChange={e => updateAgent({ maxParallelSubAgents: Number(e.target.value) })}
          >
            {[1, 2, 3, 4, 6, 8].map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <ResetButton current={agentSettings.maxParallelSubAgents} defaultValue={DEFAULT_AGENT_SETTINGS.maxParallelSubAgents} onReset={() => updateAgent({ maxParallelSubAgents: DEFAULT_AGENT_SETTINGS.maxParallelSubAgents })} />
        </div>
      </Field>

      <Field label="Автосохранение рабочей памяти" description="Через сколько шагов агент обновляет working memory во время длинной сессии">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <select
            className="settings-input"
            value={agentSettings.autoMemoryInterval}
            onChange={e => updateAgent({ autoMemoryInterval: Number(e.target.value) })}
          >
            {[0, 3, 5, 8, 12].map(n => (
              <option key={n} value={n}>{n === 0 ? 'выкл' : `каждые ${n} шагов`}</option>
            ))}
          </select>
          <ResetButton current={agentSettings.autoMemoryInterval} defaultValue={DEFAULT_AGENT_SETTINGS.autoMemoryInterval} onReset={() => updateAgent({ autoMemoryInterval: DEFAULT_AGENT_SETTINGS.autoMemoryInterval })} />
        </div>
      </Field>

      <Field label="Повтор одного и того же tool-call" description="После этого количества одинаковых вызовов агент получает защиту от зацикливания">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <select
            className="settings-input"
            value={agentSettings.maxRepeatedToolCalls}
            onChange={e => updateAgent({ maxRepeatedToolCalls: Number(e.target.value) })}
          >
            {[2, 3, 4, 5].map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <ResetButton current={agentSettings.maxRepeatedToolCalls} defaultValue={DEFAULT_AGENT_SETTINGS.maxRepeatedToolCalls} onReset={() => updateAgent({ maxRepeatedToolCalls: DEFAULT_AGENT_SETTINGS.maxRepeatedToolCalls })} />
        </div>
      </Field>

      <Field label="Повтор одной и той же ошибки" description="Если инструмент падает одинаково несколько раз подряд, агенту запрещается тупо повторять вызов">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <select
            className="settings-input"
            value={agentSettings.maxRepeatedErrors}
            onChange={e => updateAgent({ maxRepeatedErrors: Number(e.target.value) })}
          >
            {[2, 3, 4].map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <ResetButton current={agentSettings.maxRepeatedErrors} defaultValue={DEFAULT_AGENT_SETTINGS.maxRepeatedErrors} onReset={() => updateAgent({ maxRepeatedErrors: DEFAULT_AGENT_SETTINGS.maxRepeatedErrors })} />
        </div>
      </Field>

      <Field label="Подтверждение опасных действий" description="Удаление файлов, системные команды">
        <Toggle value={!!perms['confirmDangerous']} onChange={v => onSet('agentPermissions', { ...perms, confirmDangerous: v })} />
      </Field>

      <Field label="Запрещённые папки" description="Через запятую — агент не трогает эти пути">
        <input
          className="settings-input"
          value={((perms['forbiddenPaths'] as string[]) || []).join(', ')}
          onChange={e => onSet('agentPermissions', { ...perms, forbiddenPaths: e.target.value.split(',').map(s => s.trim()) })}
          placeholder="C:\Windows, C:\..."
        />
      </Field>
    </>
  )
}

function IntegrationsSection({ settings, onSet }: { settings: Record<string, unknown>; onSet: (k: string, v: unknown) => void }) {
  const integrations = (settings['integrations'] as Record<string, Record<string, string>>) || {}
  return (
    <>
      <SectionTitle>Интеграции</SectionTitle>
      <Field label="Tavily API ключ" description="Для поиска в интернете">
        <input className="settings-input" type="password"
          value={integrations['tavily']?.key || ''}
          onChange={e => onSet('integrations', { ...integrations, tavily: { ...integrations['tavily'], key: e.target.value } })}
          placeholder="tvly-..."
        />
      </Field>
      <Field label="Telegram Bot Token">
        <input className="settings-input" type="password"
          value={integrations['telegram']?.token || ''}
          onChange={e => onSet('integrations', { ...integrations, telegram: { ...integrations['telegram'], token: e.target.value } })}
          placeholder="123456:ABC..."
        />
      </Field>
      <Field label="GitHub Token">
        <input className="settings-input" type="password"
          value={integrations['github']?.token || ''}
          onChange={e => onSet('integrations', { ...integrations, github: { ...integrations['github'], token: e.target.value } })}
          placeholder="ghp_..."
        />
      </Field>
      <Field label="Spotify Client ID">
        <input className="settings-input"
          value={integrations['spotify']?.clientId || ''}
          onChange={e => onSet('integrations', { ...integrations, spotify: { ...integrations['spotify'], clientId: e.target.value } })}
        />
      </Field>
    </>
  )
}

function DataSection({ settings, onSet, toast }: {
  settings: Record<string, unknown>
  onSet: (k: string, v: unknown) => void
  toast: (msg: string, type?: string) => void
}) {
  return (
    <>
      <SectionTitle>Данные и Память</SectionTitle>
      <Field label="Автобэкап" description="Ежедневная копия базы данных">
        <Toggle value={!!settings['backupEnabled']} onChange={v => onSet('backupEnabled', v)} />
      </Field>
      <Field label="Экспорт истории">
        <div style={{ display: 'flex', gap: 8 }}>
          {['JSON', 'Markdown', 'TXT'].map(fmt => (
            <motion.button key={fmt} className="settings-btn" whileTap={{ scale: 0.95 }}
              onClick={() => toast(`Экспорт ${fmt} — будет готово в стадии 09`, 'info')}>
              {fmt}
            </motion.button>
          ))}
        </div>
      </Field>
      <Field label="Очистить историю чатов">
        <motion.button className="settings-btn settings-btn--danger" whileTap={{ scale: 0.95 }}
          onClick={() => toast('Очистка истории — будет в стадии 09', 'info')}>
          Очистить
        </motion.button>
      </Field>
      <Field label="Очистить память Syntee">
        <motion.button className="settings-btn settings-btn--danger" whileTap={{ scale: 0.95 }}
          onClick={() => toast('Очистка памяти — будет в стадии 07', 'info')}>
          Сбросить память
        </motion.button>
      </Field>
    </>
  )
}
