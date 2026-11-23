import { CONSTITUTION_MARKER } from '../../shared/assistants'

/**
 * Конституция — только ЯВНЫЕ правила пользователя.
 *
 * Автоматическое извлечение ограничений (regex-паттерны по любому тексту +
 * LLM-экстрактор в main) удалено: правила попадали в контекст дважды (блок
 * конституции + карточка-подсказка), «всегда проверяй» из обычной просьбы
 * закреплялось навсегда, а старые авто-пункты нечем было отозвать. Теперь
 * правило добавляется лишь когда пользователь сказал прямо:
 *   - слэш-команда `/rule не трогай миграции`
 *   - маркер `запомни правило: не трогай миграции` (или `remember rule:`)
 * Обычный текст правил не порождает.
 */
const EXPLICIT_RULE_PREFIXES: RegExp[] = [
  /^\/rule\s+/i,
  /^запомни\s+правило\s*[:—-]?\s*/i,
  /^remember\s+(?:this\s+)?rule\s*[:—-]?\s*/i,
]

const MAX_ITEMS = 12
const MAX_ITEM_LEN = 200

/** Тело правила из строки с явным маркером; null — строка правилом не является. */
function explicitRuleBody(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  for (const prefix of EXPLICIT_RULE_PREFIXES) {
    const m = prefix.exec(trimmed)
    if (m) return trimmed.slice(m[0].length).trim()
  }
  return null
}

export class Constitution {
  private items = new Map<string, string>()

  /** Слот для нового пункта: при переполнении вытесняем самый старый
   *  (Map сохраняет порядок вставки). Без этого конституция однажды
   *  «застынет» на MAX_ITEMS и новые правила перестанут попадать. */
  private put(key: string, item: string): void {
    if (this.items.has(key)) return
    if (this.items.size >= MAX_ITEMS) {
      const oldest = this.items.keys().next().value
      if (oldest !== undefined) this.items.delete(oldest)
    }
    this.items.set(key, item)
  }

  /** Явные правила из сообщения пользователя. Возвращает НОВЫЕ пункты. */
  addExplicit(text: string): string[] {
    const added: string[] = []
    for (const line of String(text ?? '').split(/\n+/)) {
      const body = explicitRuleBody(line)
      if (!body) continue
      for (const rawPart of body.split(/;\s*/)) {
        const item = rawPart.slice(0, MAX_ITEM_LEN).trim()
        if (item.length < 3) continue
        const key = item.toLowerCase().replace(/\s+/g, ' ')
        if (this.items.has(key)) continue
        this.put(key, item)
        added.push(item)
      }
    }
    return added
  }

  /** Восстановление из персиста (per chat) — молча, без отчёта о новых. */
  hydrate(items: string[]): void {
    for (const raw of items) {
      const item = String(raw ?? '').slice(0, MAX_ITEM_LEN).trim()
      if (!item) continue
      this.put(item.toLowerCase().replace(/\s+/g, ' '), item)
    }
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
