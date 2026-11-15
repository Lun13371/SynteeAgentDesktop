import { ipcMain, BrowserWindow } from 'electron'
import { v4 as uuid } from 'uuid'
import { IPC_EVENTS } from '../../shared/constants'
import {
  getCheckpoints, getLastCheckpoint, getMessages, getSnapshotsForCheckpoint, getConsumedPerFileUndoPaths,
  getContextSnapshot, setWorkingMemory, setChatSummary, deleteMessagesAfter, getMessageCount,
  deleteCheckpointsAfter, saveMessage, saveRewindHistory, getRewindHistory, deleteRewindHistory,
  deleteMessageById, getLastRewindMessage, getChatWorkdirContext, getDB,
  getLaterTurnSnapshots,
  computeCheckpointFileDiffs, computeTurnChanges, computeSessionTurnChanges,
} from '../../core/db'
import { resolveSnapshotPath } from '../../core/db/snapshotPaths'
import { firstSnapshotPerPath } from '../../core/db/snapshotMerge'
import { slimMessagesForUI } from './slimMessages'
import { activeRuns } from './chatShared'
import { log } from '../../core/logger'
import type { Message } from '../../shared/types'

export interface CheckpointIPCWindow {
  getWindow: () => BrowserWindow | null
}

// ── Резолв пути снапшота против workdir чата ────────────────────────────────
// file_snapshots исторически (до фикса §rollback) хранили сырой путь из
// аргументов тула — часто ОТНОСИТЕЛЬНЫЙ («src/foo.ts»). Файловые операции
// (writeFileSync/unlinkSync/existsSync) в main-процессе резолвят такой путь
// против process.cwd() — папки установки приложения, а не папки проекта чата.
// Из-за этого откат «проходил» (сообщение об откате писалось), а реальные
// файлы в проекте не менялись. Чистая логика — core/db/snapshotPaths.ts.
function chatSnapshotPath(chatId: string, p: string): string {
  let workdir: string | undefined
  try { workdir = getChatWorkdirContext(chatId).workdir } catch { /* нет чата/БД — fallback на cwd */ }
  return resolveSnapshotPath(p, workdir)
}

/**
 * §rollback-order — снапшоты turn'а, по ОДНОЙ записи на файл: первая правка
 * файла в этом turn'е (rowid ASC), т.е. состояние ДО turn'а. Без дедупа
 * файл, правленный несколько раз за turn, восстанавливался в произвольное
 * промежуточное состояние (см. core/db/snapshotMerge.ts).
 */
function consumedFilePathKey(chatId: string, filePath: string): string {
  return chatSnapshotPath(chatId, filePath).replace(/\\/g, '/').toLowerCase()
}

function turnSnapshotsForUndo(chatId: string, userMessageId: string) {
  let workdir: string | undefined
  try { workdir = getChatWorkdirContext(chatId).workdir } catch { /* use fallback */ }
  const snapshots = firstSnapshotPerPath(getSnapshotsForCheckpoint(chatId, userMessageId), workdir)
  const db = getDB()
  const consumed = new Set((db.prepare(`
    SELECT path_key as pathKey FROM per_file_undo_consumed WHERE chat_id = ? AND user_message_id = ?
  `).all(chatId, userMessageId) as Array<{ pathKey: string }>).map(row => row.pathKey))
  return snapshots.filter(s => !consumed.has(consumedFilePathKey(chatId, s.path)))
}

function consumePerFileUndo(chatId: string, userMessageId: string, filePath: string): void {
  getDB().prepare(`
    INSERT OR IGNORE INTO per_file_undo_consumed (chat_id, user_message_id, path_key, consumed_at)
    VALUES (?, ?, ?, ?)
  `).run(chatId, userMessageId, consumedFilePathKey(chatId, filePath), Date.now())
}

/**
 * §rollback-order — файлы для rewind к turn'у N: состояние каждого файла на
 * КОНЕЦ turn'а N = contentBefore первой правки в самом раннем ПОСЛЕДУЮЩЕМ
 * turn'е, тронувшем этот файл. getLaterTurnSnapshots отдаёт строки ASC
 * (created_at, rowid) и исключает строки самого turn'а N (ретраи).
 */
function laterTurnSnapshotsForRewind(chatId: string, userMessageId: string) {
  let workdir: string | undefined
  try { workdir = getChatWorkdirContext(chatId).workdir } catch { /* ok */ }
  return firstSnapshotPerPath(getLaterTurnSnapshots(chatId, userMessageId), workdir)
}

// ── Кумулятивный дифф turn'а и статистика правок ────────────────────────────
// Логика подсчёта «что изменил запрос» вынесена в ЕДИНУЮ точку —
// core/db/turnChanges.ts: кумулятивный дифф из file_snapshots (как Claude
// Code/Cursor) + fallback на toolSteps через collectFileChanges из shared.
// Её используют ВСЕ потребители: ChangesBadge, панель «Сессия» (таймлайн,
// чипы файлов любого чекпоинта и Monaco-дифф), GitTools. Здесь — только
// тонкие IPC-обёртки.

// === CHECKPOINT / REWIND ===
export function registerCheckpointIPC(mainWindow: CheckpointIPCWindow): void {
  // Возвращает таймлайн всех чекпоинтов чата (для правой панели "Сессия").
  ipcMain.handle('chat:getSessionTimeline', (_, chatId: string) => {
    try { return getCheckpoints(chatId) } catch { return [] }
  })

  // Кол-во изменённых файлов в последнем turn'е — для badge-счётчика на иконке
  // правой панели в TitleBar.
  ipcMain.handle('chat:getLastTurnFilesChanged', (_, chatId: string) => {
    try { return getLastCheckpoint(chatId)?.filesChanged ?? 0 } catch { return 0 }
  })

  // ── Изменения последнего запроса (ChangesBadge над инпутом) ──────────────
  // Единый подсчёт из core/db/turnChanges.ts: кумулятивный дифф снапшотов
  // (как Claude Code), fallback — collectFileChanges по toolSteps.
  ipcMain.handle('chat:getLastTurnChanges', (_, chatId: string) => {
    return computeTurnChanges(chatId)
  })

  // ── Изменения ЛЮБОГО запроса по его userMessageId (панель «Сессия») ──────
  ipcMain.handle('chat:getTurnChanges', (_, chatId: string, userMessageId?: string) => {
    return computeTurnChanges(chatId, userMessageId)
  })

  // ── Изменения всех чекпоинтов сессии одним вызовом ────────────────────────
  // Карта { userMessageId: TurnChanges } — таймлайн «Сессии» показывает +/-
  // у любого запроса, а не только у последнего.
  ipcMain.handle('chat:getSessionTurnChanges', (_, chatId: string) => {
    return computeSessionTurnChanges(chatId)
  })

  // ── Кумулятивные per-file диффы указанного checkpoint'а (панель «Сессия») ──
  // Один файл = один дифф за весь запрос: original = до первой правки,
  // modified = после последней (снапшот следующего turn'а или файл на диске).
  // Пустой массив → у turn'а нет снапшотов (старые чаты) → панель использует
  // fallback-парсинг step-диффов.
  ipcMain.handle('chat:getCheckpointFileDiffs', (_, chatId: string, userMessageId: string) => {
    try {
      return computeCheckpointFileDiffs(chatId, userMessageId)
    } catch (e) {
      log('[chat:getCheckpointFileDiffs] chatId=%s userMsgId=%s error=%s', chatId, userMessageId, (e as Error).message)
      return []
    }
  })

  ipcMain.handle('chat:getConsumedPerFileUndoPaths', (_, chatId: string, userMessageId: string) => {
    try {
      let workdir: string | undefined
      try { workdir = getChatWorkdirContext(chatId).workdir } catch { /* fallback */ }
      const consumed = new Set(getConsumedPerFileUndoPaths(chatId, userMessageId))
      return firstSnapshotPerPath(getSnapshotsForCheckpoint(chatId, userMessageId), workdir)
        .filter(snapshot => consumed.has(consumedFilePathKey(chatId, snapshot.path)))
        .map(snapshot => snapshot.path)
    } catch { return [] }
  })

  // ── Undo правок файлов последнего turn'а (БЕЗ удаления сообщений) ────────
  // Восстанавливает файлы из file_snapshots последнего checkpoint'а.
  // contentBefore = null → файл был создан → удаляем. Иначе → перезаписываем.
  ipcMain.handle('chat:undoLastTurnFiles', (_, chatId: string) => {
    if (activeRuns.has(chatId)) {
      return { error: 'Чат активен — дождитесь завершения ответа.' }
    }
    try {
      const cp = getLastCheckpoint(chatId)
      if (!cp || !cp.assistantMessageId) {
        return { error: 'Нет изменений для отмены.' }
      }
      const snapshots = turnSnapshotsForUndo(chatId, cp.userMessageId)
      if (snapshots.length === 0) {
        return { error: 'Снапшоты файлов не найдены.' }
      }
      const { writeFileSync, unlinkSync, existsSync, mkdirSync } = require('fs')
      const { dirname } = require('path')
      const restored: string[] = []
      const failed: string[] = []
      for (const snap of snapshots) {
        try {
          // §rollback — снапшоты до фикса хранят относительные пути: резолвим
          // против workdir чата, иначе файлы пишутся/удаляются мимо проекта.
          const absPath = chatSnapshotPath(chatId, snap.path)
          if (snap.contentBefore === null) {
            if (existsSync(absPath)) {
              unlinkSync(absPath)
              restored.push(snap.path)
            }
          } else {
            try { mkdirSync(dirname(absPath), { recursive: true }) } catch { /* ok */ }
            writeFileSync(absPath, snap.contentBefore, 'utf-8')
            restored.push(snap.path)
          }
        } catch (e) {
          failed.push(`${snap.path}: ${(e as Error).message}`)
        }
      }
      for (const path of restored) consumePerFileUndo(chatId, cp.userMessageId, path)
      const win = BrowserWindow.getAllWindows()[0] ?? null
      win?.webContents.send(IPC_EVENTS.CHAT_FILES_RESTORED, { chatId })
      log('[chat:undoLastTurnFiles] chatId=%s restored=%d failed=%d', chatId, restored.length, failed.length)
      return { restored: restored.length, failed }
    } catch (e) {
      return { error: (e as Error).message }
    }
  })

  // ── Undo одного файла из последнего turn'а ──────────────────────────────
  // Восстанавливает один файл из file_snapshots последнего checkpoint'а.
  ipcMain.handle('chat:undoFile', (_, chatId: string, filePath: string) => {
    if (activeRuns.has(chatId)) {
      return { error: 'Чат активен — дождитесь завершения ответа.' }
    }
    try {
      const cp = getLastCheckpoint(chatId)
      if (!cp || !cp.assistantMessageId) {
        return { error: 'Нет изменений для отмены.' }
      }
      const snapshots = turnSnapshotsForUndo(chatId, cp.userMessageId)
      // §rollback — путь из renderer может не совпадать с записью в БД
      // (относительный vs абсолютный): сравниваем по резолвнутым путям.
      const wantedAbs = chatSnapshotPath(chatId, filePath)
      const snap = snapshots.find(s => s.path === filePath || chatSnapshotPath(chatId, s.path) === wantedAbs)
      if (!snap) {
        return { error: 'Файл не найден в снапшотах этого turn\'а.' }
      }
      const { writeFileSync, unlinkSync, existsSync, mkdirSync } = require('fs')
      const { dirname } = require('path')
      const absPath = chatSnapshotPath(chatId, snap.path)
      if (snap.contentBefore === null) {
        if (existsSync(absPath)) unlinkSync(absPath)
      } else {
        try { mkdirSync(dirname(absPath), { recursive: true }) } catch { /* ok */ }
        writeFileSync(absPath, snap.contentBefore, 'utf-8')
      }
      consumePerFileUndo(chatId, cp.userMessageId, snap.path)
      const win = BrowserWindow.getAllWindows()[0] ?? null
      win?.webContents.send(IPC_EVENTS.CHAT_FILES_RESTORED, { chatId })
      log('[chat:undoFile] chatId=%s path=%s', chatId, filePath)
      return { success: true }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  })

  /**
   * Откат сессии к указанному user-сообщению.
   *
   * Семантика: "вернуться к состоянию ПОСЛЕ этого turn'а" — user+assistant
   * пара этого turn'а остаётся последними сообщениями, удаляется только всё
   * что было позже. Файлы откатываются к концу этого turn'а (отменяются
   * только правки последующих turn'ов). Контекст (working_memory, summary)
   * восстанавливается из snapshot'а этого turn'а.
   *
   * Возвращает обновлённый массив сообщений чата (для обновления store в
   * renderer) или { error } если откат невозможен.
   */
  ipcMain.handle('chat:rewindTo', async (_, chatId: string, userMessageId: string) => {
    // Блокировка: нельзя откатывать пока чат активен (воркер работает).
    if (activeRuns.has(chatId)) {
      return { error: 'Чат активен — дождитесь завершения ответа перед откатом.' }
    }

    try {
      // 1. Находим checkpoint для указанного user-сообщения.
      const checkpoints = getCheckpoints(chatId)
      const cp = checkpoints.find(c => c.userMessageId === userMessageId)
      log('[chat:rewindTo] chatId=%s userMsgId=%s — checkpoints total=%d, found=%s, assistantMsgId=%s, createdAt=%d',
        chatId, userMessageId, checkpoints.length, !!cp, cp?.assistantMessageId ?? 'null', cp?.createdAt ?? 0)
      if (!cp) {
        return { error: 'Чекпоинт для этого сообщения не найден (возможно, оно было до включения фичи отката).' }
      }

      // 2. Файлы, тронутые turn'ами СТРОГО ПОСЛЕ указанного: по одной записи на
      //    файл — состояние на конец нашего turn'а (contentBefore первой правки
      //    в самом раннем последующем turn'е). Порядок детерминирован (rowid),
      //    файл, правленный несколько раз, больше не получает случайное
      //    промежуточное состояние.
      const snapshots = laterTurnSnapshotsForRewind(chatId, userMessageId)
      log('[chat:rewindTo] snapshots after checkpoint: %d', snapshots.length)

      // REDO: сохраняем текущее состояние файлов (contentAfter) до отката —
      // чтобы при отмене отката вернуть файлы обратно.
      // §rollback — пути резолвим против workdir чата (старые снапшоты в БД
      // хранят относительные пути). В redo-запись кладём резолвнутый путь,
      // чтобы восстановление redo-файлов тоже попадало в проект.
      const { readFileSync, existsSync: pathExistsBefore } = require('fs') // require: нативный import() не работает в V8-байткоде
      const fileChangesForRedo: Array<{ path: string; contentAfter: string | null }> = []
      for (const snap of snapshots) {
        const snapAbs = chatSnapshotPath(chatId, snap.path)
        try {
          if (pathExistsBefore(snapAbs)) {
            fileChangesForRedo.push({ path: snapAbs, contentAfter: readFileSync(snapAbs, 'utf-8') })
          } else {
            fileChangesForRedo.push({ path: snapAbs, contentAfter: null })
          }
        } catch {
          fileChangesForRedo.push({ path: snapAbs, contentAfter: null })
        }
      }

      // 3. Восстанавливаем файлы (по одной записи на файл, см. шаг 2).
      //    contentBefore = null → файл был создан later-turn'ом → удаляем.
      //    Иначе → перезаписываем contentBefore.
      const { writeFileSync, unlinkSync, existsSync: pathExists } = require('fs') // require: нативный import() не работает в V8-байткоде
      const restoredFiles: string[] = []
      const failedFiles: string[] = []
      for (const snap of snapshots) {
        try {
          // §rollback — относительный путь снапшота резолвим против workdir
          // чата: без этого writeFileSync/unlinkSync работали бы в папке
          // установки приложения, а файлы проекта оставались нетронутыми.
          const snapAbs = chatSnapshotPath(chatId, snap.path)
          if (snap.contentBefore === null) {
            // Файл был создан последующим turn'ом — удаляем.
            if (pathExists(snapAbs)) {
              unlinkSync(snapAbs)
              restoredFiles.push(`удалён: ${snap.path}`)
            }
          } else {
            // Перезаписываем содержимое до правки последующего turn'а.
            const { dirname } = require('path') // require: нативный import() не работает в V8-байткоде
            const { mkdirSync } = require('fs')
            try { mkdirSync(dirname(snapAbs), { recursive: true }) } catch { /* ok */ }
            writeFileSync(snapAbs, snap.contentBefore, 'utf-8')
            restoredFiles.push(`восстановлен: ${snap.path}`)
          }
        } catch (e) {
          failedFiles.push(`${snap.path}: ${(e as Error).message}`)
        }
      }

      // 4. Восстанавливаем контекст (working_memory + chat_summary) из
      //    snapshot'а этого turn'а (post-turn состояние).
      const ctxSnap = getContextSnapshot(chatId, userMessageId)
      if (ctxSnap) {
        if (ctxSnap.workingMemory !== null) setWorkingMemory(chatId, ctxSnap.workingMemory)
        if (ctxSnap.chatSummary !== null) setChatSummary(chatId, ctxSnap.chatSummary)
      }

      // 5. Удаляем сообщения после этого turn'а.
      //    Порог — createdAt assistant-сообщения этого turn'а (если найдено),
      //    иначе createdAt самого checkpoint'а (чуть позже, но до следующего turn'а).
      let deleteThreshold = cp.createdAt
      let allMsgsBeforeDelete: Message[] = []
      if (cp.assistantMessageId) {
        allMsgsBeforeDelete = getMessages(chatId)
        const assistantMsg = allMsgsBeforeDelete.find(m => m.id === cp.assistantMessageId)
        if (assistantMsg) {
          deleteThreshold = assistantMsg.createdAt
          log('[chat:rewindTo] found assistant msg: id=%s createdAt=%d', assistantMsg.id, assistantMsg.createdAt)
        } else {
          log('[chat:rewindTo] assistant msg NOT FOUND in getMessages — using checkpoint createdAt=%d as threshold', cp.createdAt)
        }
      } else {
        allMsgsBeforeDelete = getMessages(chatId)
        log('[chat:rewindTo] assistantMessageId is null — using checkpoint createdAt=%d as threshold', cp.createdAt)
      }

      // REDO: сохраняем сообщения которые будут удалены (до удаления).
      const msgsToDeleteForRedo = allMsgsBeforeDelete.filter(m => m.createdAt > deleteThreshold)

      const msgsBeforeDelete = getMessageCount(chatId)
      const deletedMessages = deleteMessagesAfter(chatId, deleteThreshold)
      log('[chat:rewindTo] messages before=%d, deleted=%d (threshold=%d)', msgsBeforeDelete, deletedMessages, deleteThreshold)

      // 6. Удаляем чекпоинты и снапшоты последующих turn'ов (они больше не валидны).
      deleteCheckpointsAfter(chatId, userMessageId)

      // 7. Вставляем синтетическое system-сообщение об откате.
      const rewindMsg: Message = {
        id: uuid(),
        chatId,
        role: 'system',
        content: `[ОТКАТ к сообщению от ${new Date(cp.createdAt).toLocaleString('ru')}]\n` +
          `Восстановлено файлов: ${restoredFiles.length}` +
          (failedFiles.length > 0 ? `, не удалось: ${failedFiles.length}` : '') + '\n' +
          `Удалено сообщений: ${deletedMessages}\n` +
          (restoredFiles.length > 0 ? `Файлы:\n${restoredFiles.join('\n')}` : 'Файлы не изменялись.') +
          (failedFiles.length > 0 ? `\nОшибки восстановления:\n${failedFiles.join('\n')}` : ''),
        createdAt: Date.now(),
        isPinned: 0,
        slashCommand: { name: 'rewind', args: userMessageId },
      }
      saveMessage(rewindMsg)

      // REDO: сохраняем redo-точку — можно отменить откат.
      try {
        saveRewindHistory(chatId, rewindMsg.id, msgsToDeleteForRedo, fileChangesForRedo, userMessageId)
        log('[chat:rewindTo] redo history saved: rewindMsgId=%s, msgsToRestore=%d, filesToRestore=%d',
          rewindMsg.id, msgsToDeleteForRedo.length, fileChangesForRedo.length)
      } catch (e) {
        log('[chat:rewindTo] redo history save FAILED: %s', (e as Error).message)
      }

      // 8. Уведомляем UI об откате.
      const rewindWin = mainWindow.getWindow()
      rewindWin?.webContents.send(IPC_EVENTS.CHAT_REWOUND, { chatId, userMessageId, rewindMessageId: rewindMsg.id })

      log('[chat:rewindTo] chatId=%s userMsgId=%s: restored %d files, deleted %d messages',
        chatId, userMessageId, restoredFiles.length, deletedMessages)

      // 9. Возвращаем обновлённые сообщения для renderer (slim-копии).
      return { messages: slimMessagesForUI(getMessages(chatId)) }
    } catch (e) {
      log('[chat:rewindTo] error chatId=%s: %s', chatId, (e as Error).message)
      return { error: `Ошибка отката: ${(e as Error).message}` }
    }
  })

  // ── Undo правок файлов любого checkpoint'а (правая панель «Сессия») ──────
  // Восстанавливает файлы из file_snapshots указанного turn'а (по userMessageId).
  ipcMain.handle('chat:undoCheckpointFiles', (_, chatId: string, userMessageId: string) => {
    if (activeRuns.has(chatId)) {
      return { error: 'Чат активен — дождитесь завершения ответа.' }
    }
    try {
      const snapshots = turnSnapshotsForUndo(chatId, userMessageId)
      if (snapshots.length === 0) {
        return { error: 'Снапшоты файлов не найдены.' }
      }
      const { writeFileSync, unlinkSync, existsSync, mkdirSync } = require('fs')
      const { dirname } = require('path')
      const restored: string[] = []
      const failed: string[] = []
      for (const snap of snapshots) {
        try {
          // §rollback — относительный путь снапшота резолвим против workdir
          // чата: без этого запись/удаление уходили в папку установки.
          const absPath = chatSnapshotPath(chatId, snap.path)
          if (snap.contentBefore === null) {
            if (existsSync(absPath)) unlinkSync(absPath)
            restored.push(snap.path)
          } else {
            try { mkdirSync(dirname(absPath), { recursive: true }) } catch { /* ok */ }
            writeFileSync(absPath, snap.contentBefore, 'utf-8')
            restored.push(snap.path)
          }
        } catch (e) {
          failed.push(`${snap.path}: ${(e as Error).message}`)
        }
      }
      for (const path of restored) consumePerFileUndo(chatId, userMessageId, path)
      const win = BrowserWindow.getAllWindows()[0] ?? null
      win?.webContents.send(IPC_EVENTS.CHAT_FILES_RESTORED, { chatId })
      log('[chat:undoCheckpointFiles] chatId=%s userMsgId=%s restored=%d failed=%d',
        chatId, userMessageId, restored.length, failed.length)
      return { restored: restored.length, failed }
    } catch (e) {
      return { error: (e as Error).message }
    }
  })

  // ── Undo одного файла указанного checkpoint'а ───────────────────────────
  ipcMain.handle('chat:undoCheckpointFile', (_, chatId: string, userMessageId: string, filePath: string) => {
    if (activeRuns.has(chatId)) {
      return { error: 'Чат активен — дождитесь завершения ответа.' }
    }
    try {
      const snapshots = turnSnapshotsForUndo(chatId, userMessageId)
      // §rollback — путь из renderer может не совпадать с записью в БД
      // (относительный vs абсолютный): сравниваем по резолвнутым путям.
      const wantedAbs = chatSnapshotPath(chatId, filePath)
      const snap = snapshots.find(s => s.path === filePath || chatSnapshotPath(chatId, s.path) === wantedAbs)
      if (!snap) {
        return { error: 'Файл не найден в снапшотах этого turn\'а.' }
      }
      const { writeFileSync, unlinkSync, existsSync, mkdirSync } = require('fs')
      const { dirname } = require('path')
      const absPath = chatSnapshotPath(chatId, snap.path)
      if (snap.contentBefore === null) {
        if (existsSync(absPath)) unlinkSync(absPath)
      } else {
        try { mkdirSync(dirname(absPath), { recursive: true }) } catch { /* ok */ }
        writeFileSync(absPath, snap.contentBefore, 'utf-8')
      }
      // §per-file-undo-no-redo — одноразовый ledger consumed хранит факт undo
      // отдельно от исторических file_snapshots: rewind остаётся целым, redo
      // для этой операции не появляется.
      consumePerFileUndo(chatId, userMessageId, snap.path)
      const win = BrowserWindow.getAllWindows()[0] ?? null
      win?.webContents.send(IPC_EVENTS.CHAT_FILES_RESTORED, { chatId })
      log('[chat:undoCheckpointFile] chatId=%s userMsgId=%s path=%s', chatId, userMessageId, filePath)
      return { success: true }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  })

  // ── Последнее rewind-сообщение (для redo-баннера в панели «Сессия») ────
  ipcMain.handle('chat:getLastRewind', (_, chatId: string) => {
    try {
      const row = getLastRewindMessage(chatId)
      if (!row) return null
      return { rewindMessageId: row.id, createdAt: row.createdAt }
    } catch {
      return null
    }
  })

  /**
   * Проверяет, доступна ли отмена отката для данного system-сообщения.
   * Возвращает true если в rewind_history есть запись с этим rewindMessageId.
   */
  ipcMain.handle('chat:canRedo', (_, chatId: string, rewindMessageId: string) => {
    try {
      return getRewindHistory(chatId, rewindMessageId) !== null
    } catch {
      return false
    }
  })

  /**
   * Отмена отката (redo) — возвращает сообщения и файлы, удалённые при rewind.
   * Принимает id system-сообщения отката (rewindMessageId) — по нему находим
   * redo-точку в rewind_history.
   */
  ipcMain.handle('chat:redo', async (_, chatId: string, rewindMessageId: string) => {
    if (activeRuns.has(chatId)) {
      return { error: 'Чат активен — дождитесь завершения ответа.' }
    }

    try {
      const entry = getRewindHistory(chatId, rewindMessageId)
      if (!entry) {
        return { error: 'Точка отката не найдена — возможно, она уже отменена или устарела.' }
      }

      log('[chat:redo] chatId=%s rewindMsgId=%s — msgsToRestore=%d, filesToRestore=%d',
        chatId, rewindMessageId, entry.deletedMessages.length, entry.fileChanges.length)

      // 1. Восстанавливаем файлы — пишем contentAfter (состояние до отката).
      const { writeFileSync, unlinkSync, existsSync: pathExists, mkdirSync } = require('fs') // require: нативный import() не работает в V8-байткоде
      const { dirname } = require('path')
      const restoredFiles: string[] = []
      const failedFiles: string[] = []
      for (const fc of entry.fileChanges) {
        try {
          // §rollback — старые redo-записи (до фикса) хранят относительные
          // пути: резолвим против workdir чата. Новые записи уже абсолютные —
          // resolveSnapshotPath их не меняет.
          const fcAbs = chatSnapshotPath(chatId, fc.path)
          if (fc.contentAfter === null) {
            // Файла не было до отката (был создан, потом удалён при rewind) → удаляем.
            if (pathExists(fcAbs)) {
              unlinkSync(fcAbs)
              restoredFiles.push(`удалён: ${fc.path}`)
            }
          } else {
            // Возвращаем содержимое которое было до отката.
            try { mkdirSync(dirname(fcAbs), { recursive: true }) } catch { /* ok */ }
            writeFileSync(fcAbs, fc.contentAfter, 'utf-8')
            restoredFiles.push(`восстановлен: ${fc.path}`)
          }
        } catch (e) {
          failedFiles.push(`${fc.path}: ${(e as Error).message}`)
        }
      }

      // 2. Удаляем system-сообщение об откате (оно больше не актуально).
      deleteMessageById(rewindMessageId)

      // 3. Восстанавливаем удалённые сообщения.
      for (const msg of entry.deletedMessages) {
        try { saveMessage(msg) } catch { /* может существовать — ok */ }
      }

      // 4. Удаляем redo-точку (одноразовая).
      deleteRewindHistory(chatId, rewindMessageId)

      // 5. Уведомляем UI.
      const redoWin = mainWindow.getWindow()
      redoWin?.webContents.send(IPC_EVENTS.CHAT_REWOUND, { chatId, userMessageId: entry.restoredCheckpointUserMsgId, isRedo: true })

      log('[chat:redo] done: restored %d files, %d messages', restoredFiles.length, entry.deletedMessages.length)

      return { messages: slimMessagesForUI(getMessages(chatId)) }
    } catch (e) {
      log('[chat:redo] error chatId=%s: %s', chatId, (e as Error).message)
      return { error: `Ошибка отмены отката: ${(e as Error).message}` }
    }
  })
}
