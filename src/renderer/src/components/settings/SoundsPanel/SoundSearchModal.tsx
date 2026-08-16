/* eslint-disable react-hooks/set-state-in-effect */
/**
 * SoundSearchModal — модалка поиска звуков в интернете (Internet Archive).
 * Бесплатно, без API-ключа. Поиск → превью → выбор (скачивается как кастомный звук).
 *
 * Фичи:
 *  - Поиск по title + subject (релевантные SFX, а не музыка)
 *  - Фильтр "короткие звуки" (item_size < 2MB) — отсекает музыку/альбомы
 *  - Превью с индикатором загрузки и отменой (AbortController в main process)
 *  - Анимированный эквалайзер на играющем звуке
 *  - Пагинация "Загрузить ещё"
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import AppIcon from '../../ui/AppIcon/AppIcon'
import { whileHoverTiny, whileTapTiny, whileHoverSm, whileTapSm, springHover } from '../../../utils/motionPresets'
import './SoundSearchModal.css'

interface SearchResult {
  identifier: string
  title: string
  downloads: number
  size: number
}

interface SoundFile {
  name: string
  length: string
  size: number
}

interface SoundSearchModalProps {
  open: boolean
  onClose: () => void
  onSelect: (customSoundId: string) => void
}

export default function SoundSearchModal({ open, onClose, onSelect }: SoundSearchModalProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [files, setFiles] = useState<Record<string, SoundFile[]>>({})
  const [filesLoading, setFilesLoading] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState<string | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [shortOnly, setShortOnly] = useState(true)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Ref для отслеживания актуального превью-запроса (race condition guard).
  const previewKeyRef = useRef<string | null>(null)

  // ── Остановка превью ──
  const stopPreview = useCallback(() => {
    previewKeyRef.current = null
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    setPreviewing(null)
    setPreviewLoading(null)
    window.syntee.sound.cancelPreview().catch(() => {})
  }, [])

  // Останавливаем звук при закрытии
  useEffect(() => {
    if (!open) {
      stopPreview()
    }
  }, [open, stopPreview])

  // Esc: сначала стопает превью, потом закрывает модалку
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (audioRef.current || previewLoading) {
          stopPreview()
        } else {
          onClose()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, previewLoading, stopPreview])

  const doSearch = useCallback(async (q: string, pg: number, append = false) => {
    if (!q.trim()) {
      setResults([])
      setTotal(0)
      return
    }
    if (pg === 1) setLoading(true)
    else setLoadingMore(true)
    try {
      const data = await window.syntee.sound.search(q, pg, shortOnly)
      if (append) {
        setResults(prev => [...prev, ...data.results])
      } else {
        setResults(data.results)
      }
      setTotal(data.total)
      setPage(data.page)
    } catch {
      if (!append) { setResults([]); setTotal(0) }
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [shortOnly])

  // Debounce поиска
  useEffect(() => {
    if (!open) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      doSearch(query, 1)
      setExpandedId(null)
    }, 350)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query, open, doSearch])

  // Re-search при переключении shortOnly
  useEffect(() => {
    if (open && query.trim()) {
      stopPreview()
      doSearch(query, 1)
      setExpandedId(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shortOnly])

  const loadFiles = useCallback(async (identifier: string) => {
    if (files[identifier]) return
    setFilesLoading(identifier)
    try {
      const data = await window.syntee.sound.getFiles(identifier)
      setFiles(prev => ({ ...prev, [identifier]: data.files }))
    } catch {
      setFiles(prev => ({ ...prev, [identifier]: [] }))
    } finally {
      setFilesLoading(null)
    }
  }, [files])

  const toggleExpand = useCallback((identifier: string) => {
    if (expandedId === identifier) {
      setExpandedId(null)
      return
    }
    // Останавливаем превью при сворачивании
    stopPreview()
    setExpandedId(identifier)
    loadFiles(identifier)
  }, [expandedId, loadFiles, stopPreview])

  const playPreview = useCallback(async (identifier: string, filename: string) => {
    const key = `${identifier}/${filename}`

    // Если грузится этот звук → отменяем
    if (previewLoading === key) {
      stopPreview()
      return
    }

    // Останавливаем текущий
    stopPreview()

    // Если играл этот звук → просто стоп
    if (previewing === key) return

    // Запоминаем ключ для race condition guard
    previewKeyRef.current = key
    setPreviewLoading(key)

    try {
      const dataUrl = await window.syntee.sound.fetchPreview(identifier, filename)

      // Проверяем, не отменили ли за время загрузки
      if (previewKeyRef.current !== key) return

      if (!dataUrl) {
        setPreviewLoading(null)
        return
      }

      // data: URL → blob: URL (CSP-safe)
      const base64 = dataUrl.split(',')[1] || ''
      const binaryStr = atob(base64)
      const bytes = new Uint8Array(binaryStr.length)
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
      const blob = new Blob([bytes], { type: 'audio/mpeg' })
      const blobUrl = URL.createObjectURL(blob)
      const audio = new Audio(blobUrl)
      audio.volume = 0.7
      audioRef.current = audio
      setPreviewLoading(null)
      setPreviewing(key)
      audio.play().catch(() => stopPreview())
      audio.addEventListener('ended', () => {
        URL.revokeObjectURL(blobUrl)
        stopPreview()
      })
    } catch {
      if (previewKeyRef.current === key) {
        stopPreview()
      }
    }
  }, [previewing, previewLoading, stopPreview])

  const handleSelect = useCallback(async (identifier: string, filename: string, title: string) => {
    const key = `${identifier}/${filename}`
    setDownloading(key)
    stopPreview()
    try {
      const customId = await window.syntee.sound.saveRemote(identifier, filename, title)
      if (customId) {
        onSelect(customId)
      }
    } catch { /* ok */ } finally {
      setDownloading(null)
    }
  }, [onSelect, stopPreview])

  const handleLoadMore = useCallback(() => {
    if (loadingMore || results.length >= total) return
    doSearch(query, page + 1, true)
  }, [loadingMore, results.length, total, query, page, doSearch])

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const formatDownloads = (n: number): string => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
    return String(n)
  }

  const hasMore = results.length < total

  if (!open) return null

  return createPortal(
    <AnimatePresence>
      <motion.div
        className="sound-search-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onClick={onClose}
      >
        <motion.div
          className="sound-search-modal"
          initial={{ opacity: 0, scale: 0.94, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.94, y: 12 }}
          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="sound-search-header">
            <h2 className="sound-search-title">
              <AppIcon name="search" size="sm" />
              <span>Поиск звуков</span>
            </h2>
            <span className="sound-search-source">Internet Archive · бесплатно</span>
            <motion.button className="sound-search-close" onClick={onClose} title="Закрыть (Esc)" whileHover={whileHoverTiny} whileTap={whileTapTiny} transition={springHover}>
              <AppIcon name="x" size="sm" />
            </motion.button>
          </div>

          {/* Search input + toggle */}
          <div className="sound-search-input-wrap">
            <AppIcon name="search" size="xs" />
            <input
              className="sound-search-input"
              type="text"
              placeholder="notification, click, bell, error..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              autoFocus
            />
            {query && (
              <motion.button
                className="sound-search-clear"
                onClick={() => { setQuery(''); setResults([]); setTotal(0) }}
                title="Очистить"
                whileHover={whileHoverTiny}
                whileTap={whileTapTiny}
                transition={springHover}
              >
                <AppIcon name="x" size="xs" />
              </motion.button>
            )}
            <motion.button
              className={`sound-search-toggle ${shortOnly ? 'active' : ''}`}
              onClick={() => setShortOnly(v => !v)}
              title={shortOnly ? 'Показывать только короткие звуки (< 2MB)' : 'Показывать все размеры'}
              whileHover={whileHoverSm}
              whileTap={whileTapSm}
              transition={springHover}
            >
              <AppIcon name="filter" size="xs" />
              <span>Короткие</span>
            </motion.button>
          </div>

          {/* Results */}
          <div className="sound-search-body">
            {loading && results.length === 0 ? (
              <div className="sound-search-loading">
                <AppIcon name="loader" size="md" animation="spin" />
                <span>Поиск...</span>
              </div>
            ) : results.length === 0 && query.trim() ? (
              <div className="sound-search-empty">Ничего не найдено. Попробуйте другой запрос.</div>
            ) : results.length === 0 ? (
              <div className="sound-search-hint">
                Введите запрос для поиска звуков.
                <br />
                Например: <em>notification</em>, <em>click</em>, <em>bell</em>, <em>error</em>, <em>success</em>
              </div>
            ) : (
              <>
                <div className="sound-search-count">
                  Найдено: {total.toLocaleString('ru-RU')}
                  {shortOnly && <span className="sound-search-filter-hint"> · только &lt; 2MB</span>}
                </div>
                <div className="sound-search-list">
                  {results.map(result => {
                    const isExpanded = expandedId === result.identifier
                    const itemFiles = files[result.identifier] || []
                    const isLoadingFiles = filesLoading === result.identifier
                    return (
                      <div
                        key={result.identifier}
                        className={`sound-search-row ${isExpanded ? 'expanded' : ''}`}
                      >
                        <div
                          className="sound-search-row-main"
                          onClick={() => toggleExpand(result.identifier)}
                        >
                          <AppIcon
                            name={isExpanded ? 'chevronDown' : 'chevronRight'}
                            size="xs"
                          />
                          <span className="sound-search-row-title" title={result.title}>
                            {result.title}
                          </span>
                          <span className="sound-search-row-meta">
                            ↓ {formatDownloads(result.downloads)} · {formatSize(result.size)}
                          </span>
                        </div>

                        {isExpanded && (
                          <div className="sound-search-files">
                            {isLoadingFiles ? (
                              <div className="sound-search-files-loading">
                                <AppIcon name="loader" size="xs" animation="spin" /> Загрузка файлов...
                              </div>
                            ) : itemFiles.length === 0 ? (
                              <div className="sound-search-files-empty">Нет MP3-файлов</div>
                            ) : (
                              itemFiles.map(file => {
                                const key = `${result.identifier}/${file.name}`
                                const isPlaying = previewing === key
                                const isLoading = previewLoading === key
                                const isDownloading = downloading === key
                                return (
                                  <div
                                    key={file.name}
                                    className={`sound-search-file ${isPlaying ? 'playing' : ''}`}
                                  >
                                    {isPlaying ? (
                                      <span className="sound-search-eq" title="Играет...">
                                        <span /><span /><span />
                                      </span>
                                    ) : (
                                      <span className="sound-search-file-length">
                                        {file.length !== '?' ? `${file.length}s` : ''}
                                      </span>
                                    )}
                                    <span className="sound-search-file-name" title={file.name}>
                                      {file.name}
                                    </span>
                                    <div className="sound-search-file-actions">
                                      <motion.button
                                        className="sound-search-play-btn"
                                        onClick={() => playPreview(result.identifier, file.name)}
                                        title={isPlaying ? 'Стоп' : isLoading ? 'Отменить' : 'Прослушать'}
                                        whileHover={whileHoverTiny}
                                        whileTap={whileTapTiny}
                                        transition={springHover}
                                      >
                                        <AppIcon
                                          name={isLoading ? 'loader' : isPlaying ? 'pause' : 'volume'}
                                          size="xs"
                                          animation={isLoading ? 'spin' : 'none'}
                                        />
                                      </motion.button>
                                      <motion.button
                                        className="sound-search-select-btn"
                                        onClick={() => handleSelect(result.identifier, file.name, result.title)}
                                        disabled={isDownloading}
                                        title="Выбрать этот звук"
                                        whileHover={whileHoverTiny}
                                        whileTap={whileTapTiny}
                                        transition={springHover}
                                      >
                                        {isDownloading ? (
                                          <AppIcon name="loader" size="xs" animation="spin" />
                                        ) : (
                                          <AppIcon name="check" size="xs" />
                                        )}
                                      </motion.button>
                                    </div>
                                  </div>
                                )
                              })
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
                {hasMore && (
                  <div className="sound-search-loadmore">
                    <motion.button
                      className="sound-search-loadmore-btn"
                      onClick={handleLoadMore}
                      disabled={loadingMore}
                      whileHover={whileHoverSm}
                      whileTap={whileTapSm}
                      transition={springHover}
                    >
                      {loadingMore ? (
                        <><AppIcon name="loader" size="xs" animation="spin" /> Загрузка...</>
                      ) : (
                        <>Загрузить ещё ({(total - results.length).toLocaleString('ru-RU')})</>
                      )}
                    </motion.button>
                  </div>
                )}
              </>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}
