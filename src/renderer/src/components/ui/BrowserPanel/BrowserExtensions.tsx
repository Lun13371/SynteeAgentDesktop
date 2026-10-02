// ── ExtensionsPopover: установка/управление расширениями браузера ─────────
//
// Поповер от кнопки-пазла в тулбаре BrowserPanel:
//  • поле «вставь URL или ID из Chrome Web Store» + Install;
//  • локальная установка: .crx/.zip файл или папка (Load unpacked);
//  • список установленных: вкл/выкл (toggle) + удалить.
//
// Установка из Web Store: main скачивает CRX с update-сервера Google,
// распаковывает и грузит в сессию браузера (persist:syntee-browser).

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import './BrowserExtensions.css'

interface ExtInfo {
  id: string
  name: string
  version: string
  description?: string
  source: 'webstore' | 'local'
  enabled: boolean
  dir: string
}

interface Props {
  anchorEl: HTMLElement | null
  onClose: () => void
  onChanged: () => void
}

export default function BrowserExtensionsPopover({ anchorEl, onClose, onChanged }: Props) {
  const [exts, setExts] = useState<ExtInfo[]>([])
  const [storeInput, setStoreInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const reload = useCallback(() => {
    window.syntee.browser.extList().then(setExts).catch(() => setExts([]))
  }, [])

  useEffect(() => { reload() }, [reload])

  // Позиция поповера от кнопки-якоря.
  useEffect(() => {
    if (!anchorEl) return
    const r = anchorEl.getBoundingClientRect()
    const width = 340
    let left = r.right - width
    if (left < 8) left = 8
    let top = r.bottom + 6
    if (top + 420 > window.innerHeight) top = Math.max(8, r.top - 420 - 6)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- позиция поповера известна только после mount (anchorEl из DOM)
    setPos({ top, left })
  }, [anchorEl])

  // Закрытие по клику вне.
  useEffect(() => {
    if (!anchorEl) return
    const onDown = (e: MouseEvent) => {
      if (popRef.current?.contains(e.target as Node)) return
      if (anchorEl.contains(e.target as Node)) return
      onClose()
    }
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', onDown) }
  }, [anchorEl, onClose])

  const handleInstallWebStore = async () => {
    const input = storeInput.trim()
    if (!input || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await window.syntee.browser.extInstallWebStore(input)
      if (res.ok && res.info) {
        setMessage({ kind: 'ok', text: `Установлено: ${res.info.name} v${res.info.version}` })
        setStoreInput('')
        reload()
        onChanged()
      } else {
        setMessage({ kind: 'error', text: res.error ?? 'Не удалось установить' })
      }
    } finally {
      setBusy(false)
    }
  }

  const handleInstallLocal = async (mode: 'file' | 'folder') => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await window.syntee.browser.extInstallLocal(mode)
      if (res.ok && res.info) {
        setMessage({ kind: 'ok', text: `Установлено: ${res.info.name} v${res.info.version}` })
        reload()
        onChanged()
      } else if (!res.canceled) {
        setMessage({ kind: 'error', text: res.error ?? 'Не удалось установить' })
      }
    } finally {
      setBusy(false)
    }
  }

  const handleToggle = async (ext: ExtInfo) => {
    await window.syntee.browser.extToggle(ext.id, !ext.enabled).catch(() => {})
    reload()
    onChanged()
  }

  const handleRemove = async (ext: ExtInfo) => {
    await window.syntee.browser.extRemove(ext.id).catch(() => {})
    reload()
    onChanged()
  }

  if (!anchorEl || !pos) return null

  return createPortal(
    <AnimatePresence>
      <motion.div
        ref={popRef}
        className="browser-ext-pop"
        initial={{ opacity: 0, y: -4, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -4, scale: 0.97 }}
        transition={{ duration: 0.12 }}
        style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999 }}
      >
        <div className="browser-ext-pop__title">
          <AppIcon name="puzzle" size="xs" />
          <span>Расширения браузера</span>
        </div>

        {/* Установка из Chrome Web Store */}
        <div className="browser-ext-pop__section">
          <input
            className="browser-ext-pop__input"
            value={storeInput}
            onChange={e => setStoreInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleInstallWebStore() }}
            placeholder="URL или ID из Chrome Web Store"
            spellCheck={false}
            disabled={busy}
          />
          <button className="browser-ext-pop__btn" onClick={handleInstallWebStore} disabled={busy || !storeInput.trim()}>
            {busy ? '…' : 'Установить'}
          </button>
        </div>

        {/* Локальная установка */}
        <div className="browser-ext-pop__section browser-ext-pop__section--local">
          <button className="browser-ext-pop__btn browser-ext-pop__btn--ghost" onClick={() => handleInstallLocal('file')} disabled={busy}>
            Из .crx / .zip
          </button>
          <button className="browser-ext-pop__btn browser-ext-pop__btn--ghost" onClick={() => handleInstallLocal('folder')} disabled={busy}>
            Из папки
          </button>
        </div>

        {message && (
          <div className={`browser-ext-pop__msg browser-ext-pop__msg--${message.kind}`}>{message.text}</div>
        )}

        {/* Список установленных */}
        <div className="browser-ext-pop__list">
          {exts.length === 0 ? (
            <div className="browser-ext-pop__empty">Нет установленных расширений</div>
          ) : exts.map(ext => (
            <div key={ext.id} className="browser-ext-pop__item">
              <div className="browser-ext-pop__item-info">
                <span className="browser-ext-pop__item-name" title={ext.description ?? ext.name}>
                  {ext.name}
                </span>
                <span className="browser-ext-pop__item-meta">
                  v{ext.version} · {ext.source === 'webstore' ? 'Web Store' : 'локально'}
                </span>
              </div>
              <button
                className={`browser-ext-pop__toggle${ext.enabled ? ' browser-ext-pop__toggle--on' : ''}`}
                onClick={() => handleToggle(ext)}
                title={ext.enabled ? 'Выключить' : 'Включить'}
              >
                <span className="browser-ext-pop__toggle-thumb" />
              </button>
              <button
                className="browser-ext-pop__remove"
                onClick={() => handleRemove(ext)}
                title="Удалить"
              >
                <AppIcon name="trash" size="xs" />
              </button>
            </div>
          ))}
        </div>

        <div className="browser-ext-pop__hint">
          Electron поддерживает подмножество chrome.* — content-script расширения (uBlock, Dark Reader) работают; попапы расширений — нет.
        </div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}
