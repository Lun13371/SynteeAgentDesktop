/**
 * Дифф правки для отображения в карточках тулов.
 *
 * Основная реализация живёт в shared/fileChanges.ts — там же её использует
 * агрегатор «изменённые файлы сообщения» (и main-side fallback). Здесь только
 * реэкспорт, чтобы UI-компоненты не тянули shared напрямую двумя путями.
 */
export { synthesizeDiffFromArgs, countDiffLines, asArgsObject } from '../../../shared/fileChanges'

/** Совместимый с карточкой вид счётчиков (+N/−M). */
export type { DiffStat } from '../../../shared/fileChanges'
