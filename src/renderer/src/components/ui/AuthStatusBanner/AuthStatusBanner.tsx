import { useEffect, useState } from 'react'
import AppIcon from '../AppIcon/AppIcon'
import { useAuthStore } from '../../../store/auth.store'
import './AuthStatusBanner.css'

/**
 * Показывает, почему профиль временно недоступен, но не маскирует это под logout.
 * Повторная проверка запускается автоматически при восстановлении сети и вручную.
 */
export default function AuthStatusBanner() {
  const availability = useAuthStore(s => s.availability)
  const loading = useAuthStore(s => s.loading)
  const load = useAuthStore(s => s.load)
  const [online, setOnline] = useState(() => navigator.onLine)

  useEffect(() => {
    const handleOnline = () => {
      setOnline(true)
      void load()
    }
    const handleOffline = () => {
      setOnline(false)
      useAuthStore.getState().markUnavailable()
    }
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [load])

  if (availability !== 'unavailable') return null

  return (
    <div className="auth-status-banner" role="status">
      <AppIcon name="cloudFog" tone="warning" size="sm" />
      <span>
        {online
          ? 'Сервис авторизации временно недоступен. Сессия сохранена — повторяем подключение.'
          : 'Нет соединения с интернетом. Сессия сохранена, приложение продолжает работать локально.'}
      </span>
      <button
        type="button"
        className="auth-status-banner__retry"
        onClick={() => void load()}
        disabled={loading}
      >
        {loading ? 'Проверка…' : 'Повторить'}
      </button>
    </div>
  )
}
