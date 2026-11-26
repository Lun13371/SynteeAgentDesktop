/**
 * §orchestration — ОДИН мерж/кап прогресса фаз для main и renderer.
 *
 * Раньше мерж был продублирован: `main/ipc/orchestrationRun.ts` и
 * `renderer/src/utils/orchestrationProgress.ts` — и оба склеивали записи
 * ТОЛЬКО по `phase`. Из-за этого повтор фазы во втором круге (executing →
 * replanning → executing, review → replan → review) затирал предыдущую
 * запись: история кругов терялась, а таймер карточки «прыгал» (startedAt
 * заменялся на более поздний). Здесь единственная реализация; оба конца
 * только реэкспортируют её, чтобы live-карточка и персист не расходились.
 *
 * Идентичность записи: `phase` + `startedAt` (без коллизий в миллисекундах
 * помогает опциональный `seq`, который мерж проставляет сам, — разные
 * вхождения одной фазы, случайно стартовавшие в одну мс, всё равно остаются
 * разными записями). Одно вхождение фазы (running → done) обновляется на
 * месте; устаревшие/повторно доставленные события отбрасываются.
 *
 * Типы контракта живут в shared/orchestration.ts (этот файл их не меняет).
 */
import type { OrchestrationPhase, OrchestrationProgress } from './orchestration'

/** Максимум символов detail в персистентном (слим) снапшоте фазы. */
export const ORCH_DETAIL_MAX = 200
/** Потолок записей: фаз четыре, но циклы replan/review дают повторы. */
export const ORCH_PHASES_MAX = 8
/** Потолок сохранённого плана: уходит в промпт продолжения и в снапшот БД. */
export const ORCH_PLAN_MAX = 6000

/** Порядок фаз — только как tie-break для записей с одинаковым startedAt. */
const PHASE_ORDER: Record<OrchestrationPhase, number> = {
  planning: 0,
  replanning: 1,
  executing: 2,
  reviewing: 3,
}

/**
 * Запись прогресса + необязательный `seq`. Мерж проставляет seq сам (счётчик
 * вхождений фазы в списке), чтобы различать повторы, стартовавшие в одну и ту
 * же миллисекунду. В БД seq не попадает (см. slimOrchestrationPhases —
 * собирает запись по whitelist полей), поэтому после рестарта идентичность
 * снова определяется парой phase+startedAt.
 */
export type OrchestrationProgressEntry = OrchestrationProgress & { seq?: number }

function normalizeStart(startedAt: unknown): number {
  return typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : 0
}

/**
 * Поиск записи, которую обновляет событие.
 * - Событие с явным `seq` адресует ровно это вхождение фазы.
 * - Без seq — ПОСЛЕДНЕЕ вхождение той же фазы с тем же startedAt: события
 *   одного перехода (running → done) несут одинаковый startedAt, поэтому
 *   обновляют свою запись, а не плодят дубли; повторный круг той же фазы
 *   (startedAt другой либо тот же мс) трактуется как новая запись (см. merge).
 */
function findEntryIndex(
  list: OrchestrationProgressEntry[],
  incoming: OrchestrationProgressEntry,
): number {
  const seq = incoming.seq
  if (typeof seq === 'number' && Number.isFinite(seq)) {
    return list.findIndex(p => p.phase === incoming.phase && p.seq === seq)
  }
  const start = normalizeStart(incoming.startedAt)
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i]
    if (p.phase === incoming.phase && normalizeStart(p.startedAt) === start) return i
  }
  return -1
}

function nextSeq(list: OrchestrationProgressEntry[]): number {
  let max = 0
  for (const p of list) if (typeof p.seq === 'number' && p.seq > max) max = p.seq
  return max + 1
}

/** Порядок отображения: старт → вхождение → последнее обновление. */
export function compareOrchestrationPhases(
  a: OrchestrationProgressEntry,
  b: OrchestrationProgressEntry,
): number {
  return (a.startedAt ?? 0) - (b.startedAt ?? 0)
    || (a.seq ?? 0) - (b.seq ?? 0)
    || (a.updatedAt ?? 0) - (b.updatedAt ?? 0)
    || PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase]
}

/**
 * Потолок списка с сохранением истории: оставляем ПЕРВУЮ запись (якорь
 * таймера карточки — min startedAt) и хвост из последних `max - 1` фаз.
 * `slice(-max)` (как было) отрезал начало — таймер после обрезки показывал
 * время последнего круга, а не всего рана.
 */
export function capOrchestrationPhases<T extends OrchestrationProgress>(
  phases: T[],
  max = ORCH_PHASES_MAX,
): T[] {
  if (!Array.isArray(phases)) return []
  if (max <= 0) return []
  if (phases.length <= max) return phases
  const tail = phases.slice(phases.length - (max - 1))
  return [phases[0], ...tail]
}

/**
 * Мерж очередного события фазы в накопленный список.
 *
 * 1. Запись ищется по `phase` + `startedAt` (или `seq`, если он есть) —
 *    повторный круг той же фазы ДОБАВЛЯЕТ запись, а не затирает прошлую.
 * 2. `status:'running'` по уже закрытой записи (done/blocked) — новый круг,
 *    а не обновление статуса: добавляем запись (seq разводит вхождения,
 *    стартовавшие в ту же миллисекунду). Запоздавшее running со startedAt
 *    РАНЬШЕ закрытия предыдущего круга — устаревшее, отбрасываем.
 * 3. Событие старше сохранённого (updatedAt меньше) — устаревшее: игнорируем,
 *    чтобы запоздавшая доставка не откатывала статус и не двигала таймер.
 * 4. Результат отсортирован и обрезан capOrchestrationPhases — история не
 *    растёт без границ.
 */
export function mergeOrchestrationProgress(
  prev: OrchestrationProgressEntry[] | null | undefined,
  incoming: OrchestrationProgress | null | undefined,
  max = ORCH_PHASES_MAX,
): OrchestrationProgressEntry[] {
  const list: OrchestrationProgressEntry[] = Array.isArray(prev) ? prev.slice() : []
  if (!incoming || !incoming.phase) return list

  const incomingUpdated = incoming.updatedAt ?? 0
  const idx = findEntryIndex(list, incoming)
  if (idx >= 0) {
    const existing = list[idx]
    const existingUpdated = existing.updatedAt ?? 0
    if (incoming.status === 'running' && existing.status !== 'running') {
      // running по закрытой записи — либо новый круг, либо запоздавшее событие.
      // Новый круг не может начаться раньше, чем закрылся предыдущий:
      // startedAt >= updatedAt (равенство — старт в ту же миллисекунду,
      // seq разведёт записи). Иначе событие устаревшее — игнорируем.
      if (normalizeStart(incoming.startedAt) < existingUpdated) return list
      list.push({ ...incoming, seq: nextSeq(list) })
    } else {
      // Устаревшее (запоздавшее/повторное) событие — не откатываем прогресс.
      if (incomingUpdated < existingUpdated) return list
      // Идемпотентная повторная доставка того же перехода.
      if (incomingUpdated === existingUpdated && existing.status === incoming.status) return list
      list[idx] = { ...existing, ...incoming, seq: existing.seq ?? nextSeq(list) }
    }
  } else {
    // Новое вхождение. Но если по этой же фазе уже есть запись с БОЛЕЕ
    // поздним стартом — это запоздавшая доставка потерянного события:
    // вставлять её в середину истории нельзя (иначе «running» повиснет
    // в прошлом и таймер поедет). Такие события дедуплицируем.
    const start = normalizeStart(incoming.startedAt)
    if (list.some(p => p.phase === incoming.phase && normalizeStart(p.startedAt) > start)) return list
    list.push({ ...incoming, seq: nextSeq(list) })
  }

  list.sort(compareOrchestrationPhases)
  return capOrchestrationPhases(list, max)
}

/**
 * Слим-снапшот для персиста (Message.orchestration): whitelist полей,
 * урезанный detail, порядок и потолок записей. seq сюда НЕ попадает —
 * в БД лежит только то, что нужно карточке.
 */
export function slimOrchestrationPhases(
  phases: OrchestrationProgress[] | null | undefined,
): OrchestrationProgress[] | undefined {
  if (!phases || phases.length === 0) return undefined
  const slim: OrchestrationProgressEntry[] = phases.map((p) => {
    const model = p.model
    const entry: OrchestrationProgress = {
      phase: p.phase,
      model: {
        providerId: typeof model?.providerId === 'string' ? model.providerId : '',
        modelId: typeof model?.modelId === 'string' ? model.modelId : '',
      },
      startedAt: p.startedAt,
      updatedAt: p.updatedAt,
      status: p.status,
    }
    if (model?.reasoningValue) entry.model.reasoningValue = model.reasoningValue
    if (p.detail) entry.detail = String(p.detail).slice(0, ORCH_DETAIL_MAX)
    // План нужен кнопке «Продолжить»: без него продолжение планирует заново.
    if (p.plan) entry.plan = String(p.plan).slice(0, ORCH_PLAN_MAX)
    const seq = (p as OrchestrationProgressEntry).seq
    return typeof seq === 'number' ? { ...entry, seq } : entry
  })
  slim.sort(compareOrchestrationPhases)
  // seq — внутренняя деталь мержа (порядок вхождений в одну мс): в снапшот
  // сообщения он не попадает, собираем запись по whitelist полей.
  return capOrchestrationPhases(slim, ORCH_PHASES_MAX).map((p) => {
    const entry: OrchestrationProgress = {
      phase: p.phase,
      model: p.model,
      startedAt: p.startedAt,
      updatedAt: p.updatedAt,
      status: p.status,
    }
    if (p.detail) entry.detail = p.detail
    if (p.plan) entry.plan = p.plan
    return entry
  })
}

/**
 * Обрыв/Стоп/ошибка/рекавери после краша: фаза, оставшаяся в статусе
 * 'running', закрывается как 'blocked' — иначе карточка навсегда показывала
 * бы «выполняется» и тикала живым таймером.
 */
export function blockRunningOrchestrationPhase(
  phases: OrchestrationProgress[] | null | undefined,
  detail: string,
  at = Date.now(),
): OrchestrationProgress[] {
  if (!phases || phases.length === 0) return []
  return phases.map(p => (p.status === 'running'
    ? { ...p, status: 'blocked' as const, detail: detail.slice(0, ORCH_DETAIL_MAX), updatedAt: at }
    : p))
}
