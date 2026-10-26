export type GoalStatus = 'running' | 'paused' | 'blocked' | 'completed' | 'unverified' | 'stopped' | 'limit'

/** Вердикт независимого оценщика — семантика `/goal` в [CC]. */
export type GoalVerdict = 'met' | 'not_met' | 'impossible'

/**
 * Цель чата (`/goal <условие>`).
 *
 * Модель [CC]: цель — это ОДНО условие завершения (до 4000 символов) плюс
 * независимый оценщик, который после каждого хода читает транскрипт и решает
 * met / not_met / impossible. Работу судит не тот, кто её делает.
 */
export interface ChatGoal {
  id: string
  chatId: string
  /** Условие завершения (одна строка). */
  objective: string
  /**
   * Устаревшее: машинные критерии старой версии (`file_contains:...`).
   * Новые цели создаются с пустым массивом — решение принимает оценщик.
   */
  criteria: string[]
  /** Устаревшее: ограничения старой версии. Новые цели — пустой массив. */
  constraints: string[]
  /** Лента вердиктов оценщика + заметки рантайма. */
  progress: string[]
  status: GoalStatus
  /** Сколько ходов оценено. */
  steps: number
  /** 0 — без лимита (как в [CC]: границы задаются клаузой в условии). */
  maxSteps: number
  createdAt: number
  /** Начало текущего цикла (для «идёт 4 мин»); сбрасывается при снятии с паузы. */
  startedAt: number
  updatedAt: number
  /** Свидетельства = вердикты оценщика с причиной. */
  evidence: string[]
  blocker?: string
  /** Сколько ходов оценщик уже проверил. */
  turnsEvaluated: number
  /** Накопленный расход токенов цикла цели (приблизительно). */
  tokensSpent: number
  /** Последний reason от оценщика — что делать дальше. */
  lastReason?: string
  /** Ходы подряд без вызова инструментов — защита от «болтовни» вместо работы. */
  idleTurns: number
}

/** Заполняет поля, которых не было в целях, сохранённых старой версией. */
export function normalizeGoal(goal: ChatGoal): ChatGoal {
  const now = Date.now()
  return {
    ...goal,
    criteria: Array.isArray(goal.criteria) ? goal.criteria : [],
    constraints: Array.isArray(goal.constraints) ? goal.constraints : [],
    progress: Array.isArray(goal.progress) ? goal.progress : [],
    evidence: Array.isArray(goal.evidence) ? goal.evidence : [],
    steps: Number.isFinite(goal.steps) ? Math.max(0, Math.floor(goal.steps)) : 0,
    maxSteps: Number.isFinite(goal.maxSteps) ? Math.max(0, Math.floor(goal.maxSteps)) : 0,
    startedAt: Number.isFinite(goal.startedAt) ? goal.startedAt : (goal.createdAt ?? now),
    turnsEvaluated: Number.isFinite(goal.turnsEvaluated) ? Math.max(0, Math.floor(goal.turnsEvaluated)) : 0,
    tokensSpent: Number.isFinite(goal.tokensSpent) ? Math.max(0, Math.floor(goal.tokensSpent)) : 0,
    idleTurns: Number.isFinite(goal.idleTurns) ? Math.max(0, Math.floor(goal.idleTurns)) : 0,
  }
}
