import { useState, useRef, useCallback, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import IconButton from '../../components/ui/IconButton/IconButton'
import Logo from '../../components/ui/Logo/Logo'
import './OverlayPage.css'

interface Selection {
  x: number; y: number; width: number; height: number
}

type OverlayMode = 'idle' | 'selecting' | 'analyzing' | 'result'

export default function OverlayPage() {
  const [mode, setMode] = useState<OverlayMode>('idle')
  const [selection, setSelection] = useState<Selection | null>(null)
  const [startPos, setStartPos] = useState<{ x: number; y: number } | null>(null)
  const [resultText, setResultText] = useState('')
  const [streamText, setStreamText] = useState('')
  const [popupPos, setPopupPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Слушаем стриминг из main
  useEffect(() => {
    const offToken = window.syntee.on('chat:stream:token', (data: { token: string; source: string }) => {
      if (data.source !== 'overlay') return
      setStreamText(prev => prev + data.token)
    })
    const offDone = window.syntee.on('chat:stream:done', (data: { text: string; source: string }) => {
      if (data.source !== 'overlay') return
      setResultText(data.text)
      setStreamText('')
      setMode('result')
    })
    const offErr = window.syntee.on('chat:stream:error', (data: { error: string; source: string }) => {
      if (data.source !== 'overlay') return
      setResultText('Ошибка: ' + data.error)
      setMode('result')
    })
    return () => { offToken(); offDone(); offErr() }
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (mode !== 'idle') return
    setStartPos({ x: e.clientX, y: e.clientY })
    setSelection(null)
    setMode('selecting')
  }, [mode])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (mode !== 'selecting' || !startPos) return
    const x = Math.min(startPos.x, e.clientX)
    const y = Math.min(startPos.y, e.clientY)
    const width = Math.abs(e.clientX - startPos.x)
    const height = Math.abs(e.clientY - startPos.y)
    setSelection({ x, y, width, height })
  }, [mode, startPos])

  const handleMouseUp = useCallback(async (e: React.MouseEvent) => {
    if (mode !== 'selecting' || !selection) return
    if (selection.width < 10 || selection.height < 10) {
      setMode('idle')
      setSelection(null)
      return
    }

    // Позиция popup — под выделенной областью
    setPopupPos({
      x: Math.min(selection.x, window.innerWidth - 420),
      y: Math.min(selection.y + selection.height + 12, window.innerHeight - 300),
    })

    setMode('analyzing')
    setStreamText('')
    setResultText('')

    // Захватываем экран
    try {
      const screens = await window.syntee.overlay.getDisplays()
      const captures = await (window.syntee as any).overlay.captureScreen()
      if (!captures?.length) { setMode('idle'); return }

      // Берём первый скриншот (TODO: мульти-монитор)
      const capture = captures[0]
      const base64 = capture.thumbnail

      // Кропаем выделенную область из full-screen base64
      const croppedBase64 = await cropImageBase64(
        base64,
        selection.x / window.devicePixelRatio,
        selection.y / window.devicePixelRatio,
        selection.width / window.devicePixelRatio,
        selection.height / window.devicePixelRatio,
        capture.bounds?.width || window.screen.width,
        capture.bounds?.height || window.screen.height,
      )

      await (window.syntee as any).overlay.analyze({
        imageBase64: croppedBase64,
        prompt: '',
        action: 'analyze',
      })
    } catch (err) {
      setResultText('Ошибка захвата экрана')
      setMode('result')
    }
  }, [mode, selection])

  const handleClose = () => {
    setMode('idle')
    setSelection(null)
    setResultText('')
    setStreamText('')
    window.syntee.overlay.hide()
  }

  const handleAction = async (action: 'translate' | 'summarize' | 'read') => {
    if (!selection) return
    setMode('analyzing')
    setStreamText('')
    setResultText('')
    try {
      const captures = await (window.syntee as any).overlay.captureScreen()
      if (!captures?.length) return
      const capture = captures[0]
      const croppedBase64 = await cropImageBase64(
        capture.thumbnail,
        selection.x / window.devicePixelRatio,
        selection.y / window.devicePixelRatio,
        selection.width / window.devicePixelRatio,
        selection.height / window.devicePixelRatio,
        capture.bounds?.width || window.screen.width,
        capture.bounds?.height || window.screen.height,
      )
      await (window.syntee as any).overlay.analyze({ imageBase64: croppedBase64, prompt: '', action })
    } catch (err) {
      setResultText('Ошибка')
      setMode('result')
    }
  }

  // Нажатие Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div
      ref={containerRef}
      className={`overlay-root ${mode === 'idle' ? 'overlay-root--idle' : 'overlay-root--active'}`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Затемнение фона */}
      <AnimatePresence>
        {(mode === 'selecting' || mode === 'analyzing' || mode === 'result') && (
          <motion.div
            className="overlay-dim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          />
        )}
      </AnimatePresence>

      {/* Выделенная область */}
      {selection && (
        <div
          className="overlay-selection"
          style={{
            left: selection.x, top: selection.y,
            width: selection.width, height: selection.height,
          }}
        >
          {/* Радужная рамка */}
          <div className="overlay-selection-border rainbow-border" />
          {/* Glow эффект */}
          <div className="overlay-selection-glow" />
        </div>
      )}

      {/* Подсказка */}
      {mode === 'idle' && (
        <motion.div
          className="overlay-hint"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
        >
          Выделите область для анализа · ESC — закрыть
        </motion.div>
      )}

      {/* Popup с результатом */}
      <AnimatePresence>
        {(mode === 'analyzing' || mode === 'result') && (
          <motion.div
            className="overlay-popup glass"
            style={{ left: popupPos.x, top: popupPos.y }}
            initial={{ opacity: 0, scale: 0.92, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 8 }}
            transition={{ type: 'spring', stiffness: 350, damping: 28 }}
            onMouseDown={e => e.stopPropagation()}
          >
            {/* Хедер popup */}
            <div className="overlay-popup-header">
              <div className="overlay-popup-logo">
                <Logo size={16} />
                Syntee
              </div>
              <div className="overlay-popup-actions">
                {mode === 'result' && (
                  <>
                    <IconButton icon="globe" label="Перевести" className="overlay-action-btn" onClick={() => handleAction('translate')} />
                    <IconButton icon="fileText" label="Кратко" className="overlay-action-btn" onClick={() => handleAction('summarize')} />
                    <IconButton icon="search" label="OCR" className="overlay-action-btn" onClick={() => handleAction('read')} />
                    <IconButton icon="copy" label="Копировать" className="overlay-action-btn" onClick={() => navigator.clipboard.writeText(resultText)} />
                  </>
                )}
                <IconButton icon="x" label="Закрыть" className="overlay-action-btn overlay-close-btn" onClick={handleClose} />
              </div>
            </div>

            {/* Контент */}
            <div className="overlay-popup-content selectable">
              {mode === 'analyzing' && !streamText && (
                <div className="overlay-analyzing">
                  <span className="overlay-spinner" />
                  Анализирую...
                </div>
              )}
              {(streamText || resultText) && (
                <p className="overlay-result-text">
                  {streamText || resultText}
                  {mode === 'analyzing' && <span className="overlay-cursor">▋</span>}
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </div>
  )
}

// Кроп base64 изображения через canvas
async function cropImageBase64(
  fullBase64: string,
  x: number, y: number, w: number, h: number,
  srcW: number, srcH: number,
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const scaleX = img.width / srcW
      const scaleY = img.height / srcH
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(w * scaleX)
      canvas.height = Math.round(h * scaleY)
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img,
        x * scaleX, y * scaleY, w * scaleX, h * scaleY,
        0, 0, canvas.width, canvas.height
      )
      resolve(canvas.toDataURL('image/png').split(',')[1])
    }
    img.src = `data:image/png;base64,${fullBase64}`
  })
}
