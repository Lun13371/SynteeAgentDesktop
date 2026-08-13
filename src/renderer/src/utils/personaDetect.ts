/**
 * Persona auto-detection from the user's first message in a chat.
 *
 * Used by ChatPage.handleSend to suggest a persona via a blocking modal
 * (opt-in). Only triggers when:
 *   - the chat's sticky persona is 'classic' (default — user hasn't chosen),
 *   - this is the FIRST user message in the chat (no prior history),
 *   - the user hasn't globally opted out (localStorage flag).
 *
 * Heuristics are keyword-based (ru + en), conservative — only suggest when
 * the message clearly matches a persona's domain. Returns null when unclear.
 *
 * This is NOT a replacement for manual selection — just a nudge for the
 * common case where the user opens a new chat to debug something and forgot
 * to switch persona. The user can always dismiss.
 */
import { type PersonaId } from '../../../shared/modes'

const PATTERNS: Array<{ id: Exclude<PersonaId, 'classic'>; re: RegExp }> = [
  {
    id: 'debugger',
    re: /\b(bug|broken|crash|crashes|crashed|error|errors|fail|fails|failed|failure|stacktrace|stack trace|не работает|неwork|ломается|ломается|сломалось|сломается|ошибка|ошибки|ошибку|падает|падает|крашит|крашит|крашнул|баг|бага|баге|исправить баг|починить|почини|фикс|пофиксить|почему не|почему не|где ошибка|где баг)\b/i,
  },
  {
    id: 'reviewer',
    re: /\b(review|review code|code review|проверь код|посмотри код|разбери код|найди проблемы|ревью кода|ревью код|код-ревью|code-review)\b/i,
  },
  {
    id: 'refactorer',
    re: /\b(refactor|refactoring|restructure|clean up|clean up code|рефакторинг|рефактор|рефакторить|почисти код|улучшить структуру|переписать красиво|упростить код)\b/i,
  },
  {
    id: 'test-writer',
    re: /\b(test|tests|testing|unit test|unit tests|coverage|test coverage|напиши тесты|тесты для|юнит-тест|юнит тесты|покрытие|покрытие тестами|тест-кейсы)\b/i,
  },
  {
    id: 'mentor',
    re: /\b(explain|explain how|explain what|teach|how does|how do|what is|walk me through|объясни|объясни как|объясни что|как работает|как работают|расскажи про|расскажи как|что такое|поясни|обучение|научи)\b/i,
  },
  {
    id: 'architect',
    re: /\b(architecture|architectural|design the|design a|system design|how should (i|we) (structure|design|organize)|scaffold|blueprint|module structure|структура проекта|архитектура|спроектировать|как лучше структурировать|каркас|скелет проекта|дизайн модулей)\b/i,
  },
]

/**
 * Detect the most likely persona for a message, or null if no clear match.
 * When multiple patterns match, the FIRST in PATTERNS order wins (debugger
 * is highest priority — "bug" should not be misread as "test bug").
 */
export function detectPersona(text: string): Exclude<PersonaId, 'classic'> | null {
  if (!text || text.length < 3) return null
  const lower = text.toLowerCase()
  for (const p of PATTERNS) {
    if (p.re.test(lower)) return p.id
  }
  return null
}

const OPT_OUT_KEY = 'syntee:personaSuggestionsDisabled'

/** Global opt-out (the "Never ask again" button). Persists in localStorage. */
export function isPersonaSuggestionsDisabled(): boolean {
  try {
    return localStorage.getItem(OPT_OUT_KEY) === '1'
  } catch {
    return false
  }
}

export function disablePersonaSuggestions(): void {
  try {
    localStorage.setItem(OPT_OUT_KEY, '1')
  } catch { /* ok */ }
}
