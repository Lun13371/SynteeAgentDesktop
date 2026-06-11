import { Tray, Menu, nativeImage, app } from 'electron'
import { join } from 'path'
import type Store from 'electron-store/ts'

interface TrayCallbacks {
  showMain: () => void
  showSpotlight: () => void
  showVoice: () => void
  quit: () => void
}

export class TrayManager {
  private tray: Tray | null = null
  private animationInterval: NodeJS.Timeout | null = null

  constructor(
    private store: Store,
    private callbacks: TrayCallbacks
  ) {}

  init(): void {
    const iconPath = join(__dirname, '../../resources/tray-idle.png')
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })

    this.tray = new Tray(icon)
    this.tray.setToolTip('Syntee Helper')
    this.tray.on('double-click', () => this.callbacks.showMain())
    this.buildMenu()
  }

  private buildMenu(): void {
    const menu = Menu.buildFromTemplate([
      {
        label: '✨ Открыть Syntee',
        click: () => this.callbacks.showMain(),
        accelerator: 'CommandOrControl+Shift+Space',
      },
      {
        label: '🎤 Голосовой режим',
        click: () => this.callbacks.showVoice(),
      },
      {
        label: '🔍 Spotlight',
        click: () => this.callbacks.showSpotlight(),
      },
      { type: 'separator' },
      {
        label: '⚙️ Настройки',
        click: () => {
          this.callbacks.showMain()
        },
      },
      {
        label: `ℹ️ О программе (v${app.getVersion()})`,
        enabled: false,
      },
      { type: 'separator' },
      {
        label: '❌ Выход',
        click: () => {
          // Убираем перехват close перед выходом
          app.exit(0)
        },
      },
    ])
    this.tray?.setContextMenu(menu)
  }

  // Анимация иконки при прослушивании wake word
  startListeningAnimation(): void {
    if (!this.tray) return
    const frames = ['tray-listen-1.png', 'tray-listen-2.png', 'tray-listen-3.png']
    let i = 0
    this.animationInterval = setInterval(() => {
      const iconPath = join(__dirname, '../../resources', frames[i % frames.length])
      const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
      this.tray?.setImage(icon)
      i++
    }, 400)
  }

  stopListeningAnimation(): void {
    if (this.animationInterval) {
      clearInterval(this.animationInterval)
      this.animationInterval = null
    }
    const iconPath = join(__dirname, '../../resources/tray-idle.png')
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    this.tray?.setImage(icon)
  }

  destroy(): void {
    this.stopListeningAnimation()
    this.tray?.destroy()
  }
}
