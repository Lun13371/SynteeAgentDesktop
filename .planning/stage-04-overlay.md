# СТАДИЯ 04 — ОВЕРЛЕЙ (CIRCLE TO SEARCH)

> Цель: Circle-to-Search функционал поверх экрана. Выделяешь область —
> получаешь AI анализ прямо поверх рабочего стола. Перевод, чтение вслух,
> продолжение диалога по картинке.

---

## ЧТО БУДЕТ ГОТОВО ПОСЛЕ СТАДИИ

- Ctrl+Shift+S → прозрачный оверлей покрывает все мониторы
- 4 режима выделения: произвольная форма, прямоугольник, весь экран, все мониторы
- Контур выделения: радужный градиент (как Gemini), glow эффект
- Незаметная затемнение экрана, выделенная область светлее
- Захват области → gemini-3.5-flash анализирует → ответ в popup
- Popup 400x600: Liquid Glass, alwaysOnTop, закреплён рядом с выделением
- Popup: можно продолжить диалог, свернуть/развернуть, помнит позицию
- Alt+T: OCR + перевод выделенного текста в popup
- Alt+R: OCR + прочитать вслух через TTS
- Escape закрывает оверлей
- Кнопка кратко изложить открытую страницу браузера

---

## ТЕХНОЛОГИИ ЭТОЙ СТАДИИ

```
screenshot-desktop — захват экрана
jimp — обрезка изображения по координатам
sharp (опционально) — быстрая обработка
electron screen API — координаты мониторов
```

---

## ЗАДАЧИ

### 1. OverlayWindow расширение

```typescript
// src/main/windows/OverlayWindow.ts
import { BrowserWindow, screen } from 'electron'
import path from 'path'

export class OverlayWindow {
  private win: BrowserWindow | null = null

  create(): BrowserWindow {
    const { width, height, x, y } = this.getTotalBounds()

    this.win = new BrowserWindow({
      x, y, width, height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      fullscreenable: false,
      focusable: true,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
      }
    })

    // Поверх всего включая fullscreen приложения
    this.win.setAlwaysOnTop(true, 'screen-saver')
    this.win.loadURL(`${RENDERER_URL}#/overlay`)
    return this.win
  }

  // Суммарные границы всех мониторов
  private getTotalBounds() {
    const displays = screen.getAllDisplays()
    const minX = Math.min(...displays.map(d => d.bounds.x))
    const minY = Math.min(...displays.map(d => d.bounds.y))
    const maxX = Math.max(...displays.map(d => d.bounds.x + d.bounds.width))
    const maxY = Math.max(...displays.map(d => d.bounds.y + d.bounds.height))
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  }

  show() { this.win?.show(); this.win?.focus() }
  hide() { this.win?.hide() }

  // Получить информацию о мониторах для renderer
  getDisplaysInfo() {
    return screen.getAllDisplays().map(d => ({
      id: d.id,
      bounds: d.bounds,
      scaleFactor: d.scaleFactor,
      isPrimary: d.id === screen.getPrimaryDisplay().id,
    }))
  }
}
```

### 2. SelectionCanvas — React компонент

```tsx
// src/renderer/components/overlay/SelectionCanvas/SelectionCanvas.tsx
import { useRef, useEffect, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

type SelectionMode = 'freehand' | 'rect' | 'screen' | 'all'

interface SelectionCanvasProps {
  mode: SelectionMode
  onCapture: (region: { x: number; y: number; width: number; height: number }) => void
  displays: DisplayInfo[]
}

export function SelectionCanvas({ mode, onCapture, displays }: SelectionCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [isDrawing, setIsDrawing] = useState(false)
  const [startPos, setStartPos] = useState({ x: 0, y: 0 })
  const [currentPos, setCurrentPos] = useState({ x: 0, y: 0 })
  const pathRef = useRef<Array<{ x: number; y: number }>>([])

  // Радужный градиент для контура
  const drawRainbowStroke = (ctx: CanvasRenderingContext2D, path: Path2D) => {
    const gradient = ctx.createLinearGradient(0, 0, window.innerWidth, window.innerHeight)
    gradient.addColorStop(0, '#ff0080')
    gradient.addColorStop(0.2, '#ff8000')
    gradient.addColorStop(0.4, '#ffff00')
    gradient.addColorStop(0.6, '#00ff80')
    gradient.addColorStop(0.8, '#0080ff')
    gradient.addColorStop(1, '#8000ff')

    ctx.strokeStyle = gradient
    ctx.lineWidth = 3
    ctx.shadowColor = 'rgba(255, 255, 255, 0.8)'
    ctx.shadowBlur = 12
    ctx.stroke(path)
  }

  // Затемнение с вырезом выделенной области (glow)
  const renderOverlay = useCallback((region?: DOMRect) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!

    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // Затемнение всего экрана
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    if (!region) return

    // Вырезать выделенную область (чтобы она была светлее)
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'
    ctx.fillRect(region.x, region.y, region.width, region.height)

    // Glow вокруг выделенной области
    ctx.globalCompositeOperation = 'source-over'
    const path = new Path2D()
    path.rect(region.x - 2, region.y - 2, region.width + 4, region.height + 4)
    drawRainbowStroke(ctx, path)
  }, [])

  const handleMouseDown = (e: React.MouseEvent) => {
    if (mode === 'screen') {
      // Захватить текущий монитор
      const display = getDisplayAtPoint(e.clientX, e.clientY, displays)
      onCapture(display.bounds)
      return
    }
    if (mode === 'all') {
      // Захватить все мониторы
      const bounds = getTotalBounds(displays)
      onCapture(bounds)
      return
    }
    setIsDrawing(true)
    setStartPos({ x: e.clientX, y: e.clientY })
    pathRef.current = [{ x: e.clientX, y: e.clientY }]
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDrawing) return
    setCurrentPos({ x: e.clientX, y: e.clientY })
    pathRef.current.push({ x: e.clientX, y: e.clientY })

    if (mode === 'rect') {
      const region = {
        x: Math.min(startPos.x, e.clientX),
        y: Math.min(startPos.y, e.clientY),
        width: Math.abs(e.clientX - startPos.x),
        height: Math.abs(e.clientY - startPos.y),
      }
      renderOverlay(new DOMRect(region.x, region.y, region.width, region.height))
    }
  }

  const handleMouseUp = (e: React.MouseEvent) => {
    if (!isDrawing) return
    setIsDrawing(false)

    let region: { x: number; y: number; width: number; height: number }

    if (mode === 'rect') {
      region = {
        x: Math.min(startPos.x, e.clientX),
        y: Math.min(startPos.y, e.clientY),
        width: Math.abs(e.clientX - startPos.x),
        height: Math.abs(e.clientY - startPos.y),
      }
    } else {
      // freehand — bounding box пути
      const xs = pathRef.current.map(p => p.x)
      const ys = pathRef.current.map(p => p.y)
      region = {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      }
    }

    if (region.width > 10 && region.height > 10) {
      onCapture(region)
    }
  }

  return (
    <canvas
      ref={canvasRef}
      width={window.innerWidth}
      height={window.innerHeight}
      style={{ cursor: mode === 'rect' ? 'crosshair' : 'cell' }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    />
  )
}
```

### 3. ScreenCapture.ts — захват области

```typescript
// src/core/screen/ScreenCapture.ts
import screenshot from 'screenshot-desktop'
import Jimp from 'jimp'
import path from 'path'
import { app } from 'electron'
import { v4 as uuidv4 } from 'uuid'

export class ScreenCapture {
  // Захватить конкретную область экрана
  async captureRegion(region: {
    x: number
    y: number
    width: number
    height: number
    displayScaleFactor?: number
  }): Promise<string> {
    // Сделать полный скриншот
    const fullBuffer = await screenshot({ format: 'png' })

    // Обрезать по координатам (с учётом DPI scale)
    const scale = region.displayScaleFactor ?? 1
    const image = await Jimp.read(fullBuffer as Buffer)
    const cropped = image.crop(
      region.x * scale,
      region.y * scale,
      region.width * scale,
      region.height * scale
    )

    // Сохранить во временный файл
    const tmpPath = path.join(app.getPath('temp'), `syntee-capture-${uuidv4()}.png`)
    await cropped.writeAsync(tmpPath)
    return tmpPath
  }

  // Захватить весь экран (для голосового режима)
  async captureFullScreen(displayIndex = 0): Promise<string> {
    const buffer = await screenshot({ screen: displayIndex, format: 'png' })
    const tmpPath = path.join(app.getPath('temp'), `syntee-screen-${uuidv4()}.png`)
    require('fs').writeFileSync(tmpPath, buffer)
    return tmpPath
  }

  // Конвертировать в base64 для отправки в API
  async toBase64(imagePath: string): Promise<string> {
    const buffer = require('fs').readFileSync(imagePath)
    return buffer.toString('base64')
  }
}
```

### 4. VisionService.ts — анализ изображений

```typescript
// src/core/ai/VisionService.ts
import type { AIClient } from './AIClient'
import type Store from 'electron-store'
import fs from 'fs'

export class VisionService {
  constructor(
    private ai: AIClient,
    private store: Store
  ) {}

  // Анализ изображения через gemini-3.5-flash
  async analyzeImage(params: {
    imagePath: string
    prompt?: string
    chatHistory?: Array<{ role: 'user' | 'assistant', content: string }>
  }): Promise<AsyncIterable<string>> {
    const model = this.store.get('visionModel') as string // gemini-3.5-flash
    const imageBase64 = fs.readFileSync(params.imagePath).toString('base64')
    const imageType = 'image/png'

    const userContent: any = [
      {
        type: 'image_url',
        image_url: { url: `data:${imageType};base64,${imageBase64}` }
      },
      {
        type: 'text',
        text: params.prompt ?? 'Что изобра��ено на этом скриншоте? Ответь на русском языке.'
      }
    ]

    const messages: any[] = [
      { role: 'system', content: 'Ты умный ассистент. Анализируй изображения и отвечай на русском.' },
      ...(params.chatHistory ?? []),
      { role: 'user', content: userContent }
    ]

    return this.ai.streamChat({ model, messages })
  }

  // OCR — извлечь текст с изображения
  async extractText(imagePath: string): Promise<string> {
    const model = this.store.get('visionModel') as string
    const imageBase64 = fs.readFileSync(imagePath).toString('base64')

    return await this.ai.complete({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
          { type: 'text', text: 'Извлеки весь текст с изображения. Верни только текст, без комментариев.' }
        ] as any
      }],
      temperature: 0.1,
    })
  }

  // Перевести текст с изображения
  async translateFromImage(imagePath: string, targetLang = 'ru'): Promise<string> {
    const text = await this.extractText(imagePath)
    const model = this.store.get('mainModel') as string
    return await this.ai.complete({
      model,
      messages: [{
        role: 'user',
        content: `Переведи на ${targetLang}: "${text}"`
      }],
    })
  }
}
```

### 5. OverlayPage — главная страница оверлея

```tsx
// src/renderer/pages/Overlay/OverlayPage.tsx
import { useState, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { SelectionCanvas } from '../../components/overlay/SelectionCanvas'
import { OverlayChat } from '../../components/overlay/OverlayChat'

type SelectionMode = 'freehand' | 'rect' | 'screen' | 'all'

export function OverlayPage() {
  const [mode, setMode] = useState<SelectionMode>('freehand')
  const [capturedRegion, setCapturedRegion] = useState<CapturedRegion | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [analysisResult, setAnalysisResult] = useState('')
  const [chatHistory, setChatHistory] = useState<Message[]>([])
  const [popupPos, setPopupPos] = useState({ x: 0, y: 0 })

  useEffect(() => {
    // Закрыть по Escape
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.syntee.overlay.hide()
      // Переключение режимов: F=freehand, R=rect, S=screen, A=all
      if (e.key === 'f') setMode('freehand')
      if (e.key === 'r') setMode('rect')
      if (e.key === 's') setMode('screen')
      if (e.key === 'a') setMode('all')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const handleCapture = async (region: Region) => {
    setCapturedRegion(region)
    setIsAnalyzing(true)

    // Позиция popup рядом с выделением
    const popupX = Math.min(region.x + region.width + 20, window.innerWidth - 420)
    const popupY = Math.max(region.y, 20)
    setPopupPos({ x: popupX, y: popupY })

    // Захват и анализ
    const imagePath = await window.syntee.screen.capture(region)
    setIsAnalyzing(false)

    // Открыть чат с изображением
    setCapturedRegion({ ...region, imagePath })
  }

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      {/* Режим выбора и инструктаж */}
      {!capturedRegion && (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="overlay-toolbar"
          style={{ position: 'fixed', top: 20, left: '50%', transform: 'translateX(-50%)' }}
        >
          <ModeSelector mode={mode} onChange={setMode} />
          <span style={{ color: 'white', opacity: 0.7 }}>
            {mode === 'freehand' ? 'Нарисуйте область' :
             mode === 'rect' ? 'Выделите прямоугольник' :
             mode === 'screen' ? 'Кликните на монитор' :
             'Будут захвачены все мониторы'}
          </span>
        </motion.div>
      )}

      {/* Canvas для рисования */}
      {!capturedRegion && (
        <SelectionCanvas
          mode={mode}
          displays={[]} // передать из IPC
          onCapture={handleCapture}
        />
      )}

      {/* Popup с чатом */}
      <AnimatePresence>
        {(capturedRegion || isAnalyzing) && (
          <OverlayChat
            imagePath={capturedRegion?.imagePath}
            isLoading={isAnalyzing}
            position={popupPos}
            chatHistory={chatHistory}
            onUpdateHistory={setChatHistory}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
```

### 6. OverlayChat — popup с чатом

```tsx
// src/renderer/components/overlay/OverlayChat/OverlayChat.tsx
import { useState, useRef } from 'react'
import { motion } from 'framer-motion'

export function OverlayChat({ imagePath, isLoading, position, chatHistory, onUpdateHistory }) {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [input, setInput] = useState('')
  const [pos, setPos] = useState(position)
  const dragRef = useRef(null)

  return (
    <motion.div
      ref={dragRef}
      initial={{ opacity: 0, scale: 0.8, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.8 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: 400,
        height: isCollapsed ? 48 : 600,
        // Liquid Glass
        background: 'rgba(255, 255, 255, 0.08)',
        backdropFilter: 'blur(40px) saturate(180%)',
        border: '1px solid rgba(255, 255, 255, 0.15)',
        borderRadius: 20,
        overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
      }}
    >
      {/* Заголовок с кнопками */}
      <div className="overlay-chat-header" style={{ cursor: 'grab' }}>
        <span style={{ color: 'white' }}>Syntee</span>
        <button onClick={() => setIsCollapsed(!isCollapsed)}>
          {isCollapsed ? '▲' : '▼'}
        </button>
        <button onClick={() => window.syntee.overlay.hide()}>✕</button>
      </div>

      {!isCollapsed && (
        <>
          {/* Сообщения */}
          <div className="overlay-messages">
            {isLoading && <div className="analyzing-indicator">Анализирую...</div>}
            {chatHistory.map((msg, i) => (
              <div key={i} className={`overlay-message ${msg.role}`}>
                {msg.content}
              </div>
            ))}
          </div>

          {/* Инпут */}
          <div className="overlay-input">
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  // отправить следующий вопрос по той же картинке
                }
              }}
              placeholder="Задать уточняющий вопрос..."
            />
          </div>

          {/* Кнопки действий */}
          <div className="overlay-actions">
            <button onClick={() => window.syntee.vision.readAloud(imagePath)}>
              🔊 Прочитать
            </button>
            <button onClick={() => window.syntee.vision.translate(imagePath)}>
              🌐 Перевести
            </button>
            <button onClick={() => window.syntee.browser.summarizePage()}>
              📄 Кратко о странице
            </button>
          </div>
        </>
      )}
    </motion.div>
  )
}
```

---

## СТРУКТУРА ФАЙЛОВ СТАДИИ

```
src/core/
  screen/
    ScreenCapture.ts      ← новый
    RegionSelector.ts     ← новый
    ScreenWatcher.ts      ← заглушка
  ai/
    VisionService.ts      ← новый
src/main/
  windows/
    OverlayWindow.ts      ← обновить
  ipc/
    overlay.ipc.ts        ← новый
    vision.ipc.ts         ← новый
src/renderer/
  pages/
    Overlay/
      OverlayPage.tsx     ← новый
  components/
    overlay/
      SelectionCanvas/    ← новый
      OverlayChat/        ← новый
      OverlayResult/      ← новый
```

---

## ПРОВЕРКА ГОТОВНОСТИ СТАДИИ

- [ ] Ctrl+Shift+S → оверлей появляется поверх всего
- [ ] Экран слегка затемняется
- [ ] Рисование произвольной формы работает
- [ ] Прямоугольник выделяется корректно
- [ ] Контур радужный, glow эффект
- [ ] Незаметная область подсвечивается
- [ ] Popup появляется рядом с выделением с анимацией
- [ ] Popup отображает ответ от gemini-3.5-flash
- [ ] Можно задать уточняющий вопрос
- [ ] Alt+T переводит текст с области
- [ ] Alt+R читает текст вслух
- [ ] Popup сворачивается/разворачивается
- [ ] Escape закрывает оверлей
- [ ] На 2 мониторах работает корректно
