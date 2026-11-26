import type { OrchestrationModel, OrchestrationSelection } from '../../../shared/orchestration'

/**
 * Renderer-хелперы one-turn оркестрации (`/orchestrate`).
 *
 * Типы контракта живут в shared/orchestration.ts (их использует и backend),
 * здесь — разбор/валидация пользовательского выбора и ключ настройки.
 */

/** Ключ electron-store с дефолтами (Settings → AI → Оркестрация). */
export const ORCHESTRATION_DEFAULTS_KEY = 'orchestrationDefaults'

/**
 * Ключ electron-store с последним выбором ПО ЧАТАМ. В отличие от дефолтов
 * (глобальные, задаются в настройках) это «что я выбирал в этом чате»:
 * переживает перезапуск, смену чата и закрытие блока крестиком.
 */
export const ORCHESTRATION_BY_CHAT_KEY = 'orchestrationByChat'

/** Сколько чатов помним: LRU по updatedAt, чтобы стор не пух бесконечно. */
const ORCHESTRATION_BY_CHAT_MAX = 40

interface OrchestrationChatEntry {
  executor: OrchestrationModel
  reviewer?: OrchestrationModel
  updatedAt: number
}

/** Частичные дефолты: обе роли опциональны, чатовая модель — fallback. */
export interface OrchestrationDefaults {
  executor?: OrchestrationModel
  reviewer?: OrchestrationModel
}

/** Текст проблемы для инпут-бара: ChatInput локализует через t(ru, en). */
export interface OrchestrationIssueText {
  ru: string
  en: string
}

export function isOrchestrationModel(v: unknown): v is OrchestrationModel {
  if (!v || typeof v !== 'object') return false
  const m = v as Record<string, unknown>
  return (
    typeof m.providerId === 'string' &&
    m.providerId.length > 0 &&
    typeof m.modelId === 'string' &&
    m.modelId.length > 0
  )
}

/** Безопасный разбор одной роли (битые/частичные данные → undefined). */
export function normalizeOrchestrationModel(v: unknown): OrchestrationModel | undefined {
  if (!isOrchestrationModel(v)) return undefined
  const model: OrchestrationModel = { providerId: v.providerId, modelId: v.modelId }
  if (typeof v.reasoningValue === 'string' && v.reasoningValue) model.reasoningValue = v.reasoningValue
  return model
}

/** Разбор settings['orchestrationDefaults'] — устойчив к мусору и старым версиям. */
export function normalizeOrchestrationDefaults(raw: unknown): OrchestrationDefaults {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const out: OrchestrationDefaults = {}
  const executor = normalizeOrchestrationModel(r.executor)
  const reviewer = normalizeOrchestrationModel(r.reviewer)
  if (executor) out.executor = executor
  if (reviewer) out.reviewer = reviewer
  return out
}

/** Ключ сравнения моделей (provider::model) — для дедупа/подписей. */
export function orchestrationModelKey(m?: OrchestrationModel | null): string {
  return m ? `${m.providerId}::${m.modelId}` : ''
}

/**
 * Последний выбор для конкретного чата. `null` — в этом чате ещё ничего не
 * выбирали (тогда берём дефолты из настроек). Битые/частичные записи
 * игнорируются: без валидного исполнителя выбор бесполезен.
 */
export function readOrchestrationForChat(
  raw: unknown,
  chatId: string | null | undefined
): OrchestrationSelection | null {
  if (!chatId || !raw || typeof raw !== 'object') return null
  const entry = (raw as Record<string, unknown>)[chatId]
  if (!entry || typeof entry !== 'object') return null
  const e = entry as Record<string, unknown>
  const executor = normalizeOrchestrationModel(e.executor)
  if (!executor) return null
  const reviewer = normalizeOrchestrationModel(e.reviewer)
  return reviewer ? { executor, reviewer } : { executor }
}

/**
 * Записать выбор чата в стор (иммутабельно). Возвращает НОВЫЙ объект для
 * settings.set. Пустой executor (ещё не выбрали) не пишется — иначе он бы
 * затёр сохранённый ранее выбор.
 */
export function writeOrchestrationForChat(
  raw: unknown,
  chatId: string,
  selection: OrchestrationSelection | null
): Record<string, OrchestrationChatEntry> {
  const table: Record<string, OrchestrationChatEntry> =
    raw && typeof raw === 'object' ? { ...(raw as Record<string, OrchestrationChatEntry>) } : {}
  const executor = normalizeOrchestrationModel(selection?.executor)
  if (!executor) return table
  const entry: OrchestrationChatEntry = { executor, updatedAt: Date.now() }
  const reviewer = normalizeOrchestrationModel(selection?.reviewer)
  if (reviewer) entry.reviewer = reviewer
  table[chatId] = entry
  const ids = Object.keys(table)
  if (ids.length > ORCHESTRATION_BY_CHAT_MAX) {
    ids
      .sort((a, b) => (table[a]?.updatedAt ?? 0) - (table[b]?.updatedAt ?? 0))
      .slice(0, ids.length - ORCHESTRATION_BY_CHAT_MAX)
      .forEach(id => { delete table[id] })
  }
  return table
}

/**
 * Проверка выбора перед отправкой. `null` — всё валидно.
 * Исполнитель обязателен; ревьюер опционален (по умолчанию — модель чата).
 */
export function validateOrchestration(
  selection: OrchestrationSelection | null | undefined
): OrchestrationIssueText | null {
  if (!selection) return null
  if (!isOrchestrationModel(selection.executor)) {
    return {
      ru: 'Оркестрация: выберите модель-исполнителя',
      en: 'Orchestration: pick an executor model',
    }
  }
  if (selection.reviewer !== undefined && !isOrchestrationModel(selection.reviewer)) {
    return {
      ru: 'Оркестрация: выберите модель-ревьюера или уберите её',
      en: 'Orchestration: pick a reviewer model or clear it',
    }
  }
  return null
}
