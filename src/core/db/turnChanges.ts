// ── TurnChanges — ЕДИНЫЙ источник статистики правок запроса ────────────────
//
// Один модуль считает «что изменил этот запрос» для ВСЕХ потребителей UI:
//   - ChangesBadge над инпутом (chat:getLastTurnChanges / chat:getTurnChanges);
//   - правая панель «Сессия» — таймлайн и чипы файлов ЛЮБОГО чекпоинта
//     (chat:getSessionTurnChanges);
//   - diff-панель «Сессии» (chat:getCheckpointFileDiffs).
//
// Семантика — КУМУЛЯТИВНЫЙ дифф за весь запрос (как Claude Code/Cursor):
// один файл = один дифф «до первой правки → после последней», сколько бы
// edit_file вызовов ни было. Строка, переправленная дважды за запрос,
// считается один раз — цифры не «прыгают» между местами и не зависят от
// числа промежуточных правок.
//
// Источники:
//   Основной  — file_snapshots turn'а («до» = contentBefore первой правки
//               файла; «после» = contentBefore первого снапшота следующего
//               turn'а, тронувшего файл, иначе файл на диске).
//   Fallback  — toolSteps assistant-сообщения через collectFileChanges
//               (shared/fileChanges.ts) для старых turn'ов без снапшотов.
//               Тот же парсер, что у чипов в конце сообщения, — при
//               отсутствии снапшотов цифры совпадают с ними.
//
// До вынесения сюда логика диффов и подсчёта дублировалась в
// chatCheckpoint.ipc.ts (getLastTurnChanges со своей копией парсинга шагов,
// отличавшейся проверкой success и извлечением пути) — расхождения цифр
// между бейджем, «Сессией» и чипами сообщения росли из этих копий.

import { existsSync, readFileSync, statSync } from 'fs'
import { makeDiff, normalizeLineEndings } from '../tools/_shared'
import { collectFileChanges, countDiffLines } from '../../shared/fileChanges'
import {
  getCheckpoints, getTurnSnapshotsOrdered, getLaterTurnSnapshots,
  type CheckpointMeta, type FileSnapshotRow,
} from './checkpoints'
import { resolveSnapshotPath } from './snapshotPaths'
import { getChatWorkdirContext } from './chats'
import { getMessageById } from './messages'

/** Потолок размера файла для подсчёта диффа: гигантские артефакты (сборка,
 *  локи) не должны подвешивать подсчёт LCS на партии по всем чекпоинтам. */
const MAX_DIFF_FILE_BYTES = 512 * 1024

/** Per-file изменение запроса: counts + признаки «создан»/«нет на диске». */
export interface TurnFileChange {
  path: string
  added: number
  deleted: number
  /** contentBefore = null в снапшоте — файла до запроса не существовало. */
  created: boolean
  /** Файла нет на диске в момент подсчёта — удалён в ходе/после запроса.
   *  created && removed = «создан и удалён»: кумулятивный дифф пуст,
   *  честные цифры достаются из шагов сообщения (см. computeTurnChanges). */
  removed: boolean
}

/** Статистика правок одного запроса (turn'а). Совместима с LastTurnChanges. */
export interface TurnChanges {
  files: TurnFileChange[]
  totalAdded: number
  totalDeleted: number
  userMessageId: string
  assistantMessageId: string
}

/** Per-file дифф с содержимым — для diff-панели «Сессии» (Monaco). */
export interface CheckpointFileDiff {
  filePath: string
  original: string
  modified: string
  added: number
  deleted: number
  created: boolean
  removed: boolean
}

/** Резолв пути снапшота против workdir чата — единый для всех сравнений. */
function chatSnapshotPath(chatId: string, p: string): string {
  let workdir: string | undefined
  try { workdir = getChatWorkdirContext(chatId).workdir } catch { /* нет чата/БД — fallback на cwd */ }
  return resolveSnapshotPath(p, workdir)
}

/** Контент не больше потолка — иначе подсчёт строк для этого файла = 0. */
function withinSizeCap(absPath: string, text: string): boolean {
  // Для дискового файла проверяем размер на диске; для строк из БД — длину.
  try {
    if (statSync(absPath).size > MAX_DIFF_FILE_BYTES) return false
  } catch { /* нет файла — проверяем только длину строки */ }
  return text.length <= MAX_DIFF_FILE_BYTES
}

/**
 * Кумулятивные per-file диффы turn'а (с содержимым «до/после»).
 *
 * «До»    — file_snapshots этого turn'а, первая строка по резолвнутому пути
 *           (rowid ASC = порядок правок).
 * «После» — первый снапшот СЛЕДУЮЩЕГО turn'а, тронувшего этот файл (его
 *           contentBefore = состояние на конец нашего turn'а), иначе —
 *           текущее содержимое на диске (последний turn, тронувший файл).
 *
 * Пустой массив → у turn'а нет снапшотов (старые чаты) → вызывающий
 * использует fallback по toolSteps (computeTurnChanges делает это сам).
 */
export function computeCheckpointFileDiffs(chatId: string, userMessageId: string): CheckpointFileDiff[] {
  const turnSnaps = getTurnSnapshotsOrdered(chatId, userMessageId)
  if (turnSnaps.length === 0) return []

  // «до»: первая запись по резолвнутому пути (матчинг относительных/абсолютных
  // путей старых и новых снапшотов — через резолв против workdir чата).
  const beforeByPath = new Map<string, FileSnapshotRow>()
  for (const s of turnSnaps) {
    const key = chatSnapshotPath(chatId, s.path)
    if (!beforeByPath.has(key)) beforeByPath.set(key, s)
  }

  // «после»: первый снапшот последующего turn'а по тому же резолвнутому пути.
  const afterByPath = new Map<string, FileSnapshotRow>()
  for (const s of getLaterTurnSnapshots(chatId, userMessageId)) {
    const key = chatSnapshotPath(chatId, s.path)
    if (!afterByPath.has(key)) afterByPath.set(key, s)
  }

  const result: CheckpointFileDiff[] = []
  for (const [key, snap] of beforeByPath) {
    const before = snap.contentBefore ?? ''
    const existsNow = existsSync(key)
    let after: string
    const later = afterByPath.get(key)
    if (later) {
      // Следующий turn уже трогал файл: его contentBefore = наш «после».
      // null = файла не было к началу следующего turn'а (удалён после нашего).
      after = later.contentBefore ?? ''
    } else if (existsNow) {
      try { after = readFileSync(key, 'utf-8') } catch { after = before }
    } else {
      after = '' // файла нет на диске — удалён в этом/позже этого turn'а
    }

    const created = snap.contentBefore === null
    const removed = !existsNow

    // Потолок размера: гигантский файл не считаем (0/0), но сам файл в
    // списке оставляем — выбор диффа панели это не ломает.
    if (!withinSizeCap(key, before) || after.length > MAX_DIFF_FILE_BYTES) {
      result.push({ filePath: snap.path, original: '', modified: '', added: 0, deleted: 0, created, removed })
      continue
    }

    // Нормализуем CRLF→LF: снапшот и диск могут отличаться концами строк —
    // Monaco DiffEditor покажет phantom-дифф на каждой строке.
    // (makeDiff дополнительно нормализует оба контента перед созданием патча.)
    const original = normalizeLineEndings(before)
    const modified = normalizeLineEndings(after)

    // added/deleted считаем из unified diff (LCS, как git) — это честный
    // кумулятивный счётчик, а не сумма per-edit счётчиков (строка, правленная
    // дважды за запрос, считалась дважды).
    const diff = makeDiff(original, modified, snap.path)
    const { adds, dels } = countDiffLines(diff)
    result.push({ filePath: snap.path, original, modified, added: adds, deleted: dels, created, removed })
  }
  return result
}

/**
 * Fallback для старых turn'ов без file_snapshots: парсим toolSteps
 * assistant-сообщения тем же парсером, что и чипы в конце сообщения
 * (collectFileChanges из shared). Пути тут — как их передал агент
 * (часто относительные), как и у путей снапшотов — матчинг с чекпоинтом
 * в UI работает в обоих случаях.
 */
function fallbackFromToolSteps(assistantMessageId: string, userMessageId: string): TurnChanges | null {
  if (!assistantMessageId) return null
  const msg = getMessageById(assistantMessageId)
  if (!msg?.toolSteps?.length) return null
  const collected = collectFileChanges(msg.toolSteps)
  if (collected.length === 0) return null
  const files = collected.map(f => ({ path: f.path, added: f.adds, deleted: f.dels, created: f.created, removed: false }))
  return {
    files,
    totalAdded: files.reduce((s, f) => s + f.added, 0),
    totalDeleted: files.reduce((s, f) => s + f.deleted, 0),
    userMessageId,
    assistantMessageId,
  }
}

/** Ключ матча путей: `C:\a\b.ts` и `c:/a/b.ts` — один файл (как в shared). */
function pathKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase()
}

/**
 * Статистика правок одного запроса — КАНонический вид для всех UI.
 *
 * @param chatId         чат
 * @param userMessageId  turn (user-сообщение); без параметра — ПОСЛЕДНИЙ
 *                       чекпоинт (поведение прежнего getLastTurnChanges:
 *                       turn без правок файлов → null).
 * Возвращает null, если у turn'а нет правок файлов.
 */
export function computeTurnChanges(chatId: string, userMessageId?: string): TurnChanges | null {
  try {
    let cp: CheckpointMeta | undefined
    if (userMessageId) {
      cp = getCheckpoints(chatId).find(c => c.userMessageId === userMessageId)
    } else {
      // Без userMessageId — СТРОГО последний чекпоинт (семантика бейджа
      // «изменения последнего запроса»): если этот turn без правок файлов,
      // возвращаем null — не подставляем более старый turn с правками,
      // иначе бейдж показывал бы чужие цифры.
      const all = getCheckpoints(chatId)
      cp = all.length > 0 ? all[all.length - 1] : undefined
      if (cp && cp.filesChanged === 0) return null
    }
    if (!cp || !cp.assistantMessageId) return null

    // ── Основной путь: кумулятивный дифф из снапшотов ──
    const diffs = computeCheckpointFileDiffs(chatId, cp.userMessageId)
    if (diffs.length > 0) {
      const files: TurnFileChange[] = diffs.map(d => ({
        path: d.filePath, added: d.added, deleted: d.deleted, created: d.created, removed: d.removed,
      }))

      // ── «Создан и удалён» — дыра кумулятивного счёта ──
      // Файл создан запросом (до = пусто) и на диске его больше нет
      // (после = пусто, напр. временный скрипт, удалённый run_command в том
      // же запросе). Снапшотный дифф = 0/0 и теряет ВСЮ работу запроса —
      // бейдж/«Сессия» показывали +0 −0, а чипы сообщения честные +69 −1.
      // Восполняем цифры из шагов сообщения (тот же парсер, что у чипов).
      const needSteps = files.some(f => f.created && f.removed && f.added === 0 && f.deleted === 0)
      if (needSteps) {
        const fb = fallbackFromToolSteps(cp.assistantMessageId, cp.userMessageId)
        if (fb) {
          // Обе стороны резолвим против workdir: шаги могут хранить
          // абсолютный путь, снапшот — относительный (и наоборот).
          const byKey = new Map(fb.files.map(x => [pathKey(chatSnapshotPath(chatId, x.path)), x]))
          for (const f of files) {
            if (!(f.created && f.removed && f.added === 0 && f.deleted === 0)) continue
            const hit = byKey.get(pathKey(chatSnapshotPath(chatId, f.path)))
            if (hit) {
              f.added = hit.added
              f.deleted = hit.deleted
            }
          }
        }
      }

      return {
        files,
        totalAdded: files.reduce((s, f) => s + f.added, 0),
        totalDeleted: files.reduce((s, f) => s + f.deleted, 0),
        userMessageId: cp.userMessageId,
        assistantMessageId: cp.assistantMessageId ?? '',
      }
    }

    // ── Fallback: старые turn'ы без снапшотов — парсинг шагов сообщения ──
    return fallbackFromToolSteps(cp.assistantMessageId, cp.userMessageId)
  } catch {
    return null
  }
}

/**
 * Статистика правок ВСЕХ чекпоинтов сессии одним вызовом — для таймлайна
 * панели «Сессия», чтобы +/- были у любого запроса, а не только у последнего.
 * Ключ — userMessageId; turn'ы без правок отсутствуют в результате.
 */
export function computeSessionTurnChanges(chatId: string): Record<string, TurnChanges> {
  const out: Record<string, TurnChanges> = {}
  try {
    for (const cp of getCheckpoints(chatId)) {
      // filesChanged === 0 не отфильтровываем: у старых turn'ов без снапшотов
      // он мог сохраниться нулевым, а правки в шагах сообщения есть — их
      // достанет fallback. computeTurnChanges сам вернёт null для пустых.
      if (!cp.assistantMessageId) continue
      const changes = computeTurnChanges(chatId, cp.userMessageId)
      if (changes && changes.files.length > 0) out[cp.userMessageId] = changes
    }
  } catch { /* пустая карта — панель покажет статы только последнего turn'а */ }
  return out
}

