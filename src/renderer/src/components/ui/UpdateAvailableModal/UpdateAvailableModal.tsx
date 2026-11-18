/**
 * UpdateAvailableModal — открывается по клику на синий бейдж обновления.
 *
 * Показывает changelog и прогресс фонового скачивания. Скачивание стартует
 * сразу после обнаружения версии (в main-процессе), поэтому обычно к моменту
 * открытия модалки файл уже готов.
 *
 * Действия:
 *   1. «Перезапустить и обновить» — ставит скачанный файл, закрывает
 *      приложение; установщик открывает новую версию сам.
 *   2. «Позже»                  — закрыть; обновление встанет при выходе.
 *   3. «Пропустить эту версию»  — скрыть бейдж до следующего релиза.
 *
 * Esc / клик мимо закрывают модалку без отказа от обновления.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, Download, Loader2, RotateCcw, X } from 'lucide-react'
import AppIcon from '../AppIcon/AppIcon'
import ChangelogMarkdown from '../ChangelogMarkdown/ChangelogMarkdown'
import { selectDownloadProgress, useUpdateStore } from '../../../store/update.store'
import './UpdateAvailableModal.css'

interface Props {
  open: boolean
  onClose: () => void
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })
  } catch {
    return ''
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function UpdateAvailableModal({ open, onClose }: Props) {
  const available = useUpdateStore((s) => s.available)
  const install = useUpdateStore((s) => s.install)
  const progress = useUpdateStore(selectDownloadProgress)
  const quitAndInstall = useUpdateStore((s) => s.quitAndInstall)
  const dismiss = useUpdateStore((s) => s.dismiss)
  const [installError, setInstallError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)

  const downloading = install.phase === 'downloading'
  const ready = install.phase === 'ready'
  const applyingPhase = applying || install.phase === 'installing'

  // Ставим обновление: приложение закроется само, установщик откроет новую
  // версию. Если запустить не удалось — остаёмся открытыми и показываем причину.
  const handleInstall = async () => {
    setInstallError(null)
    setApplying(true)
    const res = await quitAndInstall()
    if (!res.ok) {
      setApplying(false)
      setInstallError(res.error ?? 'Неизвестная ошибка')
    }
  }

  // Esc закрывает (без отказа от обновления — бейдж остаётся).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !applyingPhase) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, applyingPhase])

  if (!open || !available) return null

  const error = installError ?? install.error

  return createPortal(
    <AnimatePresence>
      <motion.div
        className="update-modal-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onClick={() => { if (!applyingPhase) onClose() }}
      >
        <motion.div
          className="update-modal"
          initial={{ opacity: 0, scale: 0.94, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.94, y: 12 }}
          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="update-modal-header">
            <h2 className="update-modal-title">
              <AppIcon name="downloadCloud" size="md" />
              <span>Доступна новая версия <strong>v{available.version}</strong></span>
            </h2>
            <button
              className="update-modal-close"
              onClick={onClose}
              disabled={applyingPhase}
              title="Закрыть (Esc)"
            >
              <X size={16} />
            </button>
          </div>

          <div className="update-modal-meta">
            <span className="update-modal-meta-item">{formatDate(available.released_at)}</span>
            <span className="update-modal-meta-sep">·</span>
            <span className="update-modal-meta-item">{formatSize(available.zip_size)}</span>
            <span className="update-modal-meta-sep">·</span>
            <span className="update-modal-meta-item update-modal-meta-channel">{available.channel}</span>
          </div>

          <div className="update-modal-body">
            <div className="update-modal-section-title">Список изменений</div>
            <ChangelogMarkdown content={available.changelog} />
          </div>

          <div className="update-modal-actions">
            {downloading && (
              <div className="update-modal-progress">
                <div className="update-modal-progress-label">
                  <span>Скачивается в фоне…</span>
                  <span>
                    {formatSize(install.received)} / {formatSize(install.total || available.zip_size)}
                  </span>
                </div>
                <div className="update-modal-progress-track">
                  <div
                    className="update-modal-progress-fill"
                    style={{ width: `${Math.round(progress * 100)}%` }}
                  />
                </div>
              </div>
            )}

            {ready && !applyingPhase && (
              <div className="update-modal-ready">
                <Check size={13} />
                <span>Скачано и проверено — можно устанавливать</span>
              </div>
            )}

            {error && (
              <div className="update-modal-error">Не удалось обновить: {error}</div>
            )}

            <button
              className="update-modal-btn update-modal-btn--ghost"
              onClick={() => { dismiss(); onClose() }}
              disabled={applyingPhase}
            >
              Пропустить эту версию
            </button>
            <button
              className="update-modal-btn update-modal-btn--secondary"
              onClick={onClose}
              disabled={applyingPhase}
            >
              Позже
            </button>
            <button
              className="update-modal-btn update-modal-btn--primary"
              onClick={handleInstall}
              disabled={applyingPhase || downloading}
            >
              {applyingPhase
                ? <Loader2 size={15} className="spin" />
                : ready ? <RotateCcw size={15} /> : <Download size={15} />}
              {applyingPhase
                ? 'Устанавливается…'
                : downloading ? 'Скачивание…' : 'Перезапустить и обновить'}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}
