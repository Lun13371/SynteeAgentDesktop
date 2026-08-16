import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

export class OverlayWindow {
  private win: BrowserWindow | null = null

  create(): BrowserWindow {
    if (this.win) return this.win // idempotent — lazy creation
    const { x, y, width, height } = this.getTotalBounds()

    this.win = new BrowserWindow({
      x, y, width, height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: true,
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })

    this.win.setAlwaysOnTop(true, 'screen-saver')
    this.win.setVisibleOnAllWorkspaces(true)

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      this.win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#/overlay')
    } else {
      this.win.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/overlay' })
    }

    // Закрыть по Escape обрабатывается в renderer
    return this.win
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
    if (!this.win) this.create() // lazy creation on first show
    if (!this.win) return
    this.win.show()
    this.win.focus()
  }

  hide(): void {
    if (!this.win) return
    this.win.hide()
  }

  getDisplaysInfo() {
    const primary = screen.getPrimaryDisplay()
    return screen.getAllDisplays().map(d => ({
      id: d.id,
      bounds: d.bounds,
      scaleFactor: d.scaleFactor,
      isPrimary: d.id === primary.id,
    }))
  }

  getWindow(): BrowserWindow | null {
    return this.win
  }
}
