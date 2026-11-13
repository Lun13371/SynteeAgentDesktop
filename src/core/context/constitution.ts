import { CONSTITUTION_MARKER } from '../../shared/assistants'

// Детерминированные паттерны императивных ограничений (RU/EN). Вытаскиваем
// предложение целиком, чтобы сохранить смысл («не трогай X», «всегда Y»).
// NB: \b в JS не видит кириллицу как \w, поэтому для RU границы не используем.
const CONSTRAINT_PATTERNS: RegExp[] = [
  /не\s+(?:трогай|меняй|удаляй|используй|коммить|пушь|запускай|добавляй|переименовывай)[^\n.!?]*/i,
  /нельзя\s+[^\s.!?]+[^\n.!?]*/i,
  /запрещено\s+[^\s.!?]+[^\n.!?]*/i,
  /всегда\s+[^\s.!?]+[^\n.!?]*/i,
  /обязательно\s+[^\s.!?]+[^\n.!?]*/i,
  /используй\s+(?:только\s+)?[^\s.!?]+[^\n.!?]*/i,
  /\b(?:don't|do not|never|always|must not|must|avoid|only use|keep)\b[^\n.!?]*/i,
]

const MAX_ITEMS = 12
const MAX_ITEM_LEN = 200

function splitSentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 3)
}

export class Constitution {
  private items = new Map<string, string>()

  /** Извлекает ограничения из пользовательского текста. Возвращает НОВЫЕ пункты. */
  addFromUserText(text: string): string[] {
    const added: string[] = []
    for (const sentence of splitSentences(text)) {
      if (!CONSTRAINT_PATTERNS.some(p => p.test(sentence))) continue
      const item = sentence.slice(0, MAX_ITEM_LEN).trim()
      const key = item.toLowerCase().replace(/\s+/g, ' ')
      if (this.items.has(key)) continue
      this.items.set(key, item)
      added.push(item)
      if (this.items.size >= MAX_ITEMS) break
    }
    return added
  }

  /** Merge пунктов от LLM-экстрактора (bridge). Возвращает новые. */
  merge(items: string[]): string[] {
    const added: string[] = []
    for (const raw of items) {
      const item = String(raw ?? '').slice(0, MAX_ITEM_LEN).trim()
      if (!item) continue
      const key = item.toLowerCase().replace(/\s+/g, ' ')
      if (this.items.has(key)) continue
      this.items.set(key, item)
      added.push(item)
      if (this.items.size >= MAX_ITEMS) break
    }
    return added
  }

  list(): string[] {
    return [...this.items.values()]
  }

  get size(): number {
    return this.items.size
  }

  serialize(): string | null {
    if (this.items.size === 0) return null
    return `${CONSTITUTION_MARKER}\n${this.list().map(i => `- ${i}`).join('\n')}`
  }
}