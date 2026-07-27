import { useMemo } from 'react'
import AppIcon from '../../ui/AppIcon/AppIcon'
import { useAuthStore } from '../../../store/auth.store'
import {
  useGatewayModelsStore,
  normalizeStatus,
  type UptimeBucket,
} from '../../../store/gatewayModels.store'
import './ModelStatusSection.css'

/**
 * Панель «Статус моделей» в настройках.
 *
 * Показывает:
 *  - Сводку по провайдерам gateway (operational/degraded/down, ключи, uptime)
 *  - Per-model hourly uptime buckets за 12 часов (горизонтальные бары)
 *  - Запросы и ошибки за последний час
 *
 * Данные тянем из gatewayModels.store, который polling-обновляется каждые 60с.
 */
export default function ModelStatusSection() {
  const user = useAuthStore(s => s.user)
  const models = useGatewayModelsStore(s => s.models)
  const statusByModel = useGatewayModelsStore(s => s.statusByModel)
  const modelStatusBuckets = useGatewayModelsStore(s => s.modelStatusBuckets)
  const providerStatus = useGatewayModelsStore(s => s.providerStatus)
  const loading = useGatewayModelsStore(s => s.loading)
  const lastFetchAt = useGatewayModelsStore(s => s.lastFetchAt)
  const load = useGatewayModelsStore(s => s.load)

  // Map по model id для быстрого lookup buckets. Вынесено выше early-return
  // чтобы не нарушать правила хуков.
  const bucketsByModel = useMemo(() => {
    const m: Record<string, UptimeBucket[]> = {}
    for (const b of modelStatusBuckets) m[b.model] = b.buckets
    return m
  }, [modelStatusBuckets])

  if (!user) {
    return (
      <div className="model-status-section">
        <h2 className="settings-section-title">Статус моделей</h2>
        <div className="model-status-guest">
          <AppIcon name="server" size="lg" />
          <p>Войдите в Syntee-Gateway, чтобы видеть статус моделей и провайдеров.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="model-status-section">
      <h2 className="settings-section-title">Статус моделей</h2>
      <p className="model-status-section__subtitle">
        Актуальное состояние моделей и провайдеров Syntee-Gateway.
        {lastFetchAt > 0 && (
          <span className="model-status-section__updated">
            {' '}Обновлено: {new Date(lastFetchAt).toLocaleTimeString('ru')}
          </span>
        )}
      </p>

      <button
        type="button"
        className="model-status-refresh"
        onClick={() => load()}
        disabled={loading}
      >
        {loading ? (
          <AppIcon name="loader" size="sm" animation="spin" />
        ) : (
          <AppIcon name="refreshCw" size="sm" />
        )}
        Обновить
      </button>

      {/* ── Провайдеры ── */}
      {providerStatus.length > 0 && (
        <div className="model-status-block">
          <h3 className="model-status-block__title">Провайдеры</h3>
          <div className="model-status-providers">
            {providerStatus.map((p) => (
              <div key={p.provider_id} className="model-status-provider">
                <div className="model-status-provider__head">
                  <span
                    className={`model-status-dot model-status-dot--${normalizeStatus(p.status as any)}`}
                  />
                  <span className="model-status-provider__name">{p.name}</span>
                  <span className="model-status-provider__prefix">[{p.prefix}]</span>
                </div>
                <div className="model-status-provider__stats">
                  <span title="Активных ключей">
                    <AppIcon name="lock" size="xs" /> {p.active_keys}/{p.total_keys}
                  </span>
                  <span title="Запросов за час">
                    <AppIcon name="zap" size="xs" /> {p.requests_1hr}
                  </span>
                  <span title="Ошибок за час" className={p.error_count > 0 ? 'model-status-provider__errors' : ''}>
                    <AppIcon name="alertCircle" size="xs" /> {p.error_count}
                  </span>
                  <span title="Uptime">
                    <AppIcon name="check" size="xs" /> {p.uptime}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Модели ── */}
      <div className="model-status-block">
        <h3 className="model-status-block__title">
          Модели
          {models.length > 0 && (
            <span className="model-status-block__count">{models.length}</span>
          )}
        </h3>

        {models.length === 0 ? (
          <div className="model-status-empty">
            {loading ? 'Загрузка…' : 'Нет данных. Возможно, gateway недоступен.'}
          </div>
        ) : (
          <div className="model-status-models">
            {models.map((m) => {
              const status = normalizeStatus(statusByModel[m.id])
              const buckets = bucketsByModel[m.id] ?? []
              return (
                <div key={m.id} className="model-status-model">
                  <div className="model-status-model__head">
                    <span
                      className={`model-status-dot model-status-dot--${status}`}
                      title={status}
                    />
                    <span className="model-status-model__name">
                      {m.display_name || m.id}
                    </span>
                    {m.type === 'group' && (
                      <span className="model-status-model__badge">group</span>
                    )}
                    <span className="model-status-model__id">{m.id}</span>
                  </div>
                  <UptimeBar buckets={buckets} />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

/** Горизонтальный бар uptime по часам. */
function UptimeBar({ buckets }: { buckets: UptimeBucket[] }) {
  if (buckets.length === 0) {
    return <div className="uptime-bar uptime-bar--empty">нет данных</div>
  }
  return (
    <div className="uptime-bar" title="Uptime по часам (12ч)">
      {buckets.map((b, i) => {
        const cls =
          b.requests === 0
            ? 'uptime-bar__cell--neutral'
            : b.errors === 0
              ? 'uptime-bar__cell--ok'
              : b.success / b.requests > 0.9
                ? 'uptime-bar__cell--ok'
                : b.success / b.requests > 0.5
                  ? 'uptime-bar__cell--warn'
                  : 'uptime-bar__cell--err'
        const pct = b.requests > 0 ? Math.round((b.success / b.requests) * 100) : 100
        return (
          <span
            key={i}
            className={`uptime-bar__cell ${cls}`}
            title={`${new Date(b.timestamp).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })} · ${b.requests} зап · uptime ${pct}%`}
          />
        )
      })}
    </div>
  )
}
