// §rollback — чистая логика «КАКОЕ состояние файла восстанавливать» при
// откате правок AI.
//
// Проблема, которую решает модуль: undoStack агента пишет ОДНУ запись на
// КАЖДУЮ правку, поэтому файл, изменённый 3 раза за turn, даёт 3 строки в
// file_snapshots с тремя разными content_before:
//
//   rowid 1: contentBefore = A (состояние до turn'а)      ← нужное для undo
//   rowid 2: contentBefore = B (после первой правки)
//   rowid 3: contentBefore = C (после второй правки)
//
// Откат обязан вернуть A — состояние ДО первой правки файла в turn'е. Раньше
// обработчики применяли ВСЕ строки подряд в порядке выборки, и «победителем»
// оказывалась последняя применённая: при ORDER BY id DESC (id — uuid v4,
// хронологии не несёт) это было случайное промежуточное состояние B/C, т.е.
// файл оставался сломанным.
//
// Правило: для каждого РЕЗОЛВНУТОГО пути берём ПЕРВУЮ строку в порядке
// выполнения правок (rowid ASC) и восстанавливаем ровно её. Порядок строк
// задаёт SQL (ORDER BY rowid ASC), модуль только дедуплицирует.
//
// Модуль без зависимостей (кроме path) — тестируется офлайн,
// импортируется chatCheckpoint.ipc.ts. См. scripts/checkpoints.test.cjs.

import { isAbsolute, resolve, sep } from 'path'

export interface SnapshotLike {
  path: string
  contentBefore: string | null
}

/**
 * Ключ сравнения путей: резолв в абсолютный + единые разделители + lowercase
 * для Windows-путей (регистронезависимая ФС). Без lowercase на POSIX-подобных
 * путях, чтобы не склеить два разных файла, отличающихся регистром.
 */
export function snapshotPathKey(p: string, workdir?: string): string {
  let abs = p
  try {
    abs = isAbsolute(p) ? p : resolve(workdir ?? process.cwd(), p)
  } catch {
    abs = p
  }
  const unified = abs.split(sep).join('/')
  return /^[a-zA-Z]:\//.test(unified) || unified.startsWith('//') ? unified.toLowerCase() : unified
}

/**
 * Оставляет по одной записи на файл — ПЕРВУЮ в порядке выполнения правок.
 *
 * rows обязаны быть отсортированы по возрастанию rowid (порядок INSERT'ов,
 * т.е. хронология правок внутри turn'а). Возвращает записи в порядке первого
 * появления файла, с ОРИГИНАЛЬНЫМ (нерозолвнутым) path первой строки — чтобы
 * вызывающий код писал в БД/лог ровно тот путь, что пришёл из снапшота.
 *
 * Используется:
 *  - undo правок turn'а (восстановить состояние до первой правки);
 *  - rewind к turn'у N: снапшоты последующих turn'ов ASC → первая запись по
 *    пути = состояние файла на конец turn'а N.
 */
export function firstSnapshotPerPath<T extends SnapshotLike>(
  rows: T[],
  workdir?: string,
): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const row of rows) {
    const key = snapshotPathKey(row.path, workdir)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

/**
 * Выбирает источник снапшотов для checkpoint'а.
 *
 * Live-поток — источник истины: он содержит хронологию ВСЕХ правок, включая
 * правки саб-агентов, которые произошли после того, как основной Agent собрал
 * свой локальный undoStack. Финальный список Agent нужен как fallback для
 * старых/неполных worker-путей, где live-сообщения ещё не стримились.
 *
 * Это важно для сценария `spawn_agent`: финальный undoStack родителя не знает
 * о merge worktree, а `live` уже содержит и родительские, и добавленные main-
 * процессом снапшоты саб-агента.
 */
export function pickSnapshots(
  live: SnapshotLike[] | undefined,
  finalList: SnapshotLike[] | undefined,
): SnapshotLike[] {
  if (live && live.length > 0) return live
  return finalList ?? []
}
