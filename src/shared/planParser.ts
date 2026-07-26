// ─── Парсер <plan>-блоков ───────────────────────────────────────────────────
// Используется в renderer (live-рендер PlanCard во время стрима) и в main
// (извлечение финального плана из ответа для сохранения в файл).
//
// Формат (модель пишет в ответе, обёрнуто в тег):
//   <plan title="Название плана" summary="Одна строка вердикта">
//   ## Фаза 1: …
//   - [ ] Шаг 1
//   …
//   </plan>
//
// Парсер толерантен к:
//   - незакрытому тегу во время стрима (partial=true)
//   - отсутствию атрибутов (title/summary бертся из контента)
//   - разным кавычкам (двойные/одинарные/без)
//   - нескольким <plan>-блокам (берётся первый полный)

export interface PlanBlock {
  title: string
  summary: string
  content: string
  /** true если закрывающий </plan> ещё не пришёл (стрим идёт). */
  partial: boolean
  /** Индекс начала <plan> в исходной строке. */
  start: number
  /** Индекс конца блока (после </plan> или конца строки для partial). */
  end: number
}

export interface PlanSegmentText {
  type: 'text'
  content: string
}

export interface PlanSegmentPlan {
  type: 'plan'
  title: string
  summary: string
  content: string
  partial: boolean
}

export type PlanSegment = PlanSegmentText | PlanSegmentPlan

// Регекс: ловит <plan ...> с атрибутами, контент до </plan> или конца строки.
// Флаги: g (все вхождения), s не используем — управляем через [\s\S].
// Группа 1: атрибуты (title="..." summary="...")
// Группа 2: контент
// Группа 3: закрывающий тег (есть = полный, нет = partial)
const PLAN_RE = /<plan\b([^>]*)>([\s\S]*?)(<\/plan>|$)/gi

/** Извлечь атрибут title="..." или summary="..." из строки атрибутов. */
function parseAttr(attrs: string, name: string): string {
  // double quotes: name="value"
  const dq = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs)
  if (dq) return dq[1]
  // single quotes: name='value'
  const sq = new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i').exec(attrs)
  if (sq) return sq[1]
  // bare: name=value (до пробела или конца)
  const bare = new RegExp(`${name}\\s*=\\s*([^\\s>]+)`, 'i').exec(attrs)
  if (bare) return bare[1]
  return ''
}

/**
 * Разбить текст на сегменты: plain text + plan-блоки.
 * Используется для live-рендера: вызываетсья на каждом чанке стрима.
 * Текст внутри <plan> НЕ попадает в text-сегменты — он скрыт, видна только
 * карточка. Если план ещё стримится (нет </plan>) — partial=true.
 */
export function extractPlanSegments(text: string): {
  segments: PlanSegment[]
  planBlocks: PlanBlock[]
} {
  const segments: PlanSegment[] = []
  const planBlocks: PlanBlock[] = []
  let lastEnd = 0
  let m: RegExpExecArray | null

  // Сбросить regex state (глобальный regex переиспользуется)
  PLAN_RE.lastIndex = 0

  while ((m = PLAN_RE.exec(text)) !== null) {
    const [full, attrs, content, closing] = m
    const start = m.index
    const end = start + full.length
    const partial = closing !== '</plan>'

    // Текст до <plan>
    if (start > lastEnd) {
      const before = text.slice(lastEnd, start)
      if (before) segments.push({ type: 'text', content: before })
    }

    const title = parseAttr(attrs, 'title').trim()
    const summary = parseAttr(attrs, 'summary').trim()

    const block: PlanBlock = {
      title,
      summary,
      content: content.trim(),
      partial,
      start,
      end,
    }
    planBlocks.push(block)
    segments.push({
      type: 'plan',
      title,
      summary,
      content: block.content,
      partial,
    })

    lastEnd = end
  }

  // Хвост после последнего plan-блока
  if (lastEnd < text.length) {
    const after = text.slice(lastEnd)
    if (after) segments.push({ type: 'text', content: after })
  }

  return { segments, planBlocks }
}

/**
 * Извлечь первый ПОЛНЫЙ plan-блок из ответа (для сохранения в файл).
 * Возвращает null если нет закрытого </plan>.
 * Если title/summary пустые — пытается вытащить из контента (первый # заголовок,
 * последняя строка «Вердикт:»).
 */
export function extractFinalPlan(text: string): {
  title: string
  summary: string
  content: string
} | null {
  const { planBlocks } = extractPlanSegments(text)
  const full = planBlocks.find(b => !b.partial)
  if (!full) return null

  let title = full.title
  let summary = full.summary

  // Fallback: title из первого markdown-заголовка
  if (!title) {
    const h = /^#\s+(.+)$/m.exec(full.content)
    if (h) title = h[1].trim()
  }
  if (!title) title = 'План'

  // Fallback: summary из строки «Вердикт:» или последней непустой строки
  if (!summary) {
    const verdict = /вердикт[:\s]*([^\n]+)/i.exec(full.content)
    if (verdict) {
      summary = verdict[1].trim()
    } else {
      const lines = full.content.split('\n').filter(l => l.trim())
      summary = lines[lines.length - 1]?.replace(/^[-*]\s+/, '').slice(0, 200) || ''
    }
  }

  return { title, summary, content: full.content }
}

/**
 * Стрипнуть <plan>-теги из текста, оставив только контент плана как markdown.
 * Используется при экспорте чата (chat:export) — чтобы .md/.txt не содержал
 * служебных тегов. Если план есть — заменяет весь <plan>…</plan> на его
 * контент (как markdown). Если нет — возвращает текст как есть.
 */
export function stripPlanTags(text: string): string {
  const { segments } = extractPlanSegments(text)
  return segments
    .map(s => (s.type === 'plan' ? `# ${s.title || 'План'}\n\n${s.content}` : s.content))
    .join('')
}
