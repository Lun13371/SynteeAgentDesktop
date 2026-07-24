import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useSettingsStore } from '../../store/settings.store'
import { useUIStore } from '../../store/ui.store'
import { useToast } from '../../components/ui/Toast/Toast'
import AppIcon, { type IconName } from '../../components/ui/AppIcon/AppIcon'
import AISettingsTab from '../../components/settings/AISettingsTab/AISettingsTab'
import ContextSettingsTab from '../../components/settings/ContextSettingsTab/ContextSettingsTab'
import ApprovalModeSelector from '../../components/ui/ApprovalModeSelector/ApprovalModeSelector'
import { MSG_ANIM_VARIANTS } from '../../components/ui/MessageBubble/MessageBubble'
import { applyFontToDOM, applyAccentToDOM } from '../../App'
import type { AgentSettings as SharedAgentSettings } from '../../../../shared/types'
import './SettingsPage.css'

type Section =
  | 'general' | 'ai' | 'voice' | 'hotkeys'
  | 'agent' | 'data' | 'appearance' | 'integrations' | 'context'

const SECTIONS: Array<{ id: Section; label: string; icon: IconName }> = [
  { id: 'general',      label: 'Общие',          icon: 'settings' },
  { id: 'ai',           label: 'ИИ и Модели',    icon: 'brain' },
  { id: 'context',      label: 'Контекст',       icon: 'layers' },
  { id: 'appearance',   label: 'Внешний вид',    icon: 'palette' },
  { id: 'voice',        label: 'Голос',          icon: 'mic' },
  { id: 'hotkeys',      label: 'Горячие клавиши',icon: 'shield' },
  { id: 'agent',        label: 'Агент',          icon: 'bot' },
  { id: 'integrations', label: 'Интеграции',     icon: 'link' },
  { id: 'data',         label: 'Данные',         icon: 'database' },
]

export default function SettingsPage() {
  const [section, setSection] = useState<Section>('general')
  const { settings, load, set } = useSettingsStore()
  const { setTheme, setAccentColor, setBgStyle, setMsgAnim, setAnimatedBackground,
    setAvatarStyle, setShowTime, setUserMarkdown, setUiSounds, setSendEffect } = useUIStore()
  const { add: toast } = useToast()

  useEffect(() => { load() }, [])

  const handleSet = async (key: string, value: unknown) => {
    await set(key, value)
    if (key === 'theme') setTheme(value as any)
    if (key === 'accentColor') setAccentColor(value as string)
    if (key === 'bgStyle') setBgStyle(value as string)
    if (key === 'msgAnim') setMsgAnim(value as string)
    if (key === 'avatarStyle') setAvatarStyle(value as any)
    if (key === 'showTime') setShowTime(value as any)
    if (key === 'userMarkdown') setUserMarkdown(value as boolean)
    if (key === 'uiSounds') setUiSounds(value as boolean)
    if (key === 'sendEffect') setSendEffect(value as boolean)
    // Применяем шрифт мгновенно к CSS-переменной — раньше select
    // сохранял значение, но UI не менялся до перезапуска.
    if (key === 'fontFamily') applyFontToDOM(value as string)
    // Кастомный accent — применяется поверх темы.
    if (key === 'accentColor') applyAccentToDOM(value as string)
  }

  return (
    <div className="settings-root">
      {/* Сайдбар разделов */}
      <nav className="settings-nav glass">
        <div className="settings-nav-title">Настройки</div>
        {SECTIONS.map(s => (
          <motion.button
            key={s.id}
            className={`settings-nav-item no-drag ${section === s.id ? 'settings-nav-item--active' : ''}`}
            onClick={() => setSection(s.id)}
            whileTap={{ scale: 0.97 }}
          >
            <AppIcon name={s.icon} size="sm" tone={section === s.id ? 'accent' : 'muted'} />
            {s.label}
          </motion.button>
        ))}
      </nav>

      {/* Контент */}
      <div className="settings-content">
        <motion.div
          key={section}
          className={`settings-section ${section === 'ai' ? 'settings-section--wide' : ''}`}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15 }}
        >
            {section === 'general' && (
              <GeneralSection settings={settings} onSet={handleSet} />
            )}
            {section === 'ai' && (
              <AISettingsTab />
            )}
            {section === 'context' && (
              <ContextSettingsTab />
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

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <motion.button
      className={`settings-toggle ${value ? 'settings-toggle--on' : ''}`}
      onClick={() => onChange(!value)}
      whileTap={{ scale: 0.93 }}
    >
      <motion.span
        className="settings-toggle-thumb"
        animate={{ x: value ? 20 : 2 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      />
    </motion.button>
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
  { id: 'particles', label: 'Частицы',   icon: '✦', desc: 'Точки с линиями' },
  { id: 'matrix',    label: 'Матрица',   icon: '⌨', desc: 'Дождь символов' },
  { id: 'waves',     label: 'Волны',     icon: '〜', desc: 'Плавные волны' },
  { id: 'aurora',    label: 'Аврора',    icon: '◈', desc: 'Северное сияние' },
  { id: 'fireflies', label: 'Светлячки', icon: '✺', desc: 'Мерцающие огни' },
  { id: 'none',      label: 'Выкл',      icon: '✕', desc: 'Без анимации' },
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
  return (
    <>
      <SectionTitle>Внешний вид</SectionTitle>
      <Field label="Тема" description="Выберите цветовую палитру" block>
        <div className="settings-theme-cards">
          {THEMES.map(t => {
            const isActive = settings['theme'] === t.id
            return (
              <motion.button
                key={t.id}
                type="button"
                className={`settings-theme-card${isActive ? ' settings-theme-card--active' : ''}`}
                onClick={() => onSet('theme', t.id)}
                whileTap={{ scale: 0.96 }}
                whileHover={{ y: -2 }}
                transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                title={t.label}
              >
                {/* Мини-превью интерфейса с реальными цветами темы */}
                <div
                  className="settings-theme-card__preview"
                  style={{ background: t.colors.bg, borderColor: t.colors.accent + '22' }}
                >
                  {/* Имитация sidebar */}
                  <div
                    className="settings-theme-card__sidebar"
                    style={{ background: t.colors.surface }}
                  />
                  {/* Имитация message bubbles */}
                  <div className="settings-theme-card__content">
                    <div
                      className="settings-theme-card__bubble settings-theme-card__bubble--left"
                      style={{ background: t.colors.surface, borderColor: t.colors.text + '18' }}
                    />
                    <div
                      className="settings-theme-card__bubble settings-theme-card__bubble--right"
                      style={{ background: t.colors.accent }}
                    />
                  </div>
                  {/* Accent dot */}
                  <div
                    className="settings-theme-card__dot"
                    style={{ background: t.colors.accent, boxShadow: `0 0 8px ${t.colors.accent}66` }}
                  />
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
        </div>
      </Field>
      <Field label="Цвет акцента" description="Дополнительный акцент поверх темы">
        <div className="settings-accent-picker">
          {ACCENT_PRESETS.map(c => {
            const isActive = (settings['accentColor'] as string) === c
            return (
              <motion.button
                key={c}
                type="button"
                className={`settings-accent-swatch${isActive ? ' settings-accent-swatch--active' : ''}`}
                style={{ background: c }}
                onClick={() => onSet('accentColor', c)}
                whileTap={{ scale: 0.85 }}
                whileHover={{ scale: 1.15 }}
                transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                title={c}
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
        </div>
      </Field>
      <Field label="Шрифт">
        <select className="settings-select" value={(settings['fontFamily'] as string) || 'Inter'} onChange={e => onSet('fontFamily', e.target.value)}>
          {FONTS.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
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
      <Field label="Автосмена темы">
        <Toggle value={!!(settings['themeSchedule'] as any)?.enabled} onChange={v => onSet('themeSchedule', { ...((settings['themeSchedule'] as any) || {}), enabled: v })} />
      </Field>
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
  const [agentSettings, setAgentSettings] = useState<SharedAgentSettings>({
    approvalMode: 'ask',
    maxSteps: 32,
    toolOutputMode: 'normal',
    enableThinking: false,
    maxParallelSubAgents: 3,
    readFileCache: true,
    autoMemoryInterval: 5,
    maxRepeatedToolCalls: 3,
    maxRepeatedErrors: 2,
  })

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
        <ApprovalModeSelector
          value={agentSettings.approvalMode as import('../../../../../shared/types').ApprovalMode}
          onChange={mode => updateAgent({ approvalMode: mode })}
        />
      </Field>

      <Field label="Режим размышлений" description="AI показывает ход своих мыслей перед ответом — цепочка рассуждений видна в свёрнутом блоке">
        <Toggle value={agentSettings.enableThinking} onChange={v => updateAgent({ enableThinking: v })} />
      </Field>

      <Field label="Вывод инструментов" description="Как отображать цепочку действий агента в чате">
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
      </Field>

      <Field label="Параллельных суб-агентов" description="Сколько дочерних агентов можно держать активными одновременно">
        <select
          className="settings-input"
          value={agentSettings.maxParallelSubAgents}
          onChange={e => updateAgent({ maxParallelSubAgents: Number(e.target.value) })}
        >
          {[1, 2, 3, 4, 6, 8].map(n => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </Field>

      <Field label="Автосохранение рабочей памяти" description="Через сколько шагов агент обновляет working memory во время длинной сессии">
        <select
          className="settings-input"
          value={agentSettings.autoMemoryInterval}
          onChange={e => updateAgent({ autoMemoryInterval: Number(e.target.value) })}
        >
          {[0, 3, 5, 8, 12].map(n => (
            <option key={n} value={n}>{n === 0 ? 'выкл' : `каждые ${n} шагов`}</option>
          ))}
        </select>
      </Field>

      <Field label="Повтор одного и того же tool-call" description="После этого количества одинаковых вызовов агент получает защиту от зацикливания">
        <select
          className="settings-input"
          value={agentSettings.maxRepeatedToolCalls}
          onChange={e => updateAgent({ maxRepeatedToolCalls: Number(e.target.value) })}
        >
          {[2, 3, 4, 5].map(n => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </Field>

      <Field label="Повтор одной и той же ошибки" description="Если инструмент падает одинаково несколько раз подряд, агенту запрещается тупо повторять вызов">
        <select
          className="settings-input"
          value={agentSettings.maxRepeatedErrors}
          onChange={e => updateAgent({ maxRepeatedErrors: Number(e.target.value) })}
        >
          {[2, 3, 4].map(n => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
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
