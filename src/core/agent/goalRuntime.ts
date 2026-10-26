import type { ChatGoal, GoalStatus, GoalVerdict } from '../../shared/types/goal'
import { normalizeGoal } from '../../shared/types/goal'
import { isUnrecoverableGoalError, type GoalJudge } from './goalEvaluator'

export type GoalDecision = 'continue' | 'stop' | 'stalled'

const VERDICT_LABEL: Record<GoalVerdict, string> = {
  met: 'выполнено',
  not_met: 'ещё нет',
  impossible: 'невозможно',
}

/**
 * Рантайм цели для одного прогона агента.
 *
 * Отличия от старой версии (семантика [CC]):
 *  - завершение решает независимый оценщик по транскрипту, а не JSON-отчёт
 *    самой модели («слова модели не подтверждение»);
 *  - нет искусственного лимита времени (10 минут) и лимита tool-вызовов —
 *    границы задаются клаузой в самом условии; `maxSteps` остаётся
 *    опциональным предохранителем (0 = без лимита);
 *  - «болтовня» без инструментов останавливает цикл, но цель НЕ снимается —
 *    она продолжится со следующим сообщением пользователя.
 */
export class GoalRuntime {
  readonly goal: ChatGoal
  private hadToolActivity = false

  constructor(
    goal: ChatGoal,
    private persist: (goal: ChatGoal) => void,
    private judge: GoalJudge,
  ) {
    this.goal = normalizeGoal(goal)
    this.goal.progress = [...this.goal.progress]
    this.goal.evidence = []
    this.goal.blocker = undefined
  }

  get active(): boolean { return this.goal.status === 'running' }

  save(): void {
    this.goal.updatedAt = Date.now()
    this.persist({ ...this.goal, progress: [...this.goal.progress], evidence: [...this.goal.evidence] })
  }

  note(text: string): void {
    this.goal.progress.push(text.slice(0, 500))
    this.goal.progress = this.goal.progress.slice(-100)
    this.save()
  }

  stop(status: GoalStatus, reason: string): void {
    this.goal.status = status
    this.goal.blocker = reason
    this.save()
  }

  addTokens(tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return
    this.goal.tokensSpent += Math.floor(tokens)
  }

  /** Системная инструкция для основного агента (не отчёт, а постановка задачи). */
  instruction(): string {
    const elapsed = Math.max(0, Math.round((Date.now() - this.goal.startedAt) / 60_000))
    return `[goal] Active completion condition: ${JSON.stringify(this.goal.objective)}. ` +
      'Keep working until the condition actually holds — a separate evaluator reads the transcript after every turn, ' +
      'so your own claim of completion is not evidence: run the check and let its real output appear in the conversation. ' +
      'If the condition cannot be satisfied, say so explicitly and why. ' +
      'Do not bypass tool approvals or repeat irreversible side effects without checking the current state. ' +
      `Status: turn ${this.goal.turnsEvaluated} evaluated, ${this.goal.steps} rounds, ~${this.goal.tokensSpent} tokens, ${elapsed} min.` +
      (this.goal.lastReason ? ` Last verdict: not yet met — ${this.goal.lastReason}` : '')
  }

  /** Начало раунда. Возвращает причину остановки, если предохранитель сработал. */
  beginRound(): string | undefined {
    if (this.goal.maxSteps > 0 && this.goal.steps >= this.goal.maxSteps) {
      return `Goal round budget exhausted (${this.goal.maxSteps}); raise it in the goal card or run /goal again`
    }
    this.goal.steps++
    this.save()
    return undefined
  }

  /** Отмечает активность инструментов (нужно для stall-детекта). */
  reserveTool(): boolean {
    if (!this.active) return false
    this.hadToolActivity = true
    return true
  }

  /**
   * Ход завершился финальным ответом — оценщик выносит вердикт.
   * transcript — компактная выжимка переписки (см. formatTranscript).
   */
  async evaluate(transcript: string): Promise<GoalDecision> {
    if (!this.active) return 'stop'
    const turn = this.goal.turnsEvaluated + 1
    let verdict: GoalVerdict
    let reason: string
    try {
      const result = await this.judge({ condition: this.goal.objective, transcript, turn })
      verdict = result.verdict
      reason = result.reason
    } catch (error) {
      // Транспортная ошибка оценщика — не приговор цели: продолжаем работу,
      // но без вердиктов цикл не должен крутиться вечно.
      const message = error instanceof Error ? error.message : String(error)
      this.note(`Ход ${turn}: оценщик недоступен (${message.slice(0, 200)})`)
      this.goal.idleTurns++
      if (this.goal.idleTurns >= 3) return 'stalled'
      return 'continue'
    }
    this.goal.turnsEvaluated = turn
    this.goal.lastReason = reason
    const label = VERDICT_LABEL[verdict]
    this.goal.progress.push(`Ход ${turn}: ${label}${reason ? ` — ${reason}` : ''}`)
    this.goal.progress = this.goal.progress.slice(-100)
    this.goal.evidence.push(`Ход ${turn} · ${label}: ${reason || 'без пояснения'}`)
    this.goal.evidence = this.goal.evidence.slice(-50)
    if (verdict === 'met') {
      this.stop('completed', reason || 'Условие выполнено')
      return 'stop'
    }
    if (verdict === 'impossible') {
      this.stop('blocked', reason || 'Условие невыполнимо')
      return 'stop'
    }
    if (this.hadToolActivity) this.goal.idleTurns = 0
    else this.goal.idleTurns++
    this.hadToolActivity = false
    if (this.goal.idleTurns >= 3) {
      // Как в [CC]: цикл останавливается с предупреждением, цель остаётся set.
      this.goal.progress.push('Цикл остановлен: три хода подряд без инструментов. Отправь сообщение, чтобы продолжить.')
      this.goal.progress = this.goal.progress.slice(-100)
      this.save()
      return 'stalled'
    }
    this.save()
    return 'continue'
  }

  /** Ошибка прогона: необратимые снимают цель, транзиентные оставляют активной. */
  handleError(message: string): void {
    if (isUnrecoverableGoalError(message)) {
      this.stop('blocked', `Цель снята после неисправимой ошибки: ${message.slice(0, 300)}. Запусти /goal заново.`)
      return
    }
    this.note(`Ошибка прогона: ${message.slice(0, 200)} — цель остаётся активной`)
  }
}
