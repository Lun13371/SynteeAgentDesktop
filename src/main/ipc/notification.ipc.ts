import { ipcMain } from 'electron'
import type { NotificationWindow } from '../windows/NotificationWindow'
import type { MainWindow } from '../windows/MainWindow'
import { IPC_EVENTS } from '../../shared/constants'
import type { NotificationPayload } from '../../shared/types'

/**
 * registerNotificationIPC — IPC-хендлеры для overlay-уведомлений.
 *
 * Click-through: hit-testing в MAIN процессе (polling cursor position).
 * Renderer отправляет bounds карточек через notification:updateBounds.
 * Main процесс каждые 16ms проверяет курсор и toggling setIgnoreMouseEvents.
 */
export function registerNotificationIPC(
  notificationWindow: NotificationWindow,
  mainWindow: MainWindow,
  onAction?: (payload: { id: string; actionId: string; type: string; chatId?: string }) => void,
): void {
  ipcMain.handle('notification:show', () => {
    notificationWindow.show()
  })

  ipcMain.handle('notification:hide', () => {
    notificationWindow.hide()
  })

  ipcMain.on('notification:setIgnoreMouseEvents', (_, ignore: boolean) => {
    notificationWindow.setIgnoreMouseEvents(ignore)
  })

  // Renderer отправляет bounds карточек (экранные координаты)
  ipcMain.on('notification:updateBounds', (_, bounds: Array<{ x: number; y: number; w: number; h: number }>) => {
    notificationWindow.updateCardBounds(bounds)
  })

  // Renderer просит начать/остановить tracking
  ipcMain.on('notification:startTracking', () => {
    notificationWindow.startTracking()
  })

  ipcMain.on('notification:stopTracking', () => {
    notificationWindow.stopTracking()
  })

  // Захват экрана для блюра фона карточки
  ipcMain.handle('notification:captureScreen', async () => {
    return notificationWindow.captureScreen()
  })

  ipcMain.on(IPC_EVENTS.NOTIFICATION_ACTION, (_, payload: { id: string; actionId: string; type: string; chatId?: string; reqId?: string }) => {
    if (payload.actionId === 'open' || payload.actionId === 'expand') {
      mainWindow.show()
    }
    onAction?.(payload)
  })
}

/**
 * Отправить уведомление в overlay-окно.
 */
export function pushNotification(
  notificationWindow: NotificationWindow,
  payload: NotificationPayload,
): void {
  const win = notificationWindow.getWindow()
  if (!win) {
    notificationWindow.create()
  }
  notificationWindow.show()
  const w = notificationWindow.getWindow()
  w?.webContents.send(IPC_EVENTS.NOTIFICATION_PUSH, payload)
}
