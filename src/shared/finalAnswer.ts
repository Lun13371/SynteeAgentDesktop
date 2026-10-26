/**
 * Маркеры ИТОГОВОГО ОТВЕТА модели.
 *
 * Проблема, которую это решает: модель иногда пишет «финальный» текст, а потом
 * всё равно вызывает тул (save_memory, update_todo, run_command). Такой текст
 * попадает в `iterations[].textBefore` СЛЕДУЮЩЕЙ итерации и рендерится как
 * заметка ВНУТРИ свёрнутой ленты «хода работы» — то есть ответ как будто
 * исчезает.
 *
 * Решение: модель оборачивает итоговый ответ в <final_answer>…</final_answer>.
 * Теги невидимы в чате (strip на рендере + HTML-теги и так не рендерятся
 * markdown'ом), но по ним рендер понимает, что это ОТВЕТ, и показывает его
 * отдельным блоком под лентой — даже если после него были вызовы тулов.
 *
 * Формат выбран в стиле уже существующих <plan>/<thinking>: модель их знает,
 * а ReactMarkdown без rehype-raw не показывает сырой HTML.
 */

/** Открывающий тег итогового ответа. */
export const FINAL_OPEN = '<final_answer>'
/** Закрывающий тег итогового ответа. */
export const FINAL_CLOSE = '</final_answer>'

/** Быстрая проверка «в тексте вообще есть маркеры». */
function hasMarkers(text: string): boolean {
  return !!text && text.indexOf('final_answer') !== -1
}

/** Убирает маркеры, оставляя их содержимое (для готового текста). */
export function stripFinalMarkers(text: string): string {
  if (!hasMarkers(text)) return text
  return text.replace(/<\/?final_answer>/gi, '')
}

/**
 * Убирает маркеры из СТРИМЯЩЕГОСЯ текста: кроме готовых тегов отрезает
 * недописанный хвост («<final_an», «</final»), чтобы он не мигал в чате
 * во время печати. Как только тег допечатается — хвост вернётся уже тегом.
 */
export function stripFinalMarkersStreaming(text: string): string {
  if (!text) return text
  const out = stripFinalMarkers(text)
  const lt = out.lastIndexOf('<')
  if (lt === -1) return out
  const tail = out.slice(lt).toLowerCase()
  if (tail.includes('>')) return out
  if (FINAL_OPEN.startsWith(tail) || FINAL_CLOSE.startsWith(tail)) return out.slice(0, lt)
  return out
}

export interface FinalSplit {
  /** Текст хода работы (всё, что вне блока итогового ответа). */
  narration: string
  /** Содержимое блока(ов) итогового ответа (склеенное). */
  answer: string
}

/**
 * Делит текст на прозу хода работы и итоговый ответ.
 * Незакрытый блок (стриминг) считается ответом до конца текста.
 */
export function splitFinalAnswer(text: string): FinalSplit {
  if (!hasMarkers(text)) return { narration: text, answer: '' }
  const answers: string[] = []
  const narration = text
    .replace(/<final_answer>([\s\S]*?)(<\/final_answer>|$)/gi, (_m, body: string) => {
      answers.push(String(body ?? ''))
      return ''
    })
    .replace(/<\/?final_answer>/gi, '')
    .trim()
  return {
    narration,
    answer: answers.map(a => a.trim()).filter(Boolean).join('\n\n'),
  }
}

export interface FinalSplitIters<T> {
  iters: T[] | undefined
  /** Итоговый ответ, вынутый из итераций (пустая строка — маркеров не было). */
  answer: string
}

/**
 * Вынимает блоки итогового ответа из `textBefore` итераций.
 * Возвращает очищенные итерации (текст ответа из них убран — иначе он висел бы
 * заметкой в ленте) и сам ответ. Если маркеров нет — возвращает исходный
 * массив тем же референсом (мемоизация не ломается).
 */
export function splitFinalFromIters<T extends { textBefore: string }>(
  iters: T[] | undefined,
): FinalSplitIters<T> {
  if (!iters?.length) return { iters, answer: '' }
  const answers: string[] = []
  let changed = false
  const cleaned = iters.map(it => {
    const raw = it?.textBefore ?? ''
    if (!hasMarkers(raw)) return it
    const { narration, answer } = splitFinalAnswer(raw)
    if (answer) answers.push(answer)
    if (narration === raw) return it
    changed = true
    return { ...it, textBefore: narration }
  })
  return { iters: changed ? cleaned : iters, answer: answers.join('\n\n') }
}
