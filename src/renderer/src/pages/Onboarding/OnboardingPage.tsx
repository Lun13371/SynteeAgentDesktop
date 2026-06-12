import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../../components/ui/AppIcon/AppIcon'
import './OnboardingPage.css'

interface OnboardingProps {
  onDone: () => void
}

const THEMES = [
  { id: 'dark', label: 'Тёмная', bg: '#1a1a1a', accent: '#4d9fff' },
  { id: 'light', label: 'Светлая', bg: '#f5f5f0', accent: '#0066cc' },
  { id: 'midnight', label: 'Полночь', bg: '#0d0d14', accent: '#7c4dff' },
  { id: 'forest', label: 'Лес', bg: '#0d1a12', accent: '#00c875' },
]

const MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet', desc: 'Умный, быстрый, лучший для работы' },
  { id: 'gpt-5', label: 'GPT-5', desc: 'Мощный, хорош для кода и анализа' },
  { id: 'gemini-3-flash', label: 'Gemini Flash', desc: 'Быстрый и экономичный' },
  { id: 'deepseek-v3', label: 'DeepSeek V3', desc: 'Отличный для технических задач' },
]

export default function OnboardingPage({ onDone }: OnboardingProps) {
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [theme, setTheme] = useState('dark')
  const [model, setModel] = useState('claude-sonnet-4-6')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<'ok' | 'error' | null>(null)

  const STEPS = [
    { title: 'Добро пожаловать', subtitle: 'Давай познакомимся' },
    { title: 'API ключ', subtitle: 'Для работы AI' },
    { title: 'Модель', subtitle: 'Выбери основную модель' },
    { title: 'Тема', subtitle: 'Как тебе удобнее' },
    { title: 'Готово!', subtitle: 'Syntee настроен' },
  ]

  const testApi = async () => {
    if (!apiKey.trim()) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch('https://api.onlysq.ru/ai/openai/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 5,
        }),
      })
      setTestResult(res.ok ? 'ok' : 'error')
    } catch {
      setTestResult('error')
    }
    setTesting(false)
  }

  const handleFinish = async () => {
    await (window.syntee as any).settings?.set('userName', name.trim())
    await (window.syntee as any).settings?.set('apiKey', apiKey.trim())
    await (window.syntee as any).settings?.set('theme', theme)
    await (window.syntee as any).settings?.set('mainModel', model)
    await (window.syntee as any).settings?.set('firstRunComplete', true)
    await (window.syntee as any).settings?.set('firstRunDate', Date.now())
    await (window.syntee as any).chat?.reloadClient?.()
    document.documentElement.setAttribute('data-theme', theme)
    onDone()
  }

  const canNext = () => {
    if (step === 0) return name.trim().length > 0
    if (step === 1) return apiKey.trim().length > 0
    return true
  }

  return (
    <div className="onboarding-root" data-theme={theme}>
      {/* Фон */}
      <div className="onboarding-bg">
        {[...Array(6)].map((_, i) => (
          <div key={i} className={`onboarding-orb onboarding-orb--${i}`} />
        ))}
      </div>

      {/* Карточка */}
      <motion.div
        className="onboarding-card glass"
        initial={{ opacity: 0, scale: 0.92, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 260, damping: 24 }}
      >
        {/* Прогресс */}
        <div className="onboarding-progress">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`onboarding-dot ${i === step ? 'active' : i < step ? 'done' : ''}`}
            />
          ))}
        </div>

        {/* Шаги */}
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            className="onboarding-step"
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -30 }}
            transition={{ duration: 0.22 }}
          >
            {/* Шаг 0 — Имя */}
            {step === 0 && (
              <div className="onboarding-content">
                <div className="onboarding-icon">
                  <AppIcon name="brain" size="xl" tone="accent" />
                </div>
                <h2>{STEPS[0].title}</h2>
                <p>{STEPS[0].subtitle}</p>
                <div className="onboarding-field">
                  <label>Как тебя зовут?</label>
                  <input
                    className="onboarding-input"
                    placeholder="Введи своё имя..."
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && canNext() && setStep(1)}
                    autoFocus
                  />
                </div>
              </div>
            )}

            {/* Шаг 1 — API ключ */}
            {step === 1 && (
              <div className="onboarding-content">
                <div className="onboarding-icon">
                  <AppIcon name="lock" size="xl" tone="accent" />
                </div>
                <h2>{STEPS[1].title}</h2>
                <p>Введи ключ от <strong>api.onlysq.ru</strong></p>
                <div className="onboarding-field">
                  <label>API ключ</label>
                  <input
                    className="onboarding-input onboarding-input--mono"
                    placeholder="sk-..."
                    type="password"
                    value={apiKey}
                    onChange={e => { setApiKey(e.target.value); setTestResult(null) }}
                  />
                </div>
                <button
                  className={`onboarding-test-btn ${testResult === 'ok' ? 'ok' : testResult === 'error' ? 'err' : ''}`}
                  onClick={testApi}
                  disabled={testing || !apiKey.trim()}
                >
                  {testing && <AppIcon name="loader" size="sm" animation="spin" tone="muted" />}
                  <span>{testing ? 'Проверяю...' : testResult === 'ok' ? 'Работает!' : testResult === 'error' ? 'Ошибка' : 'Проверить'}</span>
                  {testResult === 'ok' && !testing && <AppIcon name="check" size="sm" tone="success" />}
                  {testResult === 'error' && !testing && <AppIcon name="alertCircle" size="sm" tone="danger" />}
                  {!testResult && !testing && <AppIcon name="search" size="sm" tone="muted" />}
                </button>
              </div>
            )}

            {/* Шаг 2 — Модель */}
            {step === 2 && (
              <div className="onboarding-content">
                <div className="onboarding-icon">
                  <AppIcon name="bot" size="xl" tone="accent" />
                </div>
                <h2>{STEPS[2].title}</h2>
                <p>Можно изменить в настройках</p>
                <div className="onboarding-models">
                  {MODELS.map(m => (
                    <button
                      key={m.id}
                      className={`onboarding-model-btn ${model === m.id ? 'active' : ''}`}
                      onClick={() => setModel(m.id)}
                    >
                      <span className="model-label">{m.label}</span>
                      <span className="model-desc">{m.desc}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Шаг 3 — Тема */}
            {step === 3 && (
              <div className="onboarding-content">
                <div className="onboarding-icon">
                  <AppIcon name="palette" size="xl" tone="accent" />
                </div>
                <h2>{STEPS[3].title}</h2>
                <p>Можно изменить в настройках</p>
                <div className="onboarding-themes">
                  {THEMES.map(t => (
                    <button
                      key={t.id}
                      className={`onboarding-theme-btn ${theme === t.id ? 'active' : ''}`}
                      onClick={() => { setTheme(t.id); document.documentElement.setAttribute('data-theme', t.id) }}
                      style={{ '--theme-bg': t.bg, '--theme-accent': t.accent } as React.CSSProperties}
                    >
                      <div className="theme-preview" style={{ background: t.bg }}>
                        <div className="theme-preview-bar" style={{ background: t.accent }} />
                        <div className="theme-preview-lines">
                          <div style={{ background: t.accent + '60' }} />
                          <div style={{ background: t.accent + '40' }} />
                        </div>
                      </div>
                      <span>{t.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Шаг 4 — Готово */}
            {step === 4 && (
              <div className="onboarding-content onboarding-content--center">
                <motion.div
                  className="onboarding-icon onboarding-icon--big"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: 'spring', stiffness: 300, damping: 18, delay: 0.1 }}
                >
                  <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
                    <polygon points="32,4 60,18 60,46 32,60 4,46 4,18"
                      fill="none" stroke="var(--accent)" strokeWidth="2" opacity="0.8"/>
                    <polygon points="32,14 50,24 50,40 32,50 14,40 14,24"
                      fill="var(--accent)" opacity="0.08"/>
                    <polygon points="32,24 42,30 42,38 32,44 22,38 22,30"
                      fill="var(--accent)" opacity="0.2"/>
                  </svg>
                </motion.div>
                <h2>Привет, {name}!</h2>
                <p>Syntee готов к работе.<br/>Модель: <strong>{MODELS.find(m => m.id === model)?.label}</strong></p>
                <div className="onboarding-summary">
                  <div className="summary-item">
                    <AppIcon name="user" size="sm" tone="muted" />
                    <span>{name}</span>
                  </div>
                  <div className="summary-item">
                    <AppIcon name="lock" size="sm" tone="muted" />
                    <span>API ключ установлен</span>
                  </div>
                  <div className="summary-item">
                    <AppIcon name="bot" size="sm" tone="muted" />
                    <span>{MODELS.find(m => m.id === model)?.label}</span>
                  </div>
                  <div className="summary-item">
                    <AppIcon name="palette" size="sm" tone="muted" />
                    <span>{THEMES.find(t => t.id === theme)?.label} тема</span>
                  </div>
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>

        {/* Кнопки навигации */}
        <div className="onboarding-nav">
          {step > 0 && step < 4 && (
            <button className="onboarding-back-btn" onClick={() => setStep(p => p - 1)}>
              ← Назад
            </button>
          )}
          {step < 4 ? (
            <motion.button
              className="onboarding-next-btn"
              onClick={() => setStep(p => p + 1)}
              disabled={!canNext()}
              whileTap={{ scale: 0.95 }}
            >
              {step === 3 ? 'Готово →' : 'Далее →'}
            </motion.button>
          ) : (
            <motion.button
              className="onboarding-finish-btn"
              onClick={handleFinish}
              whileTap={{ scale: 0.95 }}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
            >
              <AppIcon name="sparkles" size="sm" tone="default" />
              <span>Начать!</span>
            </motion.button>
          )}
        </div>
      </motion.div>
    </div>
  )
}
