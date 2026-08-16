import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { WINDOW_SIZES } from '../../shared/constants'

export class VoiceWindow {
  private win: BrowserWindow | null = null
  private isVisible = false

  create(): BrowserWindow {
    if (this.win) return this.win // idempotent — lazy creation
    const primary = screen.getPrimaryDisplay()
    const { width: sw, height: sh } = primary.workAreaSize
    const { width: ww, height: wh } = WINDOW_SIZES.voice

    this.win = new BrowserWindow({
      x: sw - ww - 24,
      y: sh - wh - 24,
      width: ww,
      height: wh,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: false,
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })

    this.win.setAlwaysOnTop(true, 'floating')

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      this.win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#/voice')
    } else {
      this.win.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/voice' })
    }

    return this.win
  }

  show(): void {
    if (!this.win) this.create() // lazy creation on first show
    if (!this.win) return
    this.win.show()
    this.isVisible = true
  }

  hide(): void {
    if (!this.win) return
    this.win.hide()
    this.isVisible = false
  }

  toggle(): void {
    this.isVisible ? this.hide() : this.show()
  }

  getWindow(): BrowserWindow | null {
    return this.win
  }
}
