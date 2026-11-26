/**
 * Контракт one-turn оркестрации (`/orchestrate`).
 *
 * Один ход чата выполняется не основной моделью, а назначенным исполнителем;
 * опциональный ревьюер проверяет результат. Основная модель чата остаётся
 * координатором (planning/инструменты/итоговый ответ) — контракт ниже
 * описывает ТОЛЬКО снимок выбора моделей, который renderer отправляет в
 * `window.syntee.chat.send({ orchestration })`.
 *
 * Поле передаётся только для одноразовой отправки: backend снимает снапшот
 * планировщика из текущей основной модели чата (и её reasoning) на момент
 * старта хода, поэтому выбор из настроек не «залипает» на чат.
 */

/** Модель роли в оркестрации: провайдер + модель (+ уровень мышления). */
export interface OrchestrationModel {
  providerId: string
  modelId: string
  /** Уровень мышления именно для этой роли (undefined — дефолт провайдера). */
  reasoningValue?: string
}

/** Одноразовый выбор оркестрации. */
export interface OrchestrationSelection {
  /** Исполнитель — обязателен: без него оркестрация не запускается. */
  executor: OrchestrationModel
  /** Ревьюер — опционален; отсутствие = основная модель чата. */
  reviewer?: OrchestrationModel
}

/**
 * Что уже сделано в прерванном ране — передаётся при «Продолжить».
 *
 * Продолжение НЕ должно начинаться с чистого планирования: планировщик уже
 * принял план, исполнитель успел что-то изменить. Поэтому ран стартует сразу
 * с фазы исполнения, а план и список сделанного идут в инструкцию.
 */
export interface OrchestrationResume {
  /** Утверждённый план предыдущего рана (если планировщик успел его составить). */
  plan?: string
  /** Что уже сделано: изменённые файлы, выполненные проверки и т.п. */
  done?: string[]
}

/**
 * Полный снимок рана: к выбору добавляется планировщик (backend снимает его
 * с текущей основной модели чата на момент старта хода).
 */
export interface OrchestrationRun extends OrchestrationSelection {
  planner: OrchestrationModel
  /** Продолжение прерванного рана: старт сразу с исполнения. */
  resume?: OrchestrationResume
}

/** Фаза рана. Ровно одна фаза активна в момент времени. */
export type OrchestrationPhase = 'planning' | 'executing' | 'reviewing' | 'replanning'

/**
 * Одно событие прогресса фазы: одно событие на переход (running при входе в
 * фазу, done/blocked при выходе). UI накапливает фазы по startedAt.
 */
export interface OrchestrationProgress {
  phase: OrchestrationPhase
  model: OrchestrationModel
  startedAt: number
  updatedAt: number
  detail?: string
  status: 'running' | 'done' | 'blocked'
  /**
   * Утверждённый план (только у фазы planning/replanning): сохраняется в
   * снапшоте сообщения, чтобы «Продолжить» не пересобирало план заново.
   */
  plan?: string
}
