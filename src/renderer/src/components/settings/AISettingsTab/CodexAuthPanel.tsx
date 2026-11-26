/**
 * Вход по ChatGPT-подписке (Codex) — панель внутри редактора провайдера.
 *
 * Два способа подключения:
 *  1. Браузерный OAuth (PKCE): открываем страницу OpenAI, ловим callback
 *     на 127.0.0.1:1455; если порт занят — пользователь вставляет redirect-URL.
 *  2. Импорт уже сохранённого логина из ~/.codex/auth.json.
 *
 * Токены хранятся в main-процессе (safeStorage), сюда приходит только статус.
 */
import { useCallback, useEffect, useState } from 'react'
import type { CodexAuthState } from '../../../../../shared/types'

type Props = {
  /** Вызывается после успешного входа/импорта — чтобы подтянуть модели. */
  onConnected?: () => void | Promise<void>
}

type LoginStart = { url: string; autoCapture: boolean; port: number; pending: boolean }

const PLAN_LABEL: Record<string, string> = {
  plus: 'ChatGPT Plus',
  pro: 'ChatGPT Pro',
  prolite: 'ChatGPT Pro Lite',
  team: 'ChatGPT Team',
  business: 'ChatGPT Business',
  enterprise: 'ChatGPT Enterprise',
  edu: 'ChatGPT Edu',
  free: 'ChatGPT Free',
  go: 'ChatGPT Go',
}

function planLabel(plan: string | null): string {
  if (!plan) return 'ChatGPT'
  return PLAN_LABEL[plan.toLowerCase()] ?? `ChatGPT (${plan})`
}

function expiryLabel(expiresAt: number | null): string {
  if (!expiresAt) return ''
  const minutes = Math.round((expiresAt - Date.now()) / 60000)
  if (minutes <= 0) return 'токен обновится при следующем запросе'
  if (minutes < 120) return `токен истекает через ${minutes} мин`
  return `токен истекает через ${Math.round(minutes / 60)} ч`
}

export default function CodexAuthPanel({ onConnected }: Props) {
  const [state, setState] = useState<CodexAuthState | null>(null)
  const [busy, setBusy] = useState<'' | 'login' | 'import' | 'logout' | 'refresh'>('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loginUrl, setLoginUrl] = useState('')
  const [manualUrl, setManualUrl] = useState('')
  const [modelsCount, setModelsCount] = useState<number | null>(null)

  const loadModels = useCallback(async () => {
    try {
      const result = (await window.syntee.codex.models()) as { ok: boolean; models?: unknown[] }
      setModelsCount(result?.ok ? (result.models?.length ?? 0) : null)
    } catch {
      setModelsCount(null)
    }
  }, [])

  const loadStatus = useCallback(async () => {
    try {
      const next = (await window.syntee.codex.status()) as CodexAuthState
      setState(next)
      if (next.connected) void loadModels()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось получить статус')
    }
  }, [loadModels])

  useEffect(() => {
    // Первичная загрузка откладывается на микротаск: setState в теле эффекта
    // даёт каскадный ре-рендер (react-hooks/set-state-in-effect).
    const initial = setTimeout(() => { void loadStatus() }, 0)
    const off = window.syntee.codex.onAuthChanged(() => {
      void loadStatus()
      void onConnected?.()
    })
    return () => {
      clearTimeout(initial)
      off()
    }
  }, [loadStatus, onConnected])

  const startLogin = async () => {
    setBusy('login')
    setError('')
    setNotice('')
    try {
      const result = (await window.syntee.codex.login()) as LoginStart
      setLoginUrl(result.url)
      setNotice(result.autoCapture
        ? 'Браузер открыт. Завершите вход — статус обновится автоматически.'
        : `Порт 127.0.0.1:${result.port} занят, поэтому автоматический перехват не работает. После входа браузер покажет страницу с ошибкой — скопируйте её адрес и вставьте ниже.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось начать вход')
    } finally {
      setBusy('')
    }
  }

  const submitManual = async () => {
    if (!manualUrl.trim()) return
    setBusy('login')
    setError('')
    setNotice('')
    try {
      const result = (await window.syntee.codex.loginManual(manualUrl.trim())) as { ok: boolean; error?: string; state?: CodexAuthState }
      if (!result.ok) {
        setError(result.error || 'Не удалось завершить вход')
      } else {
        setNotice('Готово — подписка подключена.')
        setLoginUrl('')
        setManualUrl('')
        if (result.state) setState(result.state)
        await onConnected?.()
        await loadModels()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось завершить вход')
    } finally {
      setBusy('')
    }
  }

  const importFromCli = async () => {
    setBusy('import')
    setError('')
    setNotice('')
    try {
      const result = (await window.syntee.codex.import()) as { ok: boolean; error?: string; state?: CodexAuthState }
      if (!result.ok) {
        setError(result.error || 'Импорт не удался')
      } else {
        setNotice('Логин Codex CLI импортирован.')
        if (result.state) setState(result.state)
        await onConnected?.()
        await loadModels()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Импорт не удался')
    } finally {
      setBusy('')
    }
  }

  const logout = async () => {
    setBusy('logout')
    setError('')
    setNotice('')
    try {
      const next = (await window.syntee.codex.logout()) as CodexAuthState
      setState(next)
      setModelsCount(null)
      setLoginUrl('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось отключить')
    } finally {
      setBusy('')
    }
  }

  const connected = !!state?.connected

  return (
    <div className="codex-auth-panel">
      <div className="codex-auth-head">
        <span className={`codex-auth-dot ${connected ? 'is-on' : 'is-off'}`} />
        <strong>
          {connected
            ? `${planLabel(state?.plan ?? null)}${state?.email ? ` · ${state.email}` : ''}`
            : 'ChatGPT не подключён'}
        </strong>
      </div>

      {connected && (
        <p className="provider-dialog-hint">
          {state?.source === 'import' ? 'Токены взяты из Codex CLI. ' : ''}
          {expiryLabel(state?.expiresAt ?? null)}
          {modelsCount !== null ? ` · доступно моделей: ${modelsCount}` : ''}
        </p>
      )}

      {!connected && (
        <p className="provider-dialog-hint">
          Работает с подпиской ChatGPT Plus/Pro: запросы идут за счёт квоты
          подписки, API-ключ не нужен.
        </p>
      )}

      <div className="provider-form-actions codex-auth-actions">
        {!connected && (
          <>
            <button className="provider-btn provider-btn--save" disabled={busy !== ''} onClick={startLogin}>
              {busy === 'login' ? 'Открываю браузер…' : 'Войти через ChatGPT'}
            </button>
            <button className="provider-btn" disabled={busy !== ''} onClick={importFromCli}>
              {busy === 'import' ? 'Импортирую…' : 'Импортировать из Codex CLI'}
            </button>
          </>
        )}
        {connected && (
          <button className="provider-btn" disabled={busy !== ''} onClick={logout}>
            {busy === 'logout' ? 'Отключаю…' : 'Отключить'}
          </button>
        )}
      </div>

      {loginUrl && !manualUrl && (
        <details className="codex-auth-manual">
          <summary>Ссылка для входа (если браузер не открылся)</summary>
          <p className="codex-auth-url">{loginUrl}</p>
        </details>
      )}

      {loginUrl && (
        <label className="provider-form-label codex-auth-manual-input">
          Redirect-URL из браузера (после входа)
          <input
            className="provider-form-input"
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
            placeholder="http://127.0.0.1:1455/auth/callback?code=…&state=…"
          />
          <span className="codex-auth-manual-actions">
            <button className="provider-btn" disabled={busy !== '' || !manualUrl.trim()} onClick={submitManual}>
              Завершить вход
            </button>
            <button
              className="provider-btn"
              disabled={busy !== ''}
              onClick={() => { setLoginUrl(''); setManualUrl(''); void window.syntee.codex.cancelLogin() }}
            >
              Отмена
            </button>
          </span>
        </label>
      )}

      {error && <p className="provider-dialog-error" role="alert">{error}</p>}
      {notice && <p className="provider-dialog-result" role="status">{notice}</p>}
    </div>
  )
}