/**
 * extractor.ts — LLM-извлечение фактов из диалога + episodic sync.
 *
 * Замена regex-извлечению (extractMemoriesFromConversation в MemoryEngine.ts):
 * вместо примитивных паттернов «запомни X» / «меня зовут X» — fast-LLM вызов
 * по паттерну summarizeWithLLM (annotator.ts), который ловит неявные факты
 * («предпочитаю TypeScript», «используем Postgres», «не любишь понедельники»).
 *
 * Триггеры (Фаза 3):
 *   1. Compaction — когда applyRollingWindowAsync сжимает контекст (chat:send)
 *   2. 10-минутный idle — setTimeout после последнего chat:send
 *   3. Явное «запомни X» — остаётся regex fast-path (мгновенно, без LLM)
 *
 * Episodic sync: при compaction summary пишется в memory_items как
 * kind='conversation' — делает прошлые диалоги искомыми через recall_memory.
 *
 * Cost-control:
 *   - Skip в инкогнито
 *   - Skip если user-msg <20 симв или slash-command
 *   - Skip если диалог уже экстрагировался (metadata->last_extracted_turn)
 *   - Бесплатная fast-модель (роль 'fastContext' → north-mini-code-free / ling)
 */

import type Store from 'electron-store'
import { AIClient } from '../ai/AIClient'
import { saveMemoryItem, type MemoryKind } from './MemoryStore'
import { extractJsonFromLlmResponse } from '../context/fastContext/annotator'

// ─── Типы ────────────────────────────────────────────────────────────────────

export interface ExtractedFact {
  title: string
  content: string
  kind: MemoryKind
  key?: string
  category?: string
  confidence?: number
  importance?: number
}

export interface ExtractParams {
  chatId: string
  userMessage: string
  assistantMessage: string
  projectId?: string
  /** Сколько turn'ов экстрагировано ранее (для throttle внутри чата). */
  turnCount?: number
}

export interface ExtractResult {
  extracted: number
  episodic: boolean
  error?: string
}

// ─── LLM-промпт ──────────────────────────────────────────────────────────────

const EXTRACT_SYSTEM_PROMPT = `Ты — экстрактор фактов из диалога пользователя с AI-ассистентом. Твоя задача — извлечь LONG-TERM значимые факты, которые полезно запомнить для будущих сессий.

5 типов фактов (kind):
- user_fact: предпочтения пользователя, личные факты, привычки («предпочитаю TypeScript», «работаю в компании X», «не люблю понедельники»)
- project_decision: архитектурные решения, выбор стека, паттерны («решили использовать Postgres», «API в /api/v2», «state management — Zustand»)
- convention: gotchas/ловушки проекта, неочевидные правила, специфика окружения («ESLint таймаутит на больших батчах», «migrations только через X», «нужно делать Y перед Z»)
- agent_outcome: уроки из исходов действий («edit tool падает на файлах >5MB», «тесты запускаются через npm test»)
- conversation: НЕ извлекай здесь — этот тип создаётся отдельно при compaction

НЕ извлекай:
- тривиальное (время, погода, текущая дата)
- временные детали задачи (для этого есть working_memory, не long-term)
- дубликаты того что уже явно было сказано ранее в этом диалоге
- вопросительные реплики без утверждения
- промежуточные шаги — только итоговые факты

Ответ — только JSON, без markdown:
{"facts":[{"title":"краткое название 1-5 слов","content":"самодостаточное утверждение","kind":"user_fact|project_decision|convention|agent_outcome","key":"dedup_key_опционально","category":"personal|work|preferences|projects|facts","confidence":0.0-1.0,"importance":0.0-1.0}]}

Правила:
- title — краткое название (1-5 слов): «Предпочитает TypeScript», «Auth через JWT», «ESLint таймаутит на батчах». НЕ пишите полное предложение в title.
- content — самодостаточное утверждение: «Пользователь предпочитает TypeScript» (не «предпочитает TS»)
- kind — обязательный, один из четырёх (НЕ conversation — он только при compaction)
- key — опциональный, для дедупликации (напр. "preferred_stack", "auth_approach")
- category — только для user_fact (personal/work/preferences/projects/facts)
- confidence — насколько уверен (0.0-1.0)
- importance — насколько важно запомнить (0.0-1.0). Факты с importance < 0.4 будут отброшены.
- Если фактов нет — верни {"facts":[]}
- Не выдумывай факты, не extrapolируй
- 1-3 факта за раз — только самое важное, не извлекай всё подряд`

// ─── Главная функция ─────────────────────────────────────────────────────────

/**
 * Извлекает факты из последнего turn'а диалога через fast-LLM.
 *
 * Cost-control: skip если user-msg короткий или slash-command. Throttle
 * не делаем тут — вызывается только с триггеров (compaction/idle), а не на
 * каждом turn'е.
 */
export async function extractFactsFromTurn(
  store: Store,
  params: ExtractParams,
): Promise<{ facts: ExtractedFact[]; error?: string }> {
  // Skip-условия
  if (params.userMessage.trim().length < 20) {
    return { facts: [] }
  }
  if (params.userMessage.startsWith('/')) {
    return { facts: [] } // slash-command — не извлекаем
  }

  // LLM-вызов по паттерну summarizeWithLLM (annotator.ts:92)
  const aiClient = new AIClient(store)
  const prompt = buildExtractPrompt(params.userMessage, params.assistantMessage)

  let raw = ''
  try {
    await aiClient.streamChat(
      [{ role: 'user', content: prompt }],
      {
        onToken: (t) => { raw += t },
        onDone: () => {},
        onError: () => {},
      },
      'fastContext', // бесплатная fast-модель (north-mini-code-free / ling)
      EXTRACT_SYSTEM_PROMPT,
      undefined,
      0.1, // low temperature for deterministic extraction
    )
  } catch (e) {
    return { facts: [], error: (e as Error).message }
  }

  // Парсим JSON (переиспользуем robust-парсер из annotator.ts)
  const parsed = extractJsonFromLlmResponse(raw)
  if (!parsed || !Array.isArray(parsed.facts)) {
    return { facts: [], error: 'invalid JSON response' }
  }

  const facts: ExtractedFact[] = []
  for (const f of parsed.facts) {
    if (typeof f !== 'object' || f === null) continue
    const obj = f as Record<string, unknown>
    const content = typeof obj.content === 'string' ? obj.content.trim() : ''
    const kind = typeof obj.kind === 'string' ? obj.kind as MemoryKind : null
    if (!content || !kind) continue
    if (!['user_fact', 'project_decision', 'convention', 'conversation', 'agent_outcome'].includes(kind)) continue
    // importance threshold — skip low-importance facts (anti-noise)
    const importance = typeof obj.importance === 'number' ? Math.max(0, Math.min(1, obj.importance)) : 0.5
    if (importance < 0.4) continue
    // title — required, fallback to content slice if missing
    const title = typeof obj.title === 'string' && obj.title.trim()
      ? obj.title.trim().slice(0, 120)
      : content.slice(0, 80)
    facts.push({
      title,
      content,
      kind,
      key: typeof obj.key === 'string' && obj.key.trim() ? obj.key.trim() : undefined,
      category: typeof obj.category === 'string' ? obj.category : undefined,
      confidence: typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0.7,
      importance,
    })
  }

  return { facts }
}

function buildExtractPrompt(userMessage: string, assistantMessage: string): string {
  // Ограничиваем длину — fast-модель не нужно кормить всем диалогом,
  // только последний turn (user + assistant). 2000 симв на каждое.
  const user = userMessage.slice(0, 2000)
  const assistant = assistantMessage.slice(0, 2000)
  return `Извлеки long-term значимые факты из последнего turn'а диалога.

Пользователь:
${user}

AI-ассистент:
${assistant}

Верни JSON с фактами (или {"facts":[]} если фактов нет).`
}

// ─── Сохранение извлечённых фактов ────────────────────────────────────────────

/**
 * Извлекает факты и сохраняет их в memory_items через saveMemoryItem.
 * Dedup обрабатывается внутри saveMemoryItem (key → update; cosine>0.92 → merge).
 *
 * Возвращает кол-во сохранённых фактов.
 */
export async function extractAndSaveFacts(
  store: Store,
  params: ExtractParams,
): Promise<ExtractResult> {
  const { facts, error } = await extractFactsFromTurn(store, params)
  if (error) {
    return { extracted: 0, episodic: false, error }
  }
  if (facts.length === 0) {
    return { extracted: 0, episodic: false }
  }

  let saved = 0
  for (const fact of facts) {
    try {
      // project-scoped kinds: project_decision, convention, agent_outcome (если есть projectId)
      const isProjectKind = fact.kind === 'project_decision' || fact.kind === 'convention' || fact.kind === 'agent_outcome'
      await saveMemoryItem({
        title: fact.title,
        content: fact.content,
        kind: fact.kind,
        key: fact.key,
        category: fact.category,
        scope: isProjectKind && params.projectId ? 'project' : 'global',
        projectId: isProjectKind ? params.projectId : undefined,
        chatId: params.chatId,
        source: 'auto_extract',
        confidence: fact.confidence,
        importance: fact.importance,
        // auto_extract НЕ pinned — подлежит decay-prune если не используется
      })
      saved++
    } catch (e) {
      console.warn('[extractor] saveMemoryItem failed:', (e as Error).message)
    }
  }

  return { extracted: saved, episodic: false }
}

// ─── Episodic sync: summary → memory_items ───────────────────────────────────

/**
 * Сохраняет summary диалога как эпизодическую память (kind='conversation').
 * Вызывается при compaction (setChatSummary) — делает прошлые диалоги
 * искомыми через recall_memory («мы это уже обсуждали»).
 *
 * Key = chatId (для дедупликации — обновляем существующую запись при
 * новой compaction, не создаём дубль).
 */
export async function syncEpisodicMemory(
  chatId: string,
  summary: string,
  projectId?: string,
): Promise<boolean> {
  if (!summary || summary.trim().length < 50) return false

  try {
    await saveMemoryItem({
      title: 'Сводка диалога',
      content: summary.slice(0, 2000), // ограничиваем длину для embedding
      kind: 'conversation',
      scope: projectId ? 'project' : 'global',
      projectId,
      chatId,
      key: `chat_summary:${chatId}`, // дедуп — обновляем при новой compaction
      source: 'compaction',
      confidence: 0.9,
      importance: 0.6,
      metadata: { chatId, type: 'episodic_summary' },
    })
    return true
  } catch (e) {
    console.warn('[extractor] syncEpisodicMemory failed:', (e as Error).message)
    return false
  }
}

// ─── Комбинированный триггер: extract + episodic ─────────────────────────────

/**
 * Полный pipeline для compaction-триггера:
 *   1. syncEpisodicMemory — summary → memory_items (kind=conversation)
 *   2. extractAndSaveFacts — факты из последнего turn'а
 *
 * Используется в chat.ipc.ts при setChatSummary.
 */
export async function onCompactionTrigger(
  store: Store,
  params: {
    chatId: string
    summary: string
    projectId?: string
    lastUserMessage?: string
    lastAssistantMessage?: string
  },
): Promise<ExtractResult> {
  // 1. Episodic sync (summary → memory_items)
  const episodic = await syncEpisodicMemory(params.chatId, params.summary, params.projectId)

  // 2. Extract facts из последнего turn'а (если есть)
  let extracted = 0
  if (params.lastUserMessage && params.lastAssistantMessage) {
    const result = await extractAndSaveFacts(store, {
      chatId: params.chatId,
      userMessage: params.lastUserMessage,
      assistantMessage: params.lastAssistantMessage,
      projectId: params.projectId,
    })
    extracted = result.extracted
  }

  return { extracted, episodic }
}
