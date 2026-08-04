import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { WINDOW_SIZES } from '../../shared/constants'

export class SpotlightWindow {
  private win: BrowserWindow | null = null
  private isVisible = false

  create(): BrowserWindow {
    const primary = screen.getPrimaryDisplay()
    const { width: sw, height: sh, y: waY } = primary.workArea
    const { width: ww, height: wh } = WINDOW_SIZES.spotlight
    // Центрируем окно по горизонтали и вертикали рабочей области.
    // Y считаем от верха workArea (y может быть >0 если таскбар сверху).
    const x = Math.round((sw - ww) / 2)
    const y = waY + Math.round((sh - wh) / 2)

    this.win = new BrowserWindow({
      x, y,
      width: ww,
      height: wh,
      minHeight: wh,
      frame: false,
      transparent: true,
      // На Windows transparent:true без явного прозрачного backgroundColor
      // может оставлять чёрный/белый фон окна. Явно задаём RGBA(0,0,0,0).
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })

    this.win.setAlwaysOnTop(true, 'floating')

    // Закрыть при потере фокуса
    this.win.on('blur', () => this.hide())

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      this.win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#/spotlight')
    } else {
      this.win.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/spotlight' })
    }

    return this.win
  }

  show(quickMode = false): void {
    if (!this.win) return
    this.win.webContents.send('spotlight:mode', quickMode ? 'quick' : 'normal')
    // Сначала показываем окно, потом центрируем. На Windows setPosition/
    // setSize на СКРЫТОМ transparent-окне могут не примениться — поэтому
    // при первом открытии окно появлялось не по центру, а в позиции create().
    // После show() setBounds срабатывает надёжно.
    this.win.show()
    this.recenter(WINDOW_SIZES.spotlight.height)
    this.win.focus()
    this.isVisible = true
  }

  showQuick(): void {
    this.show(true)
  }

  hide(): void {
    this.win?.hide()
    this.isVisible = false
  }

  toggle(): void {
    this.isVisible ? this.hide() : this.show()
  }

  // Пересчитать позицию окна так, чтобы оно оставалось по центру рабочей
  // области при изменении высоты (expand/collapse). setSize сам по себе
  // сохраняет верхнюю-левую точку → окно «уезжает» вверх при росте высоты.
  // Используем setBounds (атомарно позиция+размер) вместо раздельных
  // setPosition + setSize — надёжнее на Windows для transparent-окон.
  private recenter(h: number): void {
    if (!this.win) return
    const primary = screen.getPrimaryDisplay()
    const { width: sw, height: sh, y: waY } = primary.workArea
    const ww = WINDOW_SIZES.spotlight.width
    const x = Math.round((sw - ww) / 2)
    const y = waY + Math.round((sh - h) / 2)
    this.win.setBounds({ x, y, width: ww, height: h }, false)
  }

  // Расширить высоту при появлении результатов
  expand(): void {
    this.recenter(WINDOW_SIZES.spotlightExpanded.height)
  }

  collapse(): void {
    this.recenter(WINDOW_SIZES.spotlight.height)
  }

  getWindow(): BrowserWindow | null {
    return this.win
  }
}
