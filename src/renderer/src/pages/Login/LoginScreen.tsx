import { useEffect, useState } from 'react'
import AppIcon from '../../components/ui/AppIcon/AppIcon'
import { useAuthStore } from '../../store/auth.store'
import './LoginScreen.css'

interface LoginScreenProps {
  /** Вызывается когда юзер выбрал гостевой режим. */
  onContinueAsGuest?: () => void
}

/**
 * Экран входа через Syntee-Gateway.
 *
 * Показывается при первом запуске (вместо OnboardingPage) или когда юзер
 * вышел из аккаунта. Кнопка «Войти» открывает браузер на consent-странице
 * gateway; после разрешения сайт редиректит на synteehelper://auth/callback
 * и main-процесс обменивает код на JWT, после чего шлёт событие logged-in.
 *
 * Гостевой режим даёт доступ ко всему, кроме моделей gateway/профиля/биллинга.
 */
export default function LoginScreen({ onContinueAsGuest }: LoginScreenProps) {
  const [waiting, setWaiting] = useState(false)
  const { load, error, clearError } = useAuthStore()

  // Подписка на успешный вход (deep-link callback отработал в main).
  useEffect(() => {
    const off = window.syntee.auth.onLoggedIn(() => {
      setWaiting(false)
      load()
    })
    return () => { off() }
  }, [load])

  // Фолбэк: polling токенов каждые 2с. Если deep-link callback отработал
  // в main (токены сохранены), но auth:logged-in event не дошёл до renderer
  // (например, second-instance event не сработал на Windows), мы всё равно
  // обнаружим токены и продолжим вход.
  useEffect(() => {
    if (!waiting) return
    const interval = setInterval(async () => {
      try {
        const isLoggedIn = await window.syntee.auth.isLoggedIn()
        if (isLoggedIn) {
          setWaiting(false)
          load()
        }
      } catch { /* ignore */ }
    }, 2000)
    return () => clearInterval(interval)
  }, [waiting, load])

  // Подписка на ошибку обмена кода.
  useEffect(() => {
    const off = window.syntee.auth.onLoginError((err) => {
      setWaiting(false)
      useAuthStore.setState({ error: err.message })
    })
    return () => { off() }
  }, [])

  const handleLogin = async () => {
    clearError()
    setWaiting(true)
    try {
      await window.syntee.auth.login()
    } catch (err) {
      setWaiting(false)
      useAuthStore.setState({ error: err instanceof Error ? err.message : 'Не удалось открыть браузер' })
    }
  }

  return (
    <div className="login-screen">
      <div className="login-screen__bg" />
      <div className="login-screen__content">
        <div className="login-screen__logo">
          <svg width="56" height="56" viewBox="0 0 22 22" fill="none">
            <polygon points="11,1 21,7 21,15 11,21 1,15 1,7"
              fill="none" stroke="var(--accent)" strokeWidth="1.2" opacity="0.9"/>
            <polygon points="11,4 18,8 18,14 11,18 4,14 4,8"
              fill="var(--accent)" opacity="0.18"/>
            <line x1="11" y1="1" x2="11" y2="21" stroke="var(--accent)" strokeWidth="0.6" opacity="0.4"/>
            <line x1="1" y1="7" x2="21" y2="15" stroke="var(--accent)" strokeWidth="0.6" opacity="0.4"/>
            <line x1="21" y1="7" x2="1" y2="15" stroke="var(--accent)" strokeWidth="0.6" opacity="0.4"/>
          </svg>
        </div>

        <h1 className="login-screen__title">Syntee Helper</h1>
        <p className="login-screen__subtitle">
          Войдите через Syntee-Gateway, чтобы получить доступ к моделям, балансу и профилю
        </p>

        {error && (
          <div className="login-screen__error">
            <AppIcon name="alertCircle" size="sm" />
            <span>{error}</span>
          </div>
        )}

        <button
          type="button"
          className="login-screen__btn login-screen__btn--primary"
          onClick={handleLogin}
          disabled={waiting}
        >
          {waiting ? (
            <>
              <AppIcon name="loader" size="sm" animation="spin" />
              <span>Ожидание авторизации в браузере…</span>
            </>
          ) : (
            <>
              <AppIcon name="globe" size="sm" />
              <span>Войти через Syntee</span>
            </>
          )}
        </button>

        <button
          type="button"
          className="login-screen__btn login-screen__btn--ghost"
          onClick={onContinueAsGuest}
          disabled={waiting}
        >
          <AppIcon name="user" size="sm" />
          <span>Продолжить как гость</span>
        </button>

        <p className="login-screen__hint">
          Гостевой режим: свои провайдеры и локальные модели, без моделей gateway и биллинга.
        </p>
      </div>
    </div>
  )
}
