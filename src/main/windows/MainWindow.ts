import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import type Store from 'electron-store/ts'
import { WINDOW_SIZES } from '../../shared/constants'

export class MainWindow {
  private win: BrowserWindow | null = null

  constructor(private store: Store) {}

  create(): BrowserWindow {
    this.win = new BrowserWindow({
      width: WINDOW_SIZES.main.width,
      height: WINDOW_SIZES.main.height,
      minWidth: 1000,
      minHeight: 700,
      resizable: false,
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

    // При закрытии — прятаться в трей
    this.win.on('close', (e) => {
      e.preventDefault()
      this.win?.hide()
    })

    // Загружаем renderer
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      this.win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      this.win.loadFile(join(__dirname, '../renderer/index.html'))
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
}
