// ── Orchestration progress: renderer-хелперы карточки прогресса ────────
// Типы контракта живут в shared/orchestration.ts (их использует и backend);
// здесь — только мерж фаз и подписи для UI. Renderer получает прогресс из
// двух источников:
//   1) live — IPC-событие `agent:orchestration_progress` (+ `orchestration`
//      в chat live state payload при возврате в чат);
//   2) history — persisted Message.orchestration (из БД).
// Никаких сабагентов: один ран — один плоский список фаз.
import type {
  OrchestrationModel,
  OrchestrationPhase,
  OrchestrationProgress,
} from '../../../shared/orchestration'

export type { OrchestrationModel, OrchestrationPhase, OrchestrationProgress }

// Мерж фаз — ОДНА реализация на main и renderer (shared/orchestrationProgress):
// повтор фазы (второй круг executing/reviewing) сохраняется отдельной записью,
// устаревшие события отбрасываются, потолок не режет якорь таймера.
export {
  ORCH_DETAIL_MAX,
  ORCH_PHASES_MAX,
  capOrchestrationPhases,
  compareOrchestrationPhases,
  mergeOrchestrationProgress,
  type OrchestrationProgressEntry,
} from '../../../shared/orchestrationProgress'

/** Подписи фаз — те же термины, что в shared-контракте (UI на английском,
 *  как и лента сабагентов AgentCard). */
export const ORCH_PHASE_LABEL: Record<OrchestrationPhase, string> = {
  planning: 'Planning',
  executing: 'Executing',
  reviewing: 'Reviewing',
  replanning: 'Replanning',
}

/** Короткое имя модели для чипа: последний сегмент modelId. */
export function orchestrationModelLabel(model?: OrchestrationModel | null): string {
  if (!model?.modelId) return '…'
  const parts = model.modelId.split('/')
  return parts[parts.length - 1] || model.modelId
}

/** Полное описание модели для title-подсказки. */
export function orchestrationModelTitle(model?: OrchestrationModel | null): string {
  if (!model) return ''
  const base = [model.providerId, model.modelId].filter(Boolean).join(' · ')
  return model.reasoningValue ? `${base} · thinking: ${model.reasoningValue}` : base
}

/** Длительность в человекочитаемом виде: 12s / 1m 05s / 1h 02m. */
export function formatOrchestrationElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  if (total < 3600) return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`
  return `${Math.floor(total / 3600)}h ${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`
}
