import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { WINDOW_SIZES } from '../../shared/constants'

export class SpotlightWindow {
  private win: BrowserWindow | null = null
  private isVisible = false

  create(): BrowserWindow {
    const primary = screen.getPrimaryDisplay()
    const { width: sw } = primary.workAreaSize
    const { width: ww, height: wh } = WINDOW_SIZES.spotlight
    const x = Math.round((sw - ww) / 2)
    const y = Math.round(primary.workAreaSize.height * 0.28)

    this.win = new BrowserWindow({
      x, y,
      width: ww,
      height: wh,
      minHeight: wh,
      frame: false,
      transparent: true,
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
    this.win.show()
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

  // Расширить высоту при появлении результатов
  expand(): void {
    this.win?.setSize(WINDOW_SIZES.spotlight.width, WINDOW_SIZES.spotlightExpanded.height, true)
  }

  collapse(): void {
    this.win?.setSize(WINDOW_SIZES.spotlight.width, WINDOW_SIZES.spotlight.height, true)
  }

  getWindow(): BrowserWindow | null {
    return this.win
  }
}
