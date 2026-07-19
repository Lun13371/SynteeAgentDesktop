import { BrowserWindow, shell, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import type Store from 'electron-store'
import { WINDOW_SIZES } from '../../shared/constants'

interface SavedBounds {
  x: number
  y: number
  width: number
  height: number
}

export class MainWindow {
  private win: BrowserWindow | null = null
  private boundsSaveTimer: NodeJS.Timeout | null = null

  constructor(private store: Store) {}

  /**
   * Возвращает сохранённые bounds окна, если они валидны (пересекаются
   * с рабочей областью хотя бы одного дисплея). Иначе undefined —
   * используем дефолт WINDOW_SIZES.main.
   */
  private getValidatedBounds(): SavedBounds | undefined {
    const saved = this.store.get('windowBounds') as SavedBounds | undefined
    if (!saved || typeof saved !== 'object') return undefined
    const { x, y, width, height } = saved
    if (
      typeof x !== 'number' || typeof y !== 'number' ||
      typeof width !== 'number' || typeof height !== 'number' ||
      width < 1000 || height < 700
    ) return undefined

    // Проверяем, что окно попадает на какой-то из подключённых дисплеев.
    // Если монитор отключили/сменили разрешение — saved bounds могут
    // оказаться за пределами видимой области, в таком случае откатываемся.
    try {
      const displays = screen.getAllDisplays()
      const intersects = displays.some(d => {
        const wa = d.workArea
        // Простая проверка пересечения прямоугольников
        return (
          x < wa.x + wa.width &&
          x + width > wa.x &&
          y < wa.y + wa.height &&
          y + height > wa.y
        )
      })
      if (!intersects) return undefined
    } catch {
      return undefined
    }
    return saved
  }

  create(): BrowserWindow {
    const saved = this.getValidatedBounds()
    this.win = new BrowserWindow({
      width: saved?.width ?? WINDOW_SIZES.main.width,
      height: saved?.height ?? WINDOW_SIZES.main.height,
      x: saved?.x,
      y: saved?.y,
      minWidth: 1000,
      minHeight: 700,
      resizable: true,
      frame: false,
      titleBarStyle: 'hidden',
      backgroundColor: '#1a1a1a',
      show: false,
      skipTaskbar: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })

    // Открывать внешние ссылки в браузере
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })

    // Сохраняем bounds окна при resize/move (с debounce — drag/resize
    // генерирует множество событий, не хотим дёргать electron-store на каждый).
    this.win.on('resize', () => this.scheduleSaveBounds())
    this.win.on('move', () => this.scheduleSaveBounds())

    // При закрытии — прятаться в трей
    this.win.on('close', (e) => {
      e.preventDefault()
      this.win?.hide()
    })

    this.win.on('closed', () => {
      if (this.boundsSaveTimer) {
        clearTimeout(this.boundsSaveTimer)
        this.boundsSaveTimer = null
      }
      this.win = null
    })

    // Загружаем renderer
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      this.win.loadURL(process.env['ELECTRON_RENDERER_URL'])
      this.win.webContents.openDevTools()
    } else {
      this.win.loadFile(join(__dirname, '../renderer/index.html'))
      // В дебаг режиме открываем DevTools
      if (process.argv.includes('--inspect') || process.argv.some(a => a.startsWith('--inspect='))) {
        this.win.webContents.openDevTools({ mode: 'detach' })
      }
    }

    return this.win
  }

  show(): void {
    if (!this.win) return
    this.win.show()
    this.win.focus()
  }

  hide(): void {
    this.win?.hide()
  }

  toggle(): void {
    if (!this.win) return
    if (this.win.isVisible()) {
      this.win.hide()
    } else {
      this.win.show()
      this.win.focus()
    }
  }

  minimize(): void {
    this.win?.minimize()
  }

  getWindow(): BrowserWindow | null {
    return this.win
  }

  /**
   * Debounce-сохранение bounds в electron-store. Resize/move генерируют
   * десятки событий в секунду во время drag — без debounce диск бы
   * дёргался на каждое событие (electron-store пишет JSON на диск).
   */
  private scheduleSaveBounds(): void {
    if (this.boundsSaveTimer) clearTimeout(this.boundsSaveTimer)
    this.boundsSaveTimer = setTimeout(() => {
      this.boundsSaveTimer = null
      this.saveBoundsNow()
    }, 500)
  }

  /**
   * Немедленная запись bounds в store. Вызывается из scheduleSaveBounds
   * по таймеру, а также из app.on('before-quit') при реальном выходе
   * из приложения (обычный close уходит в трей, не доходя до этой точки).
   */
  flushBounds(): void {
    if (this.boundsSaveTimer) {
      clearTimeout(this.boundsSaveTimer)
      this.boundsSaveTimer = null
    }
    this.saveBoundsNow()
  }

  private saveBoundsNow(): void {
    if (!this.win || this.win.isDestroyed()) return
    try {
      // Если окно максимизировано — getBounds() вернёт "растянутые"
      // размеры; всё равно сохраняем, при восстановлении окно откроется
      // в этих габаритах, что приемлемо.
      this.store.set('windowBounds', this.win.getBounds())
    } catch { /* окно могло быть уничтожено в момент записи */ }
  }
}
