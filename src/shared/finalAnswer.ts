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

// ── Защита от «тула» final_answer ────────────────────────────────────────
// Часть моделей принимает тег <final_answer> за имя функции и вызывает
// несуществующий тул: в чате появляется карточка «final_answer — ошибка»,
// модель получает «такого тула нет» и путается. Такие вызовы вынимаем ДО
// проверки схем: текст из аргументов становится обычным текстом ответа.

/** Похоже ли имя тула на маркер итогового ответа. */
export function isFinalAnswerToolName(name: string | undefined | null): boolean {
  if (!name) return false
  const n = name.trim().toLowerCase().replace(/^<|>$/g, '').replace(/[\s_-]/g, '')
  return n === 'finalanswer' || n === 'final' || n === 'answerfinal'
}

const FINAL_TEXT_KEYS = [
  'text', 'content', 'answer', 'final', 'final_answer', 'finalAnswer', 'markdown', 'value', 'summary', 'message',
]

/** Достаёт текст ответа из аргументов «тула» final_answer. */
export function extractFinalAnswerToolText(rawArguments: string | undefined): string {
  if (!rawArguments) return ''
  const raw = rawArguments.trim()
  if (!raw) return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Не JSON — модель положила в аргументы просто текст.
    return raw.startsWith('{') || raw.startsWith('[') ? '' : raw
  }
  if (typeof parsed === 'string') return parsed.trim()
  if (!parsed || typeof parsed !== 'object') return ''
  const obj = parsed as Record<string, unknown>
  for (const key of FINAL_TEXT_KEYS) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  // Незнакомые ключи не угадываем: лучше вернуть пусто (агент подскажет
  // модели написать текст), чем выдать пользователю служебное поле вроде
  // {"status":"done"} за ответ.
  return ''
}

export interface FinalToolCallsSplit<T> {
  /** Оставшиеся (настоящие) вызовы тулов. */
  calls: T[]
  /** Текст, который модель пыталась отдать через «тул» final_answer. */
  text: string
  /** Сколько вызовов вынули. */
  removed: number
}

/**
 * Вынимает из списка tool_calls вызовы «final_answer» (модель спутала тег с
 * функцией). Возвращает очищенный список и текст ответа из их аргументов.
 */
export function takeFinalAnswerToolCalls<T extends { function?: { name?: string; arguments?: string } }>(
  calls: T[] | undefined,
): FinalToolCallsSplit<T> {
  if (!calls?.length) return { calls: calls ?? [], text: '', removed: 0 }
  const kept: T[] = []
  const texts: string[] = []
  for (const call of calls) {
    if (!isFinalAnswerToolName(call?.function?.name)) {
      kept.push(call)
      continue
    }
    const t = extractFinalAnswerToolText(call.function?.arguments)
    if (t) texts.push(t)
  }
  const removed = calls.length - kept.length
  if (removed === 0) return { calls, text: '', removed: 0 }
  return { calls: kept, text: texts.join('\n\n'), removed }
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
