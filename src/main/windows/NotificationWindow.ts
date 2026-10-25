import { BrowserWindow, screen, desktopCapturer } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

/**
 * NotificationWindow — fullscreen transparent click-through hub-окно
 * для overlay-поверхностей (уведомления, activity-виджет).
 * Владелец — OverlayManager: показ/скрытие/отправка идут через него.
 *
 * Мышь: пока окно видимо, оно всегда setIgnoreMouseEvents(true, {forward:true}) —
 * клики проходят сквозь, но mousemove форвардятся в renderer. Renderer сам
 * делает hit-testing (elementFromPoint → [data-interactive]) и шлёт
 * overlay:setInteractive → OverlayManager переключает режим через
 * setIgnoreMouseEvents(false) когда курсор над карточкой/виджетом.
 * Никакого polling-а курсора/bounds в main процессе — ноль таймеров.
 *
 * forward:true используется ТОЛЬКО когда окно видимо — на скрытом окне он
 * заставляет DWM делать hit-testing на каждое движение мыши → лаг курсора
 * по всей системе. Окно создаётся лениво, поэтому в простое forward нет.
 */
export class NotificationWindow {
  private win: BrowserWindow | null = null
  private ready = false
  /** Кэш скриншота для блюра фона карточки (base64 data URL). */
  private screenCache: string | null = null
  private screenCacheAt = 0
  /** Идёт ли фоновый захват (одна DXGI-операция за раз). */
  private capturing = false
  private refreshTimer: NodeJS.Timeout | null = null
  /** TTL кэша скриншота: содержимое рабочего стола меняется медленно. */
  private static readonly SCREEN_TTL = 30_000

  create(): BrowserWindow {
    if (this.win) return this.win
    const { x, y, width, height } = this.getTotalBounds()

    this.win = new BrowserWindow({
      x, y, width, height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: true, // focusable:true — иначе Windows НЕ отдаёт mouse events окну
      // showInactive() используется вместо show() чтобы не красть фокус
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })

    this.win.setAlwaysOnTop(true, 'screen-saver')
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // БЕЗ forward:true — forward:true заставляет DWM делать hit-testing на
    // КАЖДОЕ движение курсора, даже когда окно скрыто. Это лагает курсор по всей
    // системе. forward включается в show() — когда окно видимо.
    this.win.setIgnoreMouseEvents(true)

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      this.win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#/notifications')
    } else {
      this.win.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/notifications' })
    }

    this.win.webContents.once('did-finish-load', () => {
      this.ready = true
    })

    return this.win
  }

  warmup(): void {
    if (!this.win) this.create()
    // Прогрев кэша скриншота: к первому уведомлению блюр-фон уже готов.
    // Отложено — DXGI Desktop Duplication на старте не должен тормозить
    // загрузку главного окна.
    this.scheduleScreenRefresh(2000)
  }

  private getTotalBounds() {
    const displays = screen.getAllDisplays()
    const minX = Math.min(...displays.map(d => d.bounds.x))
    const minY = Math.min(...displays.map(d => d.bounds.y))
    const maxX = Math.max(...displays.map(d => d.bounds.x + d.bounds.width))
    const maxY = Math.max(...displays.map(d => d.bounds.y + d.bounds.height))
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  }

  show(): void {
    if (!this.win) this.create()
    if (!this.win) return
    // Идемпотентность: серия уведомлений не должна каждый раз дёргать
    // showInactive + setIgnoreMouseEvents на полноэкранном прозрачном окне
    // (переключение флагов в DWM = микро-стопоры композитора).
    if (this.win.isVisible()) return
    // Отложенный захват скриншота отменяем: пока хаб виден, в кадр попадёт
    // сама карточка (ghost в блюр-фоне). Кэш обновится после hide().
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
    this.win.showInactive()
    // forward:true на прозрачном окне НЕ лагает DWM — он проверяет альфа-канал,
    // видит #00000000 и пропускает за O(1). forward нужен чтобы mousemove
    // проходили сквозь окно → renderer получает их для hit-testing.
    this.win.setIgnoreMouseEvents(true, { forward: true })
  }

  hide(): void {
    if (!this.win) return
    // Сброс в click-through БЕЗ forward ПЕРВЫМ — на скрытом окне forward
    // лагает DWM (курсор по всей системе). Затем скрываем.
    this.win.setIgnoreMouseEvents(true)
    this.win.hide()
    // Кэш скриншота обновляем ПОСЛЕ exit-анимации карточек (иначе в кадр
    // попадёт уходящая карточка) и вне критического пути показа.
    this.scheduleScreenRefresh(700)
  }

  isReady(): boolean {
    return this.ready
  }

  setIgnoreMouseEvents(ignore: boolean): void {
    if (!this.win) return
    // forward:true когда ignore=true — mousemove проходят сквозь окно и
    // приходят в renderer (hit-testing). На прозрачном окне forward НЕ лагает
    // DWM (альфа=0 → hit-test O(1)). ignore=false — окно ловит события напрямую.
    if (ignore) {
      this.win.setIgnoreMouseEvents(true, { forward: true })
    } else {
      this.win.setIgnoreMouseEvents(false)
    }
  }

  send(channel: string, data: unknown): void {
    if (!this.win) return
    this.win.webContents.send(channel, data)
  }

  getWindow(): BrowserWindow | null {
    return this.win
  }

  // ── Кэш скриншота для блюра фона карточки ───────────────────────────
  // Захват экрана (desktopCapturer → DXGI Desktop Duplication) стопорит
  // композитор на десятки-сотни мс. Если делать его в момент показа карточки,
  // курсор дёргается ровно тогда, когда вылезает уведомление. Поэтому захват
  // вынесен из критического пути: он выполняется фоном (прогрев при старте и
  // после скрытия хаба), а renderer получает ГОТОВЫЙ кэш в том же кадре.

  /** Мгновенный ответ: показ карточки НИКОГДА не ждёт DXGI. */
  getCachedScreen(): string | null {
    return this.screenCache
  }

  /** Захват в фоне (с TTL и защитой от параллельных вызовов). */
  refreshScreenCache(): void {
    if (this.capturing) return
    // Пока хаб виден — в кадр попадёт сама карточка (ghost в блюр-фоне).
    // Кэш обновится после скрытия хаба (hide → scheduleScreenRefresh).
    if (this.win?.isVisible()) return
    if (this.screenCache && Date.now() - this.screenCacheAt < NotificationWindow.SCREEN_TTL) return
    this.capturing = true
    void this.captureScreen()
      .then((img) => {
        if (!img) return
        this.screenCache = img
        this.screenCacheAt = Date.now()
      })
      .finally(() => {
        this.capturing = false
      })
  }

  private scheduleScreenRefresh(delayMs: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      this.refreshScreenCache()
    }, delayMs)
    // Не держим event loop при выходе из приложения.
    this.refreshTimer.unref?.()
  }

  /**
   * Захватить экран и вернуть base64 для блюра фона карточки.
   * Captures the primary display and returns base64 thumbnail.
   *
   * Вызывать ТОЛЬКО из фонового пути (refreshScreenCache) — операция
   * стопорит композитор на время DXGI Desktop Duplication.
   */
  async captureScreen(): Promise<string | null> {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 640, height: 360 },
      })
      if (sources.length === 0) return null
      return sources[0].thumbnail.toDataURL()
    } catch {
      return null
    }
  }
}
