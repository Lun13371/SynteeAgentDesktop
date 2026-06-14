import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useSettingsStore } from '../../store/settings.store'
import { useUIStore } from '../../store/ui.store'
import { useToast } from '../../components/ui/Toast/Toast'
import AppIcon, { type IconName } from '../../components/ui/AppIcon/AppIcon'
import IconButton from '../../components/ui/IconButton/IconButton'
import AISettingsTab from '../../components/settings/AISettingsTab/AISettingsTab'
import ContextSettingsTab from '../../components/settings/ContextSettingsTab/ContextSettingsTab'
import ApprovalModeSelector from '../../components/ui/ApprovalModeSelector/ApprovalModeSelector'
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
  const { setTheme, setAccentColor, setBgStyle } = useUIStore()
  const { add: toast } = useToast()
  const [apiKeyVisible, setApiKeyVisible] = useState(false)
  const [testingApi, setTestingApi] = useState(false)

  useEffect(() => { load() }, [])

  const handleSet = async (key: string, value: unknown) => {
    await set(key, value)
    if (key === 'theme') setTheme(value as any)
    if (key === 'accentColor') setAccentColor(value as string)
    if (key === 'bgStyle') setBgStyle(value as string)
  }

  const testApiKey = async () => {
    setTestingApi(true)
    try {
      const key = settings['apiKey'] as string
      const endpoint = settings['apiEndpoint'] as string
      const res = await fetch(`${endpoint}/models`, {
        headers: { Authorization: `Bearer ${key}` }
      })
      if (res.ok) {
        toast('API ключ работает', 'success')
      } else {
        toast('Ошибка: ' + res.status, 'error')
      }
    } catch (e) {
      toast('Не удалось подключиться', 'error')
    }
    setTestingApi(false)
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

function Field({ label, description, children }: {
  label: string; description?: string; children: React.ReactNode
}) {
  return (
    <div className="settings-field">
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

function AISection({ settings, onSet, apiKeyVisible, setApiKeyVisible, testingApi, onTestApi }: {
  settings: Record<string, unknown>
  onSet: (k: string, v: unknown) => void
  apiKeyVisible: boolean
  setApiKeyVisible: (v: boolean) => void
  testingApi: boolean
  onTestApi: () => void
}) {
  const MODELS = [
    'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5',
    'gpt-5', 'gpt-5.1', 'gpt-5.2', 'gpt-5-mini',
    'deepseek-v3', 'deepseek-v4-flash',
    'gemini-3.5-flash', 'gemini-3-flash',
    'grok-4.20', 'grok-4-1-fast', 'grok-4.3',
    'llama-3.3-70b', 'llama3.1-8b', 'mistral-small-3.1',
  ]

  return (
    <>
      <SectionTitle>ИИ и Модели</SectionTitle>
      <Field label="API Endpoint">
        <input
          className="settings-input"
          value={(settings['apiEndpoint'] as string) || ''}
          onChange={e => onSet('apiEndpoint', e.target.value)}
          placeholder="https://api.onlysq.ru/ai/openai"
        />
      </Field>
      <Field label="API Ключ">
        <div className="settings-api-key-wrap">
          <input
            className="settings-input"
            type={apiKeyVisible ? 'text' : 'password'}
            value={(settings['apiKey'] as string) || ''}
            onChange={e => onSet('apiKey', e.target.value)}
            placeholder="sk-..."
          />
          <IconButton
            icon={apiKeyVisible ? 'eyeOff' : 'eye'}
            label={apiKeyVisible ? 'Скрыть ключ' : 'Показать ключ'}
            onClick={() => setApiKeyVisible(!apiKeyVisible)}
            className="settings-icon-btn"
          />
          <motion.button
            className="settings-btn"
            onClick={onTestApi}
            disabled={testingApi}
            whileTap={{ scale: 0.95 }}
          >
            {testingApi ? '...' : 'Тест'}
          </motion.button>
        </div>
      </Field>
      <Field label="Основная модель (чат)">
        <select className="settings-select" value={(settings['mainModel'] as string) || 'claude-sonnet-4-6'} onChange={e => onSet('mainModel', e.target.value)}>
          {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>
      <Field label="Быстрая модель (агент)">
        <select className="settings-select" value={(settings['fastModel'] as string) || 'claude-haiku-4-5'} onChange={e => onSet('fastModel', e.target.value)}>
          {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>
      <Field label="Модель для зрения">
        <select className="settings-select" value={(settings['visionModel'] as string) || 'gemini-3.5-flash'} onChange={e => onSet('visionModel', e.target.value)}>
          {['gemini-3.5-flash', 'gemini-3-flash', 'gpt-5.4', 'gpt-5.2', 'claude-sonnet-4-6', 'zai-glm-4.6'].map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>
      <Field label="Температура" description="0 — точно, 1 — творчески">
        <input
          className="settings-input settings-input--sm"
          type="number" min="0" max="1" step="0.1"
          value={(settings['temperature'] as number) ?? 0.7}
          onChange={e => onSet('temperature', parseFloat(e.target.value))}
        />
      </Field>
    </>
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
const THEMES = [
  { id: 'dark',     label: 'Тёмная',  color: '#1a1a1a' },
  { id: 'light',    label: 'Светлая', color: '#faf8f5' },
  { id: 'midnight', label: 'Полночь', color: '#0a0e1a' },
  { id: 'forest',   label: 'Лес',     color: '#0d1a0f' },
]
const FONTS = ['Inter', 'Plus Jakarta Sans', 'Geist', 'DM Sans']

function AppearanceSection({ settings, onSet }: { settings: Record<string, unknown>; onSet: (k: string, v: unknown) => void }) {
  return (
    <>
      <SectionTitle>Внешний вид</SectionTitle>
      <Field label="Тема">
        <div className="settings-theme-grid">
          {THEMES.map(t => (
            <motion.button
              key={t.id}
              className={`settings-theme-btn ${settings['theme'] === t.id ? 'settings-theme-btn--active' : ''}`}
              style={{ background: t.color }}
              onClick={() => onSet('theme', t.id)}
              whileTap={{ scale: 0.93 }}
            >
              {t.label}
            </motion.button>
          ))}
        </div>
      </Field>
      <Field label="Шрифт">
        <select className="settings-select" value={(settings['fontFamily'] as string) || 'Inter'} onChange={e => onSet('fontFamily', e.target.value)}>
          {FONTS.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
      </Field>
      <Field label="Стиль фона" description="Анимация на заднем плане">
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
  const [agentSettings, setAgentSettings] = useState<{ approvalMode: string; maxSteps: number; enableTools: boolean; toolOutputMode: string; enableThinking: boolean }>({
    approvalMode: 'ask', maxSteps: 8, enableTools: true, toolOutputMode: 'normal', enableThinking: false
  })

  useEffect(() => {
    window.syntee.agent.getSettings().then((s: { approvalMode: string; maxSteps: number; enableTools: boolean; toolOutputMode: string; enableThinking: boolean }) => {
      setAgentSettings(s)
    }).catch(() => {})
  }, [])

  const updateAgent = (patch: Partial<typeof agentSettings>) => {
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

      <Field label="Инструменты в чате" description="Разрешить агенту использовать системные инструменты в обычном чате">
        <Toggle value={agentSettings.enableTools} onChange={v => updateAgent({ enableTools: v })} />
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

      <Field label="Максимум шагов агента" description="Сколько шагов может сделать агент за один запрос">
        <select
          className="settings-input"
          value={agentSettings.maxSteps}
          onChange={e => updateAgent({ maxSteps: Number(e.target.value) })}
        >
          {[4, 8, 12, 16, 24, 32, 48, 64, 96, 128].map(n => (
            <option key={n} value={n}>{n} шагов</option>
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
