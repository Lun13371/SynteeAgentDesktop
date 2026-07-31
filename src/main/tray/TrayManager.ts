import { Tray, nativeImage, app, type Rectangle } from 'electron'
import { join } from 'path'
import type { TrayMenuWindow } from '../windows/TrayMenuWindow'

interface TrayCallbacks {
  showMain: () => void
  showSpotlight: () => void
  showVoice: () => void
  quit: () => void
}

/**
 * Трей-иконка + кастомное HTML-меню.
 *
 * Раньше здесь было нативное Win32 контекст-меню (Menu.buildFromTemplate)
 * с эмодзи в лейблах — его нельзя стилизовать под клиент (тема, glass,
 * lucide-иконки). Теперь по правому клику открывается frameless
 * glass-окно TrayMenuWindow, рендерящее карточку меню на React.
 *
 * Поведение кликов:
 *  - двойной клик → показать главное окно (привычное Windows-поведение);
 *  - правый клик   → показать кастомное меню у иконки.
 */
export class TrayManager {
  private tray: Tray | null = null
  private animationInterval: NodeJS.Timeout | null = null

  constructor(
    private callbacks: TrayCallbacks,
    private menuWindow: TrayMenuWindow,
  ) {}

  init(): void {
    const iconPath = join(app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources'), 'tray-idle.png')
    let icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    if (icon.isEmpty()) {
      icon = nativeImage.createFromPath(join(app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources'), 'icon.png')).resize({ width: 16, height: 16 })
    }
    this.tray = new Tray(icon)
    this.tray.setToolTip('Syntee Helper')
    this.tray.on('double-click', () => this.callbacks.showMain())
    // Правый клик — показать кастомное HTML-меню у иконки.
    this.tray.on('right-click', (_e, bounds) => this.menuWindow.show(bounds as Rectangle | undefined))
    // На некоторых системах left-click тоже стоит обрабатывать как вызов
    // меню — но по решению пользователя левый/двойной клик открывают главное
    // окно, поэтому здесь только right-click.
  }

  // Анимация иконки при прослушивании wake word
  startListeningAnimation(): void {
    if (!this.tray) return
    const frames = ['tray-listen-1.png', 'tray-listen-2.png', 'tray-listen-3.png']
    const basePath = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources')
    let i = 0
    this.animationInterval = setInterval(() => {
      const iconPath = join(basePath, frames[i % frames.length])
      const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
      if (!icon.isEmpty()) {
        this.tray?.setImage(icon)
      }
      i++
    }, 400)
  }

  stopListeningAnimation(): void {
    if (this.animationInterval) {
      clearInterval(this.animationInterval)
      this.animationInterval = null
    }
    const iconPath = join(app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources'), 'tray-idle.png')
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    if (!icon.isEmpty()) {
      this.tray?.setImage(icon)
    }
  }

  destroy(): void {
    this.stopListeningAnimation()
    this.tray?.destroy()
  }
}
