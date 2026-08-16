/**
 * IPC для @mention-пикера и вложений.
 *
 * Каналы:
 *   mentions:search       — поиск по files + skills + commands (плоский список).
 *                           Параметр: { workdir?, query, chatId? }.
 *   mentions:startIndexing — запустить file indexer для workdir.
 *   mentions:stopIndexing  — остановить.
 *
 *   attachments:readFile  — прочитать текстовый файл для инлайна в content.
 *                           Параметр: { path }. Возвращает { content, mime, size, error? }.
 *   attachments:saveImageFromBase64 — сохранить pasted/dropped картинку в
 *                           userData/draft-attachments/{chatId}/ и вернуть путь.
 *   attachments:saveFileFromPath — скопировать произвольный файл с диска в
 *                           userData/draft-attachments/{chatId}/ (для drag&drop
 *                           файлов не из workdir). Возвращает путь.
 *   attachments:deleteFile — удалить файл вложения из userData.
 *   attachments:pickFile  — native dialog Electron (кнопка «Прикрепить файл»).
 *
 *   draft:getAttachments  — получить вложения черновика чата.
 *   draft:setAttachments  — заменить все вложения черновика (debounce в renderer).
 *   draft:clearAttachments — очистить после отправки.
 */
import { ipcMain, app, dialog } from 'electron'
import { join, basename, extname } from 'path'
import { readFile, mkdir, writeFile, unlink, stat, copyFile } from 'fs/promises'
import { existsSync } from 'fs'
import { getSkillManager } from '../../core/skills/skillManager'
import { getCommandManager } from '../../core/commands/commandManager'
import {
  startIndexing, stopIndexing, searchFiles, getRecentFiles, isIndexReady,
} from '../../core/mentions/fileIndexer'
import {
  getDraftAttachments, setDraftAttachments, clearDraftAttachments,
} from '../../core/db'
import type { MentionItem, Attachment } from '../../shared/types'
import { filterMentions, isTextMime, mimeFromExt } from '../../shared/mentions'

// ── Лимиты ───────────────────────────────────────────────────────────────────
const MAX_TEXT_INLINE_BYTES = 5 * 1024 * 1024  // 5МБ
const MAX_IMAGE_BYTES = 10 * 1024 * 1024       // 10МБ
const MAX_ATTACHMENTS = 10

function draftDir(chatId: string): string {
  return join(app.getPath('userData'), 'draft-attachments', chatId)
}

/** Собирает скиллы + команды в плоский MentionItem[] для @пикера. */
function collectInternalItems(workdir?: string): MentionItem[] {
  const items: MentionItem[] = []

  // Скиллы
  try {
    const mgr = getSkillManager()
    const skills = mgr.getAllWithState({ projectWorkdir: workdir })
    for (const s of skills) {
      items.push({
        id: `skill:${s.id}`,
        type: 'skill',
        label: s.name,
        description: s.description,
        skillId: s.id,
      })
    }
  } catch { /* skillManager ещё не инициализирован */ }

  // Кастомные команды (.md из .syntee/commands, userData/commands, resources/commands)
  try {
    const cmds = getCommandManager().getAllForUI({ projectWorkdir: workdir })
    for (const c of cmds) {
      items.push({
        id: `command:${c.name}`,
        type: 'command',
        label: c.label || `/${c.name}`,
        description: c.description,
        commandName: c.name,
      })
    }
  } catch { /* commandManager ещё не инициализирован */ }

  return items
}

export function registerMentionsIPC(): void {
  // ── mentions:search — главный канал для @пикера ───────────────────────────
  // Возвращает плоский MentionItem[]: файлы проекта (если workdir) + скиллы +
  // команды, отфильтрованные через filterMentions. При пустом query — недавние
  // файлы + все скиллы/команды (первые N).
  ipcMain.handle('mentions:search', async (_e, params: { workdir?: string; query: string; limit?: number }) => {
    const { workdir, query = '', limit = 30 } = params
    const allItems: MentionItem[] = []

    // 1. Файлы проекта (если workdir и индекс готов)
    if (workdir) {
      if (!isIndexReady(workdir)) {
        // Запускаем индексацию в фоне — при следующем вызове будет готов
        void startIndexing(workdir)
      }
      const fileItems = query
        ? searchFiles(workdir, query, limit)
        : getRecentFiles(workdir, Math.min(limit, 20))
      allItems.push(...fileItems)
    }

    // 2. Скиллы + команды (всегда — они маленькие списки)
    allItems.push(...collectInternalItems(workdir))

    // 3. Фильтруем и сортируем общий список
    if (!query) {
      // Без query — недавние файлы сверху, потом скиллы, потом команды
      return allItems.slice(0, limit)
    }
    return filterMentions(query, allItems, limit)
  })

  // ── mentions:startIndexing — запустить индексацию workdir ─────────────────
  ipcMain.handle('mentions:startIndexing', async (_e, workdir: string) => {
    if (!workdir) return false
    void startIndexing(workdir)
    return true
  })

  // ── mentions:stopIndexing — остановить индексацию ─────────────────────────
  ipcMain.handle('mentions:stopIndexing', async (_e, workdir: string) => {
    if (!workdir) return false
    await stopIndexing(workdir)
    return true
  })

  // ── attachments:readFile — прочитать файл для инлайна в content ───────────
  // Только текстовые файлы. Бинарные возвращает { isBinary: true } — для них
  // в content попадёт только путь+имя. Картинки — отдельный путь (vision Phase 2).
  ipcMain.handle('attachments:readFile', async (_e, params: { path: string }) => {
    const { path } = params
    if (!path) return { success: false, error: 'path is required' }
    try {
      const st = await stat(path)
      if (st.isDirectory()) return { success: false, error: 'Is a directory' }
      const mime = mimeFromExt(path)
      if (!isTextMime(mime)) {
        return { success: true, content: '', mime, size: st.size, isBinary: true }
      }
      if (st.size > MAX_TEXT_INLINE_BYTES) {
        return { success: false, error: `File too large (${(st.size / 1024 / 1024).toFixed(1)} MB). Max 5 MB.` }
      }
      const content = await readFile(path, 'utf-8')
      return { success: true, content, mime, size: st.size, isBinary: false }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message ?? e) }
    }
  })

  // ── attachments:saveImageFromBase64 — paste/drag&drop картинки ────────────
  // Сохраняет base64-картинку в userData/draft-attachments/{chatId}/{uuid}.ext
  // Возвращает { path, name, size, mime }. Файл удаляется при удалении чипа
  // (attachments:deleteFile) или после отправки (если не нужно сохранять).
  ipcMain.handle('attachments:saveImageFromBase64', async (_e, params: {
    chatId: string
    base64: string
    mime?: string
    suggestedName?: string
  }) => {
    const { chatId, base64 } = params
    if (!chatId || !base64) return { success: false, error: 'chatId and base64 required' }
    try {
      const dir = draftDir(chatId)
      await mkdir(dir, { recursive: true })
      // Определяем расширение по mime
      const mime = params.mime || 'image/png'
      const ext = mime === 'image/jpeg' ? '.jpg'
        : mime === 'image/gif' ? '.gif'
        : mime === 'image/webp' ? '.webp'
        : mime === 'image/bmp' ? '.bmp'
        : mime === 'image/svg+xml' ? '.svg'
        : '.png'
      const baseName = params.suggestedName || `image-${Date.now()}`
      // Защита от коллизии: если файл с таким именем уже есть (две картинки
      // с одинаковым именем при drag&drop/paste) — добавляем счётчик.
      // Без этого второй файл перезапишет первый, и оба attachment будут
      // указывать на один файл (виден только последний).
      let name = baseName + ext
      let dest = join(dir, name)
      let counter = 1
      while (existsSync(dest)) {
        name = `${baseName}-${counter}${ext}`
        dest = join(dir, name)
        counter++
      }
      // Очищаем data:URL prefix если есть
      const cleanBase64 = base64.replace(/^data:[^;]+;base64,/, '')
      const buf = Buffer.from(cleanBase64, 'base64')
      if (buf.length > MAX_IMAGE_BYTES) {
        return { success: false, error: `Image too large (${(buf.length / 1024 / 1024).toFixed(1)} MB). Max 10 MB.` }
      }
      await writeFile(dest, buf)
      return { success: true, path: dest, name, size: buf.length, mime }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message ?? e) }
    }
  })

  // ── attachments:saveFileFromPath — копирует файл с диска в draft-attachments ─
  // Для drag&drop файлов не из workdir (чтобы пережили рестарт и не зависели
  // от исходного пути). Для файлов из workdir — НЕ копируем, храним только path.
  ipcMain.handle('attachments:saveFileFromPath', async (_e, params: {
    chatId: string
    sourcePath: string
  }) => {
    const { chatId, sourcePath } = params
    if (!chatId || !sourcePath) return { success: false, error: 'chatId and sourcePath required' }
    try {
      const st = await stat(sourcePath)
      if (st.isDirectory()) return { success: false, error: 'Is a directory' }
      const dir = draftDir(chatId)
      await mkdir(dir, { recursive: true })
      const name = basename(sourcePath)
      // Уникальное имя если уже есть
      let dest = join(dir, name)
      let counter = 1
      while (existsSync(dest)) {
        const ext = extname(name)
        const base = name.slice(0, name.length - ext.length)
        dest = join(dir, `${base}-${counter}${ext}`)
        counter++
      }
      await copyFile(sourcePath, dest)
      return { success: true, path: dest, name: basename(dest), size: st.size, mime: mimeFromExt(name) }
    } catch (e) {
      return { success: false, error: String((e as Error)?.message ?? e) }
    }
  })

  // ── attachments:deleteFile — удалить файл вложения из userData ────────────
  // Безопасно: удаляем только из draft-attachments директории.
  ipcMain.handle('attachments:deleteFile', async (_e, params: { path: string }) => {
    const { path } = params
    if (!path) return false
    const allowedRoot = join(app.getPath('userData'), 'draft-attachments')
    if (!path.startsWith(allowedRoot)) return false // защита от path traversal
    try {
      await unlink(path)
      return true
    } catch {
      return false
    }
  })

  // ── attachments:pickFile — native dialog Electron ─────────────────────────
  // Кнопка «Прикрепить файл» в +меню. Открывает нативный файл-пикер.
  // Возвращает массив выбранных путей (или пустой массив при отмене).
  ipcMain.handle('attachments:pickFile', async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        title: 'Прикрепить файлы',
      })
      return result.filePaths
    } catch {
      return []
    }
  })

  // ── draft:getAttachments — вложения черновика чата ────────────────────────
  ipcMain.handle('draft:getAttachments', (_, chatId: string) => {
    if (!chatId) return []
    return getDraftAttachments(chatId)
  })

  // ── draft:setAttachments — заменить все вложения черновика ────────────────
  // Вызывается при каждом изменении набора чипов над инпутом (debounce в renderer).
  ipcMain.handle('draft:setAttachments', (_, chatId: string, attachments: Attachment[]) => {
    if (!chatId) return false
    // Лимит — не больше MAX_ATTACHMENTS
    const limited = attachments.slice(0, MAX_ATTACHMENTS)
    setDraftAttachments(chatId, limited)
    return true
  })

  // ── draft:clearAttachments — очистить после отправки ──────────────────────
  ipcMain.handle('draft:clearAttachments', (_, chatId: string) => {
    if (!chatId) return false
    clearDraftAttachments(chatId)
    return true
  })
}

/** Останавливает все индексы — вызывается при выходе из приложения. */
export async function shutdownMentions(): Promise<void> {
  // stopAllIndexing экспортируется из fileIndexer
  const { stopAllIndexing } = await import('../../core/mentions/fileIndexer')
  await stopAllIndexing()
}
