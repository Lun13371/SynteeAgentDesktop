import type { UptimeBucket } from '../../../store/gatewayModels.store'
import './MiniUptimeBar.css'

/**
 * Мини-бар uptime (12 ячеек) для отображения в пикерах моделей.
 * Компактная версия UptimeBar из ModelStatusSection.
 *
 * Ячейки:
 *  - neutral (нет запросов)
 *  - ok (errors == 0 или success/requests > 0.9)
 *  - warn (success/requests > 0.5)
 *  - err (иначе)
 */
export default function MiniUptimeBar({ buckets }: { buckets: UptimeBucket[] }) {
  if (!buckets || buckets.length === 0) return null
  return (
    <div className="mini-uptime-bar" title="Uptime по часам (12ч)">
      {buckets.map((b, i) => {
        const cls =
          b.requests === 0
            ? 'mini-uptime-bar__cell--neutral'
            : b.errors === 0
              ? 'mini-uptime-bar__cell--ok'
              : b.success / b.requests > 0.9
                ? 'mini-uptime-bar__cell--ok'
                : b.success / b.requests > 0.5
                  ? 'mini-uptime-bar__cell--warn'
                  : 'mini-uptime-bar__cell--err'
        const pct = b.requests > 0 ? Math.round((b.success / b.requests) * 100) : 100
        return (
          <span
            key={i}
            className={`mini-uptime-bar__cell ${cls}`}
            title={`${new Date(b.timestamp).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })} · ${b.requests} зап · uptime ${pct}%`}
          />
        )
      })}
    </div>
  )
}
