/**
 * §orchestration — main-сторона one-turn оркестрации (`/orchestrate`).
 *
 * Здесь живут ТОЛЬКО правила: валидация пользовательского выбора, заморозка
 * снапшота рана (планировщик = модель чата на момент приёма запроса), сверка
 * провайдеров и слим-снапшот прогресса фаз для БД. Модуль намеренно чистый
 * (никаких импортов electron/store/DB), поэтому его можно проверять юнит-
 * тестами и переиспользовать в тестах моста (tests/orchestration-bridge).
 *
 * Контракт типов — shared/orchestration.ts (его же использует core/Agent и
 * renderer). Renderer шлёт только `{ executor, reviewer? }`; планировщика
 * снимает main, чтобы выбор из настроек не «залипал» на чат.
 */
import type {
  OrchestrationModel,
  OrchestrationResume,
  OrchestrationRun,
  OrchestrationSelection,
} from '../../shared/orchestration'
import type { Provider } from '../../shared/types'

// Мерж/слим/block прогресса фаз живут в ОДНОМ месте — shared/orchestrationProgress
// (его же использует renderer). Раньше здесь была своя копия, и повтор фазы
// (второй круг executing/reviewing) затирал историю кругов только на одной
// стороне моста. Реэкспорт сохраняет прежний импорт из этого модуля.
export {
  ORCH_DETAIL_MAX,
  ORCH_PHASES_MAX,
  ORCH_PLAN_MAX,
  blockRunningOrchestrationPhase,
  capOrchestrationPhases,
  mergeOrchestrationProgress,
  slimOrchestrationPhases,
} from '../../shared/orchestrationProgress'

import { ORCH_PLAN_MAX } from '../../shared/orchestrationProgress'

/** Валиден ли объект модели роли (provider+model, непустые строки). */
export function isOrchestrationModel(value: unknown): value is OrchestrationModel {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return typeof m.providerId === 'string' && m.providerId.length > 0
    && typeof m.modelId === 'string' && m.modelId.length > 0
}

/** Нормализация модели роли: мусор → null, лишние поля отбрасываются. */
export function normalizeOrchestrationModel(value: unknown): OrchestrationModel | null {
  if (!isOrchestrationModel(value)) return null
  const model: OrchestrationModel = { providerId: value.providerId, modelId: value.modelId }
  const reasoning = (value as OrchestrationModel).reasoningValue
  if (typeof reasoning === 'string' && reasoning.length > 0) model.reasoningValue = reasoning
  return model
}

/** Режимные флаги отправки, несовместимые с оркестрацией. */
export interface OrchestrationModeFlags {
  askMode?: boolean
  planningMode?: boolean
  imageMode?: boolean
  /** Режим кастомной команды (one-shot): 'ask' | 'plan' | 'code'. */
  oneShotMode?: 'ask' | 'plan' | 'code'
}

/**
 * Ask/Plan/Image — это ОГРАНИЧЕНИЯ ПРАВ рана, а оркестрация меняет
 * исполнителя фазы (executing получает полный тулсет). Совмещать нельзя:
 * либо пользователь просил read-only/план, либо полную реализацию. Отказываем
 * ДО старта, а не «тихо понижаем» режим — иначе ран писал бы файлы вопреки
 * включённому Ask.
 */
export function orchestrationModeIssue(flags: OrchestrationModeFlags): string | null {
  if (flags.askMode || flags.oneShotMode === 'ask') {
    return 'режим Ask (только чтение) несовместим с оркестрацией — выключите Ask'
  }
  if (flags.planningMode || flags.oneShotMode === 'plan') {
    return 'режим Plan несовместим с оркестрацией — план строит сам планировщик'
  }
  if (flags.imageMode) {
    return 'режим изображений несовместим с оркестрацией'
  }
  return null
}

/** Проверка выбора перед отправкой (executor обязателен, reviewer опционален). */
export function orchestrationSelectionIssue(selection: unknown): string | null {
  if (selection === undefined || selection === null) return null
  if (typeof selection !== 'object') return 'некорректный выбор моделей оркестрации'
  const s = selection as Record<string, unknown>
  if (!isOrchestrationModel(s.executor)) {
    return 'не выбрана модель-исполнитель'
  }
  if (s.reviewer !== undefined && s.reviewer !== null && !isOrchestrationModel(s.reviewer)) {
    return 'некорректная модель-ревьюер'
  }
  return null
}

/**
 * Нормализация resume: план обрезаем (он уходит в промпт и в снапшот), список
 * сделанного — до 40 коротких пунктов. Мусор отбрасываем, а не падаем.
 */
export function normalizeOrchestrationResume(value: unknown): OrchestrationResume | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const plan = typeof raw.plan === 'string' ? raw.plan.trim().slice(0, ORCH_PLAN_MAX) : ''
  const done = Array.isArray(raw.done)
    ? raw.done
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim().slice(0, 300))
        .filter(Boolean)
        .slice(0, 40)
    : []
  if (!plan && done.length === 0) return undefined
  return { ...(plan ? { plan } : {}), ...(done.length ? { done } : {}) }
}

/**
 * Заморозка снапшота рана. Планировщик приходит снаружи (модель чата на
 * момент приёма запроса), ревьюер по умолчанию = планировщик — ЯВНО:
 * core при `reviewer === undefined` фазу ревью пропускает (никакого
 * неявного fallback на «модель по умолчанию»).
 *
 * resume — «Продолжить» с карточки прерванного рана: план уже утверждён,
 * поэтому ран стартует сразу с исполнения (см. OrchestrationRuntime).
 */
export function freezeOrchestrationRun(
  selection: OrchestrationSelection | null | undefined,
  planner: OrchestrationModel | null,
  resume?: unknown,
): OrchestrationRun | null {
  if (!selection) return null
  const executor = normalizeOrchestrationModel(selection.executor)
  if (!executor) return null
  const plannerModel = normalizeOrchestrationModel(planner)
  if (!plannerModel) return null
  const reviewer = normalizeOrchestrationModel(selection.reviewer) ?? plannerModel
  const normalizedResume = normalizeOrchestrationResume(resume)
  return {
    planner: plannerModel,
    executor,
    reviewer,
    ...(normalizedResume ? { resume: normalizedResume } : {}),
  }
}

/** Подпись модели для сообщений об ошибке: modelId (providerId). */
export function orchestrationModelLabel(model: OrchestrationModel): string {
  return `${model.modelId} (${model.providerId})`
}

/**
 * Ревалидация провайдеров снапшота (на приёме и повторно на старте рана).
 * Никакого fallback: если провайдер удалён/отключён — ран не стартует, а
 * пользователь получает внятную причину. Возвращает текст проблемы или null.
 */
export function orchestrationProviderIssue(
  run: OrchestrationRun | null | undefined,
  providers: Provider[] | undefined,
): string | null {
  if (!run) return null
  const list = providers ?? []
  const roles: Array<[string, OrchestrationModel]> = [
    ['планировщик', run.planner],
    ['исполнитель', run.executor],
    ...(run.reviewer ? [['ревьюер', run.reviewer] as [string, OrchestrationModel]] : []),
  ]
  for (const [role, model] of roles) {
    if (!isOrchestrationModel(model)) return `некорректная модель-${role}`
    const provider = list.find(p => p.id === model.providerId)
    if (!provider) {
      return `провайдер «${model.providerId}» для роли ${role} не найден — выберите модель заново`
    }
    if (provider.enabled === false) {
      return `провайдер «${model.providerId}» для роли ${role} отключён — включите его или выберите другую модель`
    }
  }
  return null
}

// Мерж фаз, слим-снапшот и закрытие 'running' фазы — см. реэкспорт выше
// (shared/orchestrationProgress). Здесь остаются только правила рана.
