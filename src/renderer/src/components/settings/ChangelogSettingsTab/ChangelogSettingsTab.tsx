/**
 * ChangelogSettingsTab — settings page listing every ever-activated release.
 *
 * Fetches the public changelog history from the gateway (via the main-process
 * IPC proxy) and renders each entry as a card with the markdown changelog.
 * The currently installed version is marked with a "Текущая" badge; force
 * releases get a red "force" badge. A "Проверить обновления" button at the
 * top triggers a manual re-check.
 */
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { RefreshCw, Zap, Check } from 'lucide-react'
import AppIcon from '../../ui/AppIcon/AppIcon'
import ChangelogMarkdown from '../../ui/ChangelogMarkdown/ChangelogMarkdown'
import { useUpdateStore } from '../../../store/update.store'
import { whileHoverWide, whileTapWide, springHover } from '../../../utils/motionPresets'
import type { ChangelogEntry } from '../../../../../shared/types'
import './ChangelogSettingsTab.css'

export default function ChangelogSettingsTab() {
  const [entries, setEntries] = useState<ChangelogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const check = useUpdateStore((s) => s.check)
  const checking = useUpdateStore((s) => s.status === 'checking')

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await window.syntee.updates.getHistory({ channel: 'stable', limit: 50 })
      setEntries(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [])

  const formatDate = (iso: string): string => {
    try {
      return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })
    } catch {
      return iso
    }
  }

  return (
    <div className="changelog-settings">
      <h2 className="settings-section-title">Список изменений</h2>

      <div className="changelog-settings-toolbar">
        <motion.button
          className="changelog-settings-check-btn"
          onClick={() => check().then(() => load())}
          disabled={checking}
          whileHover={whileHoverWide}
          whileTap={whileTapWide}
          transition={springHover}
        >
          {checking ? <AppIcon name="loader" size="xs" animation="spin" /> : <RefreshCw size={14} />}
          Проверить обновления
        </motion.button>
      </div>

      {loading ? (
        <div className="changelog-settings-loading">
          <AppIcon name="loader" size="md" animation="spin" />
          <span>Загрузка истории релизов…</span>
        </div>
      ) : error ? (
        <div className="changelog-settings-error">
          Не удалось загрузить историю: {error}
        </div>
      ) : entries.length === 0 ? (
        <div className="changelog-settings-empty">
          Релизы ещё не публиковались.
        </div>
      ) : (
        <div className="changelog-settings-list">
          {entries.map((entry, i) => (
            <motion.div
              key={entry.version}
              className={`changelog-card glass ${entry.is_current ? 'changelog-card--current' : ''}`}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: 'spring', stiffness: 380, damping: 28, delay: i * 0.03 }}
            >
              <div className="changelog-card-header">
                <span className="changelog-card-version">v{entry.version}</span>
                <div className="changelog-card-badges">
                  {entry.is_current && (
                    <span className="changelog-card-badge changelog-card-badge--current">
                      <Check size={11} /> Текущая
                    </span>
                  )}
                  {entry.force && (
                    <span className="changelog-card-badge changelog-card-badge--force">
                      <Zap size={11} /> force
                    </span>
                  )}
                </div>
                <span className="changelog-card-date">{formatDate(entry.released_at)}</span>
              </div>
              <ChangelogMarkdown content={entry.changelog} />
            </motion.div>
          ))}
        </div>
      )}
    </div>
  )
}
