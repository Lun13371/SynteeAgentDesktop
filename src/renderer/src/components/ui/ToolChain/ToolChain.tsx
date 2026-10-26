import { useState, useEffect, useRef, memo, useMemo, useCallback, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import ToolResultRenderer from './ToolResultRenderer'
import ThinkingBlock from '../ThinkingBlock/ThinkingBlock'
import type { ToolOutputMode } from '../../../../../shared/types'
import { getSubagentRole } from '../../../../../shared/subagent-roles'
import { useChatRemeasure } from '../MessageBubble/remeasure'
import { removePendingSteer } from '../../../hooks/chatRunRuntime'

import { getToolMeta } from '../../../../../shared/toolMeta'
import { isFinalAnswerToolName } from '../../../../../shared/finalAnswer'
import './ToolChain.css'

export interface ToolStep {
  id: string
  /** 'steer' — реплика пользователя, внедрённая в контекст активного рана
   *  (long-press на кнопке отправки). Рендерится отдельной карточкой ленты. */
  type: 'tool_call' | 'tool_result' | 'steer'
  toolName?: string
  toolArgs?: Record<string, unknown>
  content: string
  success?: boolean
  timestamp: number
  imageUrl?: string
  diff?: string  // unified diff для edit_file
  callId?: string  // id tool_call из API — для матчинга call↔result при параллельных тулах
  /** Имя MCP-сервера для MCP-тулов (mcp__server__tool). */
  serverName?: string
  // true — модель только начала вызывать этот тул, аргументы ещё не собраны
  // (см. tool_call_pending в Agent.ts). Карточка показывает "готовится" без
  // аргументов, заменяется на обычный tool_call in-place когда придёт полный.
  pending?: boolean
  // Native analyze_image lifecycle (основная модель получает пиксели напрямую).
  // 'pending' — пиксели уже отданы модели, визуальный ответ ещё идёт; позже
  // приходит tool_result_update с 'responded' (+findings) или 'failed'.
  // Персистентный 'pending' (Стоп/ошибка) = незавершённый анализ.
  visualAnalysis?: {
    status: 'pending' | 'responded' | 'failed'
    findings?: string
  }
  codeMode?: {
    code: string
    trace?: Array<{ name: string; args: unknown; result: string; status: 'success' | 'failure' }>
  }
  /** §steer: id реплики (ключ оптимистичной карточки) и признак применения. */
  steerId?: string
  steerApplied?: boolean
}

// Группируем шаги: каждая итерация = один вызов тула + его результат
interface Iteration {
  id: string
  call: ToolStep
  result?: ToolStep
}

function buildIterations(steps: ToolStep[]): Iteration[] {
  // publish_result удалён из тулсета — старые сообщения ещё содержат эти шаги.
  // Скрываем их, чтобы в ленте не оставалось карточки несуществующего тула.
  steps = steps.filter(s => s.toolName !== 'publish_result')
  // §final-answer — в старых сообщениях остались «вызовы» тула final_answer
  // (модель спутала служебный тег с функцией). В ленте им делать нечего.
  steps = steps.filter(s => !isFinalAnswerToolName(s.toolName))
  const iters: Iteration[] = []
  const calls = steps.filter(s => s.type === 'tool_call')
  const results = steps.filter(s => s.type === 'tool_result')

  // Сначала матчим строго по callId — это единственный надёжный ключ при
  // параллельных тулах (Promise.all в Agent.ts создаёт несколько
  // tool_call одновременно с одним toolName). Раньше дальше шёл жадный
  // фолбэк «первый незаматченный result», который мог присвоить чужой
  // результат не тому вызову → реальный вызов оставался без result →
  // спиннер «Выполняется…» крутился бесконечно (running=true пока
  // !iter.result). Теперь фолбэк только по toolName среди resultless
  // вызовов, и orphan-результаты рендерятся как собственные итерации.
  const matchedResultIds = new Set<string>()
  for (const call of calls) {
    let result: ToolStep | undefined
    if (call.callId) {
      result = results.find(r => r.callId === call.callId)
    }
    if (!result) {
      // Fallback: первый незаматченный result с тем же toolName (без
      // чужого callId или с callId, которому уже нашли свою пару).
      result = results.find(r =>
        r.toolName === call.toolName &&
        !matchedResultIds.has(r.id) &&
        (!r.callId || r.callId === call.callId)
      )
    }
    if (result) {
      matchedResultIds.add(result.id)
    }
    iters.push({ id: call.id, call, result })
  }

  // Orphan-результаты (_error, _limit, _loop_guard, _verification) не имеют
  // парного tool_call — раньше дропались или примагничивались к чужой
  // итерации через жадный фолбэк. Теперь рендерим как собственные
  // синтетические итерации, чтобы пользователь видел причину остановки.
  for (const result of results) {
    if (matchedResultIds.has(result.id)) continue
    // Синтетический call с тем же toolName — итерация выглядит как обычный
    // тул, но без аргументов (call.content = toolName).
    const synthCall: ToolStep = {
      id: `${result.id}-synth`,
      type: 'tool_call',
      toolName: result.toolName,
      toolArgs: undefined,
      content: result.toolName ?? 'tool',
      success: undefined,
      timestamp: result.timestamp,
      callId: result.callId,
    }
    iters.push({ id: synthCall.id, call: synthCall, result })
  }

  return iters
}

/** true, если в steps есть tool_call без парного результата. Параллельные
 *  тулы (Promise.all в Agent.ts) завершаются по очереди: первый tool_result
 *  встаёт последним шагом, пока остальные вызовы ещё выполняются. Используется
 *  MessageBubble для isRunning тулчейна — «последний шаг = результат» больше
 *  не означает «раунд завершён». Матчинг как в buildIterations: callId,
 *  fallback toolName с потреблением результата (matched-Set). */
export function hasUnfinishedCalls(steps: ToolStep[]): boolean {
  const calls = steps.filter(s => s.type === 'tool_call')
  if (calls.length === 0) return false
  const results = steps.filter(s => s.type === 'tool_result')
  const matched = new Set<string>()
  for (const c of calls) {
    const r = results.find(x =>
      !matched.has(x.id) &&
      ((c.callId && x.callId === c.callId) ||
        (x.toolName === c.toolName && (!x.callId || x.callId === c.callId)))
    )
    if (!r || r.visualAnalysis?.status === 'pending') return true
    matched.add(r.id)
  }
  return false
}

// ── Единая лента хода работы ─────────────────────────────────────────
// В одном сообщении несколько итераций (текст → тулы → текст → тулы). Раньше
// на каждую итерацию рисовался свой ToolChain — в чате появлялась стопка
// «Выполнено за 356мс · 1 действие» / «… 21мс · 1 действие». Теперь сообщение
// отдаёт СЕКЦИИ (итерации) в один ToolChain: одна шапка «Выполнено за 22с ·
// 3 действия» и одна раскрывающаяся лента, где рассуждение и тулы идут
// подряд, как в референсе (Think → тулы → Think).
export interface ToolChainSection {
  thinking?: string
  thinkingMs?: number
  /** Текст, который модель написала перед этими тулами (обычный текст, не
   *  рассуждение). Живёт внутри ленты — сворачивается вместе с ходом работы. */
  text?: string
  steps: ToolStep[]
}

// Схлопываем длинные цепочки однотипных тулов (6 read_file подряд) в
// одну раскрывающуюся группу. Только в финальном состоянии (!isRunning),
// чтобы во время live-прогона не дезориентировать внезапным коллапсом.
// get_fast_context и spawn_agent не группируем: у них внутри ленты живут
// собственные карточки (FastContextBlock / карточка саб-агента) — в группе
// они бы исчезли вместе с телом шага.
const NO_GROUP_TOOLS = new Set(['spawn_agent', 'ask_user', 'update_todo', 'get_fast_context'])

type ChainEntry =
  | { kind: 'thinking'; key: string; text: string; ms?: number; si: number }
  | { kind: 'text'; key: string; text: string; si: number }
  | { kind: 'single'; key: string; iter: Iteration; si: number }
  | { kind: 'group'; key: string; meta: ReturnType<typeof getToolMeta>; iters: Iteration[]; si: number }
  | { kind: 'steer'; key: string; step: ToolStep; si: number }

/**
 * §steer — шаги итерации в ХРОНОЛОГИЧЕСКОМ порядке: обычные тулы группируются
 * в Iteration (call+result), а карточки внедрённых реплик остаются отдельными
 * записями. Без этого steer-шаг (у него нет пары call/result) просто выпадал
 * бы из ленты: buildIterations фильтрует только tool_call/tool_result.
 */
function buildSectionItems(
  steps: ToolStep[],
): Array<{ kind: 'iter'; iter: Iteration } | { kind: 'steer'; step: ToolStep }> {
  const out: Array<{ kind: 'iter'; iter: Iteration } | { kind: 'steer'; step: ToolStep }> = []
  let segment: ToolStep[] = []
  const flush = () => {
    if (segment.length === 0) return
    for (const iter of buildIterations(segment)) out.push({ kind: 'iter', iter })
    segment = []
  }
  for (const step of steps) {
    if (step.type === 'steer') {
      flush()
      out.push({ kind: 'steer', step })
    } else {
      segment.push(step)
    }
  }
  flush()
  return out
}

function buildChain(
  sectionIters: Iteration[][],
  sections: Array<{ thinking?: string; thinkingMs?: number; text?: string; steps?: ToolStep[] }>,
  isRunning: boolean,
): ChainEntry[] {
  const flat: ChainEntry[] = []
  sectionIters.forEach((iters, si) => {
    const sec = sections[si] ?? {}
    if (sec.thinking) flat.push({ kind: 'thinking', key: `th-${si}`, text: sec.thinking, ms: sec.thinkingMs, si })
    if (sec.text) flat.push({ kind: 'text', key: `tx-${si}`, text: sec.text, si })
    // §steer: идём по raw-steps секции, чтобы карточка реплики встала на своё
    // место в ленте. Для секций без steer результат идентичен iters.
    const items = sec.steps ? buildSectionItems(sec.steps) : iters.map(iter => ({ kind: 'iter' as const, iter }))
    for (const item of items) {
      if (item.kind === 'steer') flat.push({ kind: 'steer', key: `steer-${item.step.id}`, step: item.step, si })
      else flat.push({ kind: 'single', key: item.iter.id, iter: item.iter, si })
    }
  })
  if (isRunning) return flat

  const out: ChainEntry[] = []
  let i = 0
  while (i < flat.length) {
    const entry = flat[i]
    if (entry.kind !== 'single') { out.push(entry); i++; continue }
    const name = entry.iter.call.toolName
    const noGroup = !name || NO_GROUP_TOOLS.has(name)
    let j = i + 1
    if (!noGroup) {
      // Рассуждение/текст разрывает серию: внутри группы их не спрятать.
      while (j < flat.length && flat[j].kind === 'single' && (flat[j] as { iter: Iteration }).iter.call.toolName === name) j++
    }
    if (!noGroup && j - i >= 3) {
      const slice = flat.slice(i, j) as Array<{ kind: 'single'; iter: Iteration; si: number }>
      out.push({
        kind: 'group',
        key: `group-${entry.iter.id}`,
        meta: getToolMeta(name, entry.iter.call.serverName),
        iters: slice.map(s => s.iter),
        si: entry.si,
      })
    } else {
      for (let k = i; k < j; k++) out.push(flat[k])
    }
    i = j
  }
  return out
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}мс`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}с`
  return `${Math.floor(ms / 60000)}м ${Math.round((ms % 60000) / 1000)}с`
}

// Время для итоговой фразы «Выполнено за 22с»: длинные прогоны — целые
// секунды (десятая доля там не несёт смысла и удлиняет строку).
function formatDoneDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}мс`
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}с`
  if (ms < 60000) return `${Math.round(ms / 1000)}с`
  return `${Math.floor(ms / 60000)}м ${Math.round((ms % 60000) / 1000)}с`
}

function truncate(s: string, n = 80) {
  return s.length > n ? s.slice(0, n) + '…' : s
}

/**
 * §steer — карточка реплики пользователя, внедрённой в контекст РАБОТАЮЩЕГО
 * агента (удержание кнопки отправки или Enter). Два состояния:
 *   • applied=false — «ждёт границы раунда»: агент ещё не дошёл до точки
 *     вставки (идёт долгий тул/стрим). Пульсируем + крестик «передумал»:
 *     пока реплика не вставлена в messages, её можно снять целиком.
 *   • applied=true — «внедрено в контекст», реплика стала частью messages;
 *     откат здесь невозможен (только откатом сообщения), крестика нет.
 * Карточка не является тулом и не попадает в счётчик «N действий».
 */
const SteerCard = memo(function SteerCard({ step, chatId }: { step: ToolStep; chatId?: string }) {
  const applied = step.steerApplied !== false
  const steerId = step.steerId
  const canCancel = !applied && !!chatId && !!steerId
  const handleCancel = useCallback(() => {
    if (!chatId || !steerId) return
    // Сначала убираем карточку локально (мгновенный отклик), затем говорим
    // main снять реплику из очереди Agent'а — иначе она всё равно внедрится.
    removePendingSteer(chatId, steerId)
    void window.syntee.chat.steerCancel(chatId, steerId)
  }, [chatId, steerId])
  return (
    <motion.div
      className={`tc2-steer${applied ? ' tc2-steer--applied' : ' tc2-steer--pending'}`}
      initial={{ opacity: 0, y: -3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 460, damping: 32 }}
    >
      <div className="tc2-rail">
        <div className={`tc2-dot ${applied ? 'tc2-dot--steer' : 'tc2-dot--steer-pending'}`}>
          <AppIcon name="zap" size="xs" />
        </div>
      </div>
      <div className="tc2-iter-body tc2-steer-body">
        <div className="tc2-steer-head">
          <span className="tc2-steer-label">Вы — во время работы</span>
          <span className={`tc2-steer-state${applied ? ' tc2-steer-state--applied' : ''}`}>
            {applied ? 'внедрено в контекст' : 'ждёт границы раунда'}
          </span>
          {canCancel && (
            <button
              className="tc2-steer-cancel"
              onClick={handleCancel}
              title="Отменить: реплика не попадёт в контекст агента"
              aria-label="Отменить внедрение реплики"
            >
              <AppIcon name="x" size="xs" />
            </button>
          )}
        </div>
        <div className="tc2-steer-text">{step.content}</div>
      </div>
    </motion.div>
  )
}, (prev, next) => prev.step === next.step && prev.chatId === next.chatId)

function CodeModeDetails({ details }: { details: NonNullable<ToolStep['codeMode']> }) {
  const trace = details.trace ?? []
  return (
    <div className="tc2-section">
      <div className="tc2-section-title" style={{ color: '#a78bfa' }}>TypeScript Code Mode</div>
      <details className="tc2-code-details">
        <summary>Показать программу и внутренние вызовы ({trace.length})</summary>
        <pre className="tc2-code-block">{details.code}</pre>
        {trace.length > 0 && (
          <div className="tc2-code-trace">
            {trace.map((entry, index) => (
              <div key={`${entry.name}-${index}`} className={`tc2-code-trace-row tc2-code-trace-row--${entry.status}`}>
                <code>{entry.name}</code>
                <span>{entry.status === 'success' ? '✓' : '✗'}</span>
                <span>{entry.result}</span>
              </div>
            ))}
          </div>
        )}
      </details>
    </div>
  )
}

// ANSI-стрипинг для renderer (нельзя импортировать из _shared.ts — там Node-зависимости).
// Та же логика что stripAnsi в core/tools/_shared.ts.
function stripAnsiRenderer(text: string): string {
  if (!text) return text
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[^[\]]/g, '')
    .replace(/[\b]/g, '')
}

// ── Live-вывод команды пока она выполняется ──────────────────────────
// Подписывается на pty:data для sessionId, стримит plain-text (ANSI стрипнут,
// маркер __SYNTEE_DONE вырезан) в <pre> с авто-скроллом. rAF-throttle чтобы
// не ре-рендерить на каждый чанк. Buffer capped 50KB (хвост) — иначе длинный
// вывод (npm install) раздул бы DOM.
const LiveCommandOutput = memo(function LiveCommandOutput({ sessionId }: { sessionId: string }) {
  const [output, setOutput] = useState('')
  const bufRef = useRef('')
  const rafRef = useRef<number | null>(null)
  const pendingRef = useRef(false)
  const preRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    bufRef.current = ''
    setOutput('')
    const off = window.syntee.on('pty:data', (sid: unknown, data: unknown) => {
      if (sid !== sessionId) return
      const chunk = typeof data === 'string' ? data : ''
      if (!chunk) return
      // ANSI + маркер-огрызки
      const clean = stripAnsiRenderer(chunk)
        .replace(/__SYNTEE_DONE_[a-f0-9]+:\d+\s*$/m, '')
      bufRef.current += clean
      // Cap 50KB — оставляем хвост (самое свежее)
      if (bufRef.current.length > 50000) {
        bufRef.current = bufRef.current.slice(-50000)
      }
      if (!pendingRef.current) {
        pendingRef.current = true
        rafRef.current = requestAnimationFrame(() => {
          pendingRef.current = false
          setOutput(bufRef.current)
        })
      }
    })
    return () => {
      off()
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [sessionId])

  // Авто-скролл вниз при обновлении — только если пользователь и так у низа.
  // Раньше скроллили всегда: чтение середины вывода отрывалось потоком, а
  // каждый scrollTop=scrollHeight форсил синхронный layout 50KB-<pre> на
  // каждый rAF-апдейт → джанк во время долгих команд.
  useEffect(() => {
    const pre = preRef.current
    if (!pre) return
    const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 48
    if (nearBottom) pre.scrollTop = pre.scrollHeight
  }, [output])

  if (!output) return null
  return (
    <div className="tc2-section tc2-live-terminal">
      <div className="tc2-section-title">Вывод</div>
      <pre ref={preRef} className="tc2-live-terminal-pre">{output}</pre>
    </div>
  )
}, (prev, next) => prev.sessionId === next.sessionId)

// Цветной diff блок. memo + чанкование: большие diff'ы (тысячи строк) раньше
// монтировали div на КАЖДУЮ строку при раскрытии итерации → фриз. Теперь
// первые DIFF_CHUNK строк + кнопка «Показать ещё».
const DIFF_CHUNK = 500
const DiffBlock = memo(function DiffBlock({ diff }: { diff: string }) {
  const [extra, setExtra] = useState(0)
  const visible = DIFF_CHUNK + extra
  const lines = diff.split('\n').filter((_, i, arr) => {
    // Убираем пустую последнюю строку
    return !(i === arr.length - 1 && arr[i] === '')
  })
  const shown = lines.slice(0, visible)
  return (
    <div className="tc2-diff-pre">
      {shown.map((line, i) => {
        let cls = 'tc2-diff-line'
        if (line.startsWith('+++') || line.startsWith('---')) cls += ' tc2-diff-meta'
        else if (line.startsWith('+')) cls += ' tc2-diff-add'
        else if (line.startsWith('-')) cls += ' tc2-diff-del'
        else if (line.startsWith('@@')) cls += ' tc2-diff-hunk'
        else cls += ' tc2-diff-ctx'
        return <div key={i} className={cls}>{line || '\u00a0'}</div>
      })}
      {lines.length > visible && (
        <button className="tc2-show-more" onClick={() => setExtra(e => e + DIFF_CHUNK)}>
          Показать ещё {Math.min(DIFF_CHUNK, lines.length - visible)} из {lines.length} строк
        </button>
      )}
    </div>
  )
}, (prev, next) => prev.diff === next.diff)

// Один блок итерации
const IterationBlock = memo(function IterationBlock({
  iter, isLast, isRunning, mode, liveSessionId, animateEntrance, autoOpen,
}: {
  iter: Iteration
  isLast: boolean
  isRunning: boolean
  mode: ToolOutputMode
  liveSessionId?: string
  // Entrance-анимация только у последнего (нового) шага живой ленты.
  // Раньше флаг стоял у всех и каскадная задержка index*0.04 давала до 4с
  // «пустоты» при раскрытии длинной цепочки, а смена флага перезапускала
  // анимацию у всех шагов разом.
  animateEntrance: boolean
  // Шаг в «окне» последних N действий живой ленты — тело раскрыто
  // автоматически. Старые шаги выпадают из окна и плавно сворачиваются.
  autoOpen: boolean
}) {
  const remeasure = useChatRemeasure()
  const meta = getToolMeta(iter.call.toolName, iter.call.serverName)
  const failed = iter.result?.success === false
  // pending — модель ещё генерирует аргументы этого вызова (см. Agent.ts
  // tool_call_pending). Отличаем от "running" (тул реально исполняется в
  // Node), чтобы показать корректный текст, но визуально это тот же
  // "идёт работа, не зависло" индикатор.
  const pending = !!iter.call.pending
  // Раньше проверяли isLast — но при параллельных тулах (Promise.all в Agent.ts)
  // одновременно создаётся несколько итераций без результата, и спиннер/бейдж
  // показывался только у последней. Теперь "выполняется" — у любого тула без
  // результата, пока идёт живой стрим, независимо от позиции.
  const running = isRunning && !iter.result && !pending

  // Native analyze_image lifecycle: результат тула (handoff пикселей) уже есть,
  // но визуальный ответ основной модели ещё идёт / пришёл / не удался.
  const vaStatus = iter.result?.visualAnalysis?.status
  const vaFindings = iter.result?.visualAnalysis?.findings
  const vaPending = vaStatus === 'pending'
  const vaFailed = vaStatus === 'failed'
  // «Модель анализирует» — только при живом стриме; зависит от isRunning, а НЕ
  // от isLast (параллельные тулы). Персистентный pending (Стоп/ошибка) = прерван.
  const analyzing = vaPending && isRunning
  const analysisInterrupted = vaPending && !isRunning
  // Незавершённый/неудачный визуальный анализ — вместо зелёной галочки.
  const vaUnresolved = vaPending || vaFailed

  // ── Раскрытие тела: «окно последних N шагов» ──────────────────────────
  // Раньше тело открывалось по таймеру на каждый шаг и закрывалось по его
  // завершении — при быстрых тулах получалось «открылось и мгновенно
  // схлопнулось», плюс каждый шаг дёргал свою анимацию.
  // Теперь состояние ПРОИЗВОДНОЕ от позиции в ленте: последние AUTO_OPEN_LAST
  // шагов раскрыты, более старые автоматически сворачиваются (плавно, через
  // exit-анимацию AnimatePresence). Ручной клик перекрывает авто-режим и
  // больше не перебивается.
  const [manual, setManual] = useState<boolean | null>(null)
  // Отложенное включение авто-раскрытия на кадр: тело монтируется закрытым и
  // раскрывается уже анимированно (maxHeight 0→auto), а не «выскакивает».
  const [autoOpenNow, setAutoOpenNow] = useState(false)
  useEffect(() => {
    if (!autoOpen) return undefined
    const raf = requestAnimationFrame(() => setAutoOpenNow(true))
    return () => cancelAnimationFrame(raf)
  }, [autoOpen])

  // open производный: выпал из окна (autoOpen=false) → закрыт, без setState
  // в эффекте — закрытие идёт exit-анимацией AnimatePresence.
  const open = manual ?? (autoOpen && autoOpenNow)
  const toggleOpen = useCallback(() => {
    // Клик пользователя фиксирует выбор — авто-режим больше не применяется
    // к этому шагу (захотел развернул, захотел свернул).
    setManual(o => !(o ?? (autoOpen && autoOpenNow)))
  }, [autoOpen, autoOpenNow])

  // НЕТ авто-раскрытия при сбое: в больших чатах failed-итерации при скролле
  // монтировали полные тела (подсветка/diff) → фризы. Ошибка видна по бейджу
  // «ошибка» в заголовке — раскрытие по клику. (Во время live-прогона тело
  // и так уже раскрыто эффектом выше, так что ошибку видно сразу.)

  const statusColor = (failed || vaFailed) ? '#f87171' : meta.color

  // Тяжёлое тело (длинный вывод/diff): maxHeight-анимация framer-motion
  // гоняет layout ВСЕГО поддерева (Prism-спаны, diff-строки) каждый кадр
  // 0.22с → фриз при раскрытии больших результатов. Для тяжёлых тел
  // анимируем только opacity (height сразу auto, один layout на монтирование),
  // сворачивание/раскрытие мгновенное и без джанка.
  const bodyLen = (iter.result?.content?.length ?? 0) + (iter.result?.diff?.length ?? 0)
  const heavy = bodyLen > 3000

  // Preview в свёрнутом заголовке: для run_command берём именно args.command
  // (первое значение args может быть другим ключом), title показывает полный
  // текст — раньше команду было не видно нигде: preview обрезан 80 символами,
  // а в раскрытом теле аргументы показывались только в detailed-режиме.
  const previewText = iter.call.toolName === 'run_command'
    ? String(iter.call.toolArgs?.command ?? Object.values(iter.call.toolArgs ?? {})[0] ?? '')
    : String(Object.values(iter.call.toolArgs ?? {})[0] ?? '')

  return (
    <div
      className={`tc2-iter${animateEntrance ? ' tc2-iter--enter' : ''}`}
    >
      <div className="tc2-rail">
        <div
          className={`tc2-dot ${(running || pending || analyzing) ? 'tc2-dot--pulse' : ''} ${iter.result ? ((failed || vaFailed) ? 'tc2-dot--fail' : vaUnresolved ? '' : 'tc2-dot--done') : ''}`}
          style={{ '--dot-color': statusColor } as React.CSSProperties}
        >
          {vaUnresolved ? (
            // Результат-хендофф уже есть, но визуальный анализ не завершён —
            // глаз вместо зелёной галочки (пульс — только при живом стриме).
            <AppIcon name="eye" size="xs" />
          ) : iter.result && !failed ? (
            <svg className="tc2-dot-check" viewBox="0 0 16 16" fill="none">
              <path d="M3.5 8.5l3 3L12.5 5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : iter.result && failed ? (
            <svg className="tc2-dot-cross" viewBox="0 0 16 16" fill="none">
              <path d="M5 5l6 6M11 5l-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          ) : (
            <AppIcon name={meta.icon as 'zap'} size="xs" />
          )}
        </div>
        {!isLast && (
          <div className={`tc2-rail-line ${(failed || vaFailed) ? 'tc2-rail-line--fail' : iter.result && !vaUnresolved ? 'tc2-rail-line--ok' : ''}`} />
        )}
      </div>

      <div className="tc2-iter-body">
        <button
          className={`tc2-iter-header ${open ? 'tc2-iter-header--open' : ''} ${failed ? 'tc2-iter-header--fail' : ''} ${(running || pending || analyzing) ? 'tc2-iter-header--running' : ''}`}
          onClick={toggleOpen}
        >
          <span className="tc2-iter-icon" style={{ color: meta.color }}>
            <AppIcon name={meta.icon as 'zap'} size="sm" />
          </span>
          <span className="tc2-iter-label">{meta.label}</span>
          {meta.isMcp && meta.server && (
            <span className="tc2-iter-server">{meta.server}</span>
          )}
          {iter.call.toolName && !meta.isMcp && (
            <code className="tc2-iter-name">{iter.call.toolName}</code>
          )}
          {iter.call.toolName === 'spawn_agent' && typeof iter.call.toolArgs?.role === 'string' && (
            <span
              className="tc2-iter-role-badge"
              style={{ color: getSubagentRole(iter.call.toolArgs.role as string).color }}
            >
              {getSubagentRole(iter.call.toolArgs.role as string).nameEn}
            </span>
          )}


          {iter.call.toolArgs && !open && (
            <span className="tc2-iter-preview" title={previewText}>
              {truncate(previewText)}
            </span>
          )}

          <span className="tc2-iter-spacer" />

          {iter.result && iter.call.timestamp && iter.result.timestamp && (
            <span className="tc2-iter-duration">{formatDuration(iter.result.timestamp - iter.call.timestamp)}</span>
          )}

          {meta.isMcp && <span className="tc2-badge tc2-badge--mcp">MCP</span>}
          {pending && <span className="tc2-badge tc2-badge--running">готовится</span>}
          {running && <span className="tc2-badge tc2-badge--running">выполняется</span>}
          {failed && <span className="tc2-badge tc2-badge--fail">ошибка</span>}
          {/* Native analyze_image: pending-результат не «успех» — показываем
              живой анализ / прерванный / не удался вместо зелёной галочки. */}
          {analyzing && <span className="tc2-badge tc2-badge--running">модель анализирует</span>}
          {analysisInterrupted && <span className="tc2-badge tc2-badge--fail">анализ прерван</span>}
          {vaFailed && <span className="tc2-badge tc2-badge--fail">анализ не удался</span>}
          {vaStatus === 'responded' && <span className="tc2-badge tc2-badge--ok">ответ получен</span>}
          {iter.result && !failed && !vaUnresolved && <span className="tc2-badge tc2-badge--ok">✓</span>}

          <AppIcon name={open ? 'chevronUp' : 'chevronDown'} size="xs" />
        </button>

        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              className="tc2-iter-details"
              initial={heavy ? { opacity: 0 } : { maxHeight: 0, opacity: 0 }}
              animate={heavy ? { opacity: 1 } : { maxHeight: 2000, opacity: 1 }}
              exit={heavy ? { opacity: 0 } : { maxHeight: 0, opacity: 0 }}
              transition={heavy
                ? { duration: 0.12 }
                : { duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
              style={{ overflow: 'hidden' }}
              onAnimationComplete={() => remeasure?.()}
            >


              {iter.result && mode !== 'compact' && (() => {
                if (iter.result.codeMode) {
                  return <CodeModeDetails details={iter.result.codeMode} />
                }
                // ask_user — рендер вопросов и ответов пользователя
                if (iter.call.toolName === 'ask_user' && iter.call.toolArgs?.questions) {
                  const questions = iter.call.toolArgs.questions as Array<{
                    id?: string
                    question: string
                    header?: string
                    type?: string
                    options?: Array<{ label: string; value: string }>
                  }>
                  // Парсим ответы из результата (JSON в конце content)
                  let answers: Array<{
                    id: string
                    values?: string[]
                    text?: string
                    value?: boolean
                  }> = []
                  if (iter.result.success && iter.result.content) {
                    const jsonMatch = iter.result.content.match(/JSON:\s*(\[[\s\S]*\])/)
                    if (jsonMatch) {
                      try { answers = JSON.parse(jsonMatch[1]) } catch { /* skip */ }
                    }
                  }
                  const total = questions.length
                  const resolveType = (q: { type?: string; options?: unknown[] }) =>
                    q.type || (q.options && q.options.length > 0 ? 'choice' : 'text')
                  return (
                    <div className="tc2-section">
                      <div className="tc2-section-title" style={{ color: 'var(--accent, #e8e8ec)' }}>
                        {total > 1 ? `${total} вопроса пользователю` : 'Вопрос пользователю'}
                      </div>
                      <div className="tc2-ask-user">
                        {questions.map((q, qi) => {
                          const ans = answers.find(a => a.id === q.id) || answers[qi]
                          const qType = resolveType(q)
                          return (
                            <div key={qi} className="tc2-ask-q">
                              <div className="tc2-ask-q-num">
                                <AppIcon
                                  name={qType === 'yesno' ? 'check' : 'helpCircle'}
                                  size="xs"
                                />
                              </div>
                              <div className="tc2-ask-q-content">
                                {q.header && <div className="tc2-ask-q-label">{q.header}</div>}
                                <div className="tc2-ask-q-text">{q.question}</div>
                                {q.options && q.options.length > 0 && (
                                  <div className="tc2-ask-q-opts">
                                    {q.options.map(o => {
                                      const isSel = ans?.values?.includes(o.value)
                                      return (
                                        <span
                                          key={o.value}
                                          className={`tc2-ask-q-opt${isSel ? ' tc2-ask-q-opt--selected' : ''}`}
                                        >
                                          {isSel && <span className="tc2-ask-q-opt-check">✓</span>}
                                          {o.label}
                                        </span>
                                      )
                                    })}
                                  </div>
                                )}
                                {/* Ответ пользователя — цветовое выделение, collapse если длинный */}
                                {qType === 'yesno' && ans?.value !== undefined && (
                                  <div className={`tc2-ask-q-answer tc2-ask-q-answer--${ans.value ? 'yes' : 'no'}`}>
                                    <AppIcon name={ans.value ? 'check' : 'x'} size="xs" />
                                    {ans.value ? 'Да' : 'Нет'}
                                  </div>
                                )}
                                {ans?.text && (
                                  <div className={`tc2-ask-q-custom${ans.text.length > 200 ? ' tc2-ask-q-custom--collapsible' : ''}`}>
                                    {ans.text}
                                  </div>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                }
                // image — картинка
                if (iter.result.imageUrl) {
                  return (
                    <div className="tc2-section">
                      <div className="tc2-section-title" style={{ color: '#4ade80' }}>Результат</div>
                      <div className="tc2-image-wrap">
                        <img
                          src={`file://${iter.result.imageUrl}`}
                          alt="Результат"
                          className="tc2-image"
                          loading="lazy"
                          decoding="async"
                          onClick={() => window.open(`file://${iter.result!.imageUrl}`, '_blank')}
                        />
                      </div>
                    </div>
                  )
                }
                // diff — DiffBlock
                if (iter.result.diff) {
                  const isFail = iter.result.success === false
                  return (
                    <div className="tc2-section">
                      <div className="tc2-section-title" style={{ color: isFail ? '#f87171' : '#4ade80' }}>
                        {isFail ? 'Ошибка' : 'Результат'}
                      </div>
                      <DiffBlock diff={iter.result.diff} />
                    </div>
                  )
                }
                // умный рендер через ToolResultRenderer
                return (
                  <ToolResultRenderer
                    call={iter.call}
                    result={iter.result}
                    mode={mode}
                  />
                )
              })()}

              {/* Native analyze_image: визуальный анализ — отдельно от исходного
                  содержимого-хендоффа (его НЕ перезаписываем). */}
              {iter.result && mode !== 'compact' && analyzing && (
                <div className="tc2-section tc2-section--running">
                  <span className="tc2-spinner" />
                  <span className="tc2-running-text">Модель анализирует изображение…</span>
                </div>
              )}

              {iter.result && mode !== 'compact' && analysisInterrupted && (
                <div className="tc2-section">
                  <div className="tc2-section-title" style={{ color: '#fbbf24' }}>Анализ прерван</div>
                  <div className="tc2-running-text">
                    Визуальный анализ не завершён — прогон остановлен или прерван.
                  </div>
                </div>
              )}

              {iter.result && mode !== 'compact' && vaFailed && (
                <div className="tc2-section">
                  <div className="tc2-section-title" style={{ color: '#f87171' }}>Анализ не удался</div>
                  <div className="tc2-running-text">
                    {vaFindings || 'Визуальный анализ не дал результата. Изображение загружено, но ответ модели не получен.'}
                  </div>
                </div>
              )}

              {iter.result && mode !== 'compact' && vaStatus === 'responded' && vaFindings && (
                <div className="tc2-section">
                  <div className="tc2-section-title" style={{ color: '#60a5fa' }}>Ответ модели после получения изображения</div>
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
                    {vaFindings}
                  </div>
                </div>
              )}

              {pending && (
                <div className="tc2-section tc2-section--running">
                  <span className="tc2-spinner" />
                  <span className="tc2-running-text">Готовится вызов…</span>
                </div>
              )}

              {running && (
                <>
                  {/* Live-вывод для run_command пока команда выполняется.
                      Подписывается на pty:data по sessionId из toolProgress. */}
                  {iter.call.toolName === 'run_command' && liveSessionId && (
                    <LiveCommandOutput sessionId={liveSessionId} />
                  )}
                  <div className="tc2-section tc2-section--running">
                    <span className="tc2-spinner" />
                    <span className="tc2-running-text">Выполняется…</span>
                  </div>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}, (prev, next) => prev.iter === next.iter && prev.isLast === next.isLast &&
  prev.isRunning === next.isRunning && prev.mode === next.mode &&
  prev.liveSessionId === next.liveSessionId && prev.animateEntrance === next.animateEntrance &&
  prev.autoOpen === next.autoOpen)

// Сколько итераций показываем при раскрытии цепочки и шаг догрузки.
const ITERS_PAGE = 15
const ITERS_CHUNK = 10

// ── Тайминги раскрытия тела шага ───────────────────────────────────
// AUTO_OPEN_LAST: сколько последних действий держим раскрытыми в живой ленте.
// Более старые сворачиваются автоматически (плавно) — «аккордеон»: видно
// текущий контекст работы, а не простыню из всех шагов. Пользователь всегда
// может раскрыть любой старый шаг кликом — ручной выбор авто-режим не трогает.
const AUTO_OPEN_LAST = 3

// ── Живая шапка с тикающим таймером ─────────────────────────────────
// Вынесена в отдельный memo-компонент: setInterval 1s ре-рендерит только
// шапку, а не всю цепочку (десятки IterationBlock).
const LiveHeader = memo(function LiveHeader({
  currentTool, currentArg, startTime,
}: {
  currentTool: string
  currentArg: string
  startTime: number
}) {
  const [liveElapsed, setLiveElapsed] = useState(0)
  useEffect(() => {
    setLiveElapsed(Date.now() - startTime)
    const id = setInterval(() => setLiveElapsed(Date.now() - startTime), 1000)
    return () => clearInterval(id)
  }, [startTime])

  const elapsedStr = liveElapsed >= 60000
    ? `${Math.floor(liveElapsed / 60000)}м ${Math.round((liveElapsed % 60000) / 1000)}с`
    : liveElapsed >= 1000
      ? `${(liveElapsed / 1000).toFixed(0)}с`
      : `${liveElapsed}мс`

  return (
    <>
      <span className="tc2-spinner" />
      {/* key по имени тула: при смене действия строка плавно проявляется
          (CSS-анимация fade+slide), а не мигает пустотой между шагами. */}
      <span key={currentTool} className="tc2-header-title tc2-live-title">{currentTool}</span>
      {currentArg && <code className="tc2-header-current-arg">{currentArg}</code>}
      <span className="tc2-elapsed tc2-elapsed--live">{elapsedStr}</span>
    </>
  )
})

// ── Группа повторяющихся тулов ──────────────────────────────────────
// Схлопывает N одинаковых итераций в одну раскрывающуюся строку.
const GroupBlock = memo(function GroupBlock({
  group, mode, animateEntrance,
}: {
  group: { type: 'group'; meta: ReturnType<typeof getToolMeta>; iters: Iteration[] }
  mode: ToolOutputMode
  animateEntrance: boolean
}) {
  const [open, setOpen] = useState(false)
  const remeasure = useChatRemeasure()
  const { meta, iters } = group
  const hasFailed = iters.some(i => i.result?.success === false)
  const totalDur = iters.reduce((sum, i) => {
    if (i.result && i.call.timestamp && i.result.timestamp)
      return sum + (i.result.timestamp - i.call.timestamp)
    return sum
  }, 0)

  return (
    <div
      className={`tc2-iter tc2-iter--group${animateEntrance ? ' tc2-iter--enter' : ''}`}
    >
      <div className="tc2-rail">
        <div
          className="tc2-dot tc2-dot--group"
          style={{ '--dot-color': meta.color } as React.CSSProperties}
        >
          <AppIcon name={meta.icon as 'zap'} size="xs" />
        </div>
      </div>
      <div className="tc2-iter-body">
        <button
          className={`tc2-iter-header tc2-group-header ${open ? 'tc2-iter-header--open' : ''} ${hasFailed ? 'tc2-iter-header--fail' : ''}`}
          onClick={() => setOpen(o => !o)}
        >
          <span className="tc2-iter-label">{meta.label}</span>
          <span className="tc2-group-count">×{iters.length}</span>
          <span className="tc2-iter-spacer" />
          {totalDur > 0 && <span className="tc2-iter-duration">{formatDuration(totalDur)}</span>}
          {hasFailed
            ? <span className="tc2-badge tc2-badge--fail">ошибка</span>
            : <span className="tc2-badge tc2-badge--ok">✓</span>
          }
          <AppIcon name={open ? 'chevronUp' : 'chevronDown'} size="xs" />
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              className="tc2-group-iters"
              initial={{ maxHeight: 0, opacity: 0 }}
              animate={{ maxHeight: 5000, opacity: 1 }}
              exit={{ maxHeight: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
              style={{ overflow: 'hidden' }}
              onAnimationComplete={() => remeasure?.()}
            >
              {iters.map((iter, i) => (
                <IterationBlock
                  key={iter.id}
                  iter={iter}
                  isLast={i === iters.length - 1}
                  isRunning={false}
                  mode={mode}
                  animateEntrance={false}
                  autoOpen={false}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
})

// ── Чипы тулов в шапке + portal-tooltip ─────────────────────────────
// CSS ::after tooltip обрезался всеми overflow:hidden родителями
// (.tc2, .chat-body, .chat-scroll и т.д.). Portal в document.body
// полностью обходит все overflow-клипперы.
const ToolChips = memo(function ToolChips({
  chipGroups, isRunning, toolsStr,
}: {
  chipGroups: { meta: ReturnType<typeof getToolMeta>; count: number; toolName?: string }[]
  isRunning: boolean
  toolsStr: string
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)

  const show = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
    if (openTimer.current) clearTimeout(openTimer.current)
    openTimer.current = window.setTimeout(() => {
      if (!wrapRef.current) return
      const r = wrapRef.current.getBoundingClientRect()
      setPos({ top: r.bottom + 6, left: r.right })
      setHovered(true)
    }, 120)
  }, [])

  const hide = useCallback(() => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null }
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setHovered(false), 200)
  }, [])

  useEffect(() => () => {
    if (openTimer.current) clearTimeout(openTimer.current)
    if (closeTimer.current) clearTimeout(closeTimer.current)
  }, [])

  return (
    <>
      <div
        ref={wrapRef}
        className="tc2-header-chips"
        onMouseEnter={show}
        onMouseLeave={hide}
      >
        {chipGroups.map(({ meta, count, toolName }, i) => (
          <span
            key={toolName ?? i}
            className="tc2-mini-chip"
            style={{ background: meta.color + '22', color: meta.color }}
          >
            <AppIcon name={meta.icon as 'zap'} size="xs" />
            {count > 1 && <span className="tc2-mini-chip-count">{count}</span>}
          </span>
        ))}
        {isRunning && <span className="tc2-mini-chip tc2-mini-chip--pulse">···</span>}
      </div>
      {createPortal(
        <AnimatePresence>
          {hovered && pos && (
            <motion.div
              className="tc2-chips-tooltip"
              style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 99999 }}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15 }}
              onMouseEnter={show}
              onMouseLeave={hide}
            >
              {toolsStr}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}, (prev, next) =>
  prev.chipGroups === next.chipGroups &&
  prev.isRunning === next.isRunning &&
  prev.toolsStr === next.toolsStr,
)

const ToolChain = memo(function ToolChain({ steps, sections, mode, isRunning, busy, label, elapsed, summary, toolProgress, thinkingText, thinkingMs, liveThinking, chatId, renderIterExtra }: {
  steps?: ToolStep[]
  /** Полная лента сообщения: итерации с их рассуждениями. Приоритетнее steps. */
  sections?: ToolChainSection[]
  mode: ToolOutputMode
  isRunning: boolean
  /** §steer — chatId сообщения: нужен для крестика отмены pending-реплики. */
  chatId?: string
  /** Прогон ещё идёт, но тулы сейчас не выполняются (агент пишет ответ).
   *  Пока busy — блок не сворачивается сам: пользователь видит ход работы
   *  до самого конца, а не «мигание» на финальном тексте. */
  busy?: boolean
  label?: string
  elapsed?: number   // ms — время выполнения для финального блока
  summary?: boolean  // если true — компактный финальный блок
  toolProgress?: Record<string, { stage: string; detail?: string; sessionId?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }>; ts: number }>
  /** Рассуждение итерации (для одиночной цепочки без sections). */
  thinkingText?: string
  thinkingMs?: number
  /** Текущее стримящееся рассуждение — последней строкой ленты (isLive). */
  liveThinking?: { isLive: boolean; ms?: number; storeChatId?: string }
  /** Дополнительный контент под конкретной итерацией (внутри ленты):
   *  карточка Fast Context, карточка саб-агента и т.п. Раньше такие блоки
   *  рендерились снаружи, рядом с плашкой, и разрывали «ход работы».
   *  iter — именно эта итерация (call+result): решение, рисовать ли блок,
   *  принимается по её шагу, иначе карточка дублировалась бы под каждым
   *  шагом секции. isLastSection — последняя ли секция сообщения
   *  (для live-прогресса долгих тулов). */
  renderIterExtra?: (iter: { call: ToolStep; result?: ToolStep }, isLastSection: boolean) => React.ReactNode
}) {
  // sections — единая лента сообщения (одна шапка на все итерации).
  // steps — legacy/одиночная цепочка (карточка агента, сообщение без iterations).
  const allSections = useMemo<ToolChainSection[]>(
    () => sections ?? [{ thinking: thinkingText, thinkingMs, steps: steps ?? [] }],
    [sections, thinkingText, thinkingMs, steps],
  )
  const sectionIters = useMemo(() => allSections.map(s => buildIterations(s.steps)), [allSections])
  const iters = useMemo(() => sectionIters.flat(), [sectionIters])
  const allSteps = useMemo(() => allSections.flatMap(s => s.steps), [allSections])
  // sessionId для live-вывода run_command (из tool_progress). Передаётся ТОЛЬКО
  // в IterationBlock — не в store, чтобы pty:data-стрим не триггерил ре-рендер.
  const runCmdSessionId = toolProgress?.['run_command']?.sessionId
  const runCmdActive = toolProgress?.['run_command']?.stage === 'start'
  const [collapsed, setCollapsed] = useState(!isRunning)  // история — свёрнут; идёт работа — открыт
  const remeasure = useChatRemeasure()
  const itersRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  // Прилип ли автоскролл к хвосту ленты. true — новые действия подтягиваются
  // вниз; false — пользователь ушёл читать историю, его не трогаем.
  const pinnedRef = useRef(true)
  const [showJumpDown, setShowJumpDown] = useState(false)
  // Окно видимых итераций: длинные цепочки (100+ тулов) при раскрытии раньше
  // монтировали ВСЕ IterationBlock разом (со stagger-анимациями и springs) →
  // фриз. Показываем последние ITERS_PAGE, кнопка «предыдущие» расширяет окно
  // к началу. Live-хвост (последние действия) виден всегда.
  const [itersExtra, setItersExtra] = useState(0)

  // ── Авто-раскрытие на старте работы / авто-сворачивание на финише ──
  // Старт: окно хода работы открывается само — пользователь видит, что агент
  // делает, не кликая по шапке.
  // Финиш: схлопываем ТОЛЬКО когда прогон реально закончился. «Активность» =
  // идут тулы (isRunning) ИЛИ агент ещё стримит ответ (busy): иначе блок
  // сворачивался, пока модель ещё писала финальный текст.
  // remeasure обязателен: список сообщений виртуализирован, без перемера
  // кэш высот ряда остаётся старым → соседние сообщения наезжают/дырка.
  const active = isRunning || !!busy
  const prevRunningRef = useRef(isRunning)
  const prevActiveRef = useRef(active)
  useEffect(() => {
    const wasRunning = prevRunningRef.current
    const wasActive = prevActiveRef.current
    prevRunningRef.current = isRunning
    prevActiveRef.current = active
    if (isRunning && !wasRunning) {
      setCollapsed(false)
      setItersExtra(0)
      remeasure?.()
      return undefined
    }
    if (!active && wasActive) {
      const t = window.setTimeout(() => {
        setCollapsed(true)
        remeasure?.()
      }, 1000)
      return () => window.clearTimeout(t)
    }
    return undefined
  }, [active, isRunning, remeasure])

  // ── Мемоизированные агрегаты — раньше 4× filter/some на каждом рендере ──
  // ToolChain ре-рендерится при каждом токен-флеше (50мс) во время стриминга.
  // 4× filter/some по iters + 1× filter по steps = O(n) на каждый рендер.
  // Теперь один проход в useMemo — ре-вычисление только при смене iters/steps.
  const { totalDone, hasFailed, failedCount, autoElapsed } = useMemo(() => {
    let done = 0, failed = 0, hasFail = false
    for (const it of iters) {
      if (it.result && it.result.visualAnalysis?.status !== 'pending') done++
      if (it.result?.success === false || it.result?.visualAnalysis?.status === 'failed') { failed++; hasFail = true }
    }
    // elapsed из timestamps
    let firstTs = 0, lastTs = 0
    for (const s of allSteps) {
      if (s.timestamp) {
        if (!firstTs) firstTs = s.timestamp
        lastTs = s.timestamp
      }
    }
    const elapsed = (firstTs && lastTs && firstTs !== lastTs) ? lastTs - firstTs : undefined
    return { totalDone: done, hasFailed: hasFail, failedCount: failed, autoElapsed: elapsed }
  }, [iters, allSteps])

  // НЕТ авто-раскрытия цепочки при сбое: в больших чатах failed-цепочки
  // авто-раскрывались при скролле и монтировали все тела с подсветкой →
  // фризы. Заголовок показывает «⚠ M ошибок из N» — раскрытие по клику.

  // elapsed: переданный извне имеет приоритет, иначе — autoElapsed из useMemo
  const elapsedMs = elapsed ?? autoElapsed

  const elapsedStr = elapsedMs != null
    ? elapsedMs >= 60000
      ? `${Math.floor(elapsedMs / 60000)}м ${Math.round((elapsedMs % 60000) / 1000)}с`
      : elapsedMs >= 1000
        ? `${(elapsedMs / 1000).toFixed(1)}с`
        : `${elapsedMs}мс`
    : null

  // ── Все useMemo ДО early return (Rules of Hooks) ──
  // Раньше early return `if (iters.length === 0 && !isRunning) return null`
  // стоял ДО 4 useMemo → нарушение Rules of Hooks → React может бросить
  // исключение при смене iters.length с 0 на >0. Теперь все хуки до return.

  // Агрегация мини-чипов по типу тула — вместо N одинаковых чипов
  // показываем [icon ×count] на каждый тип.
  const chipGroups = useMemo(() => {
    const map = new Map<string, { meta: ReturnType<typeof getToolMeta>; count: number; toolName?: string }>()
    for (const { call } of iters) {
      const key = call.toolName ?? 'unknown'
      const entry = map.get(key) ?? { meta: getToolMeta(call.toolName, call.serverName), count: 0, toolName: call.toolName }
      entry.count++
      map.set(key, entry)
    }
    return [...map.values()]
  }, [iters])

  // Текущее действие для живой шапки — последний iter без результата.
  const currentRunningIter = useMemo(() => {
    if (!isRunning) return null
    for (let i = iters.length - 1; i >= 0; i--) {
      if (!iters[i].result) return iters[i]
    }
    return null
  }, [iters, isRunning])

  // ── «Сейчас делает» в шапке ──────────────────────────────────────────
  // Берём выполняющийся шаг, а если такого нет (тул завершился, следующий ещё
  // не начался / агент пишет ответ) — последний шаг ленты. Раньше в этот
  // момент шапка падала на «Агент работает» / пустоту, и казалось, что показ
  // действия «пропадает с задержкой». Смена названия анимируется
  // (key по имени тула → fade-in), таймер тикает только пока шаг реален.
  const headerIter = currentRunningIter ?? (iters.length > 0 ? iters[iters.length - 1] : null)
  const headerMeta = headerIter ? getToolMeta(headerIter.call.toolName, headerIter.call.serverName) : null
  const headerArg = headerIter?.call.toolArgs
    ? truncate(String(Object.values(headerIter.call.toolArgs)[0] ?? ''), 40)
    : ''

  // Время старта для тикающего таймера (стабильное — timestamp первого шага).
  const runStartTime = allSteps.length > 0 && allSteps[0]?.timestamp ? allSteps[0].timestamp : Date.now()

  // «Живой» режим: идут тулы ИЛИ прогон ещё стримит ответ (агент пишет текст).
  // До конца прогона окно живёт по правилам живого режима — см. prevActiveRef.
  // Объявлен ДО chain/эффектов: от него зависит структура ленты и автоскролл.
  const liveMode = isRunning || !!busy

  // ── Видимое окно ленты ──
  // ITERS_PAGE ограничивает количество монтируемых тул-блоков: длинные
  // цепочки (100+ тулов) при раскрытии монтировали всё разом → фриз.
  // Показываем хвост, кнопка «предыдущие» расширяет окно к началу.
  const visibleCount = Math.min(iters.length, ITERS_PAGE + itersExtra)
  const hiddenCount = iters.length - visibleCount

  // ── Единая лента сообщения: Think → текст → тулы → Think → … ──
  // Структура строится по liveMode (isRunning || busy), а НЕ по isRunning:
  // isRunning на время прогона мигает (между «тул завершился» и «следующий
  // начался» он false). Из-за этого группировка серий то появлялась, то
  // исчезала → ключи записей менялись → ВСЕ шаги ремонтировались и у всех
  // разом перезапускалась entrance-анимация. liveMode стабилен весь прогон.
  const chain = useMemo(
    () => buildChain(sectionIters, allSections, liveMode),
    [sectionIters, allSections, liveMode],
  )  // Обрезаем по окну — сколько тул-итераций уже «спрятано» в начале ленты.
  const visibleChain = useMemo(() => {
    if (hiddenCount <= 0) return chain
    let skip = hiddenCount
    let startIdx = 0
    for (let i = 0; i < chain.length; i++) {
      const e = chain[i]
      if (e.kind === 'single') {
        if (skip === 0) { startIdx = i; break }
        skip--
      } else if (e.kind === 'group') {
        if (e.iters.length >= skip) { startIdx = i; break }
        skip -= e.iters.length
      }
    }
    return startIdx > 0 ? chain.slice(startIdx) : chain
  }, [chain, hiddenCount])

  // Источник отклика — ResizeObserver на внутреннем контейнере ленты
  // (см. эффект ниже): отдельный счётчик длины текста больше не нужен,
  // рост <pre>-вывода и reasoning ловится самим RO.

  // ── Умный автоскролл живого окна ────────────────────────────────────
  // Подписываемся на РЕАЛЬНЫЙ рост содержимого (ResizeObserver), а не на
  // React-рендеры: вывод команды стримится внутри <pre>, reasoning растёт из
  // Zustand, diff/detals раскрываются по анимации — на всё это нужен отклик.
  //   • прилип (pinned) — пользователь у низа (зазор < 24px): тянем хвост;
  //   • отпустил — прокрутил вверх читать: НЕ трогаем скролл, показываем
  //      кнопку «к последним действиям»;
  //   • сам вернулся в низ → снова прилипает, кнопка гаснет.
  // Пороги: 24px на определение «у низа» — чтобы «у низа» ловилось и после
  // дробного scrollTop с HiDPI.
  useEffect(() => {
    const el = itersRef.current
    const inner = innerRef.current
    if (!el || !inner) return
    const BOTTOM_GAP = 24
    const atBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_GAP
    const stick = () => { el.scrollTop = el.scrollHeight }

    const onScroll = () => {
      const bottom = atBottom()
      if (bottom && !pinnedRef.current) pinnedRef.current = true
      if (liveMode && pinnedRef.current && !bottom) pinnedRef.current = false
      // Кнопку показываем только в живом окне: в истории пользователь сам
      // управляет скроллом, лишний оверлей там мешает.
      setShowJumpDown(v => {
        const next = liveMode && !bottom
        return v === next ? v : next
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })

    let raf = 0
    const ro = new ResizeObserver(() => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (liveMode && pinnedRef.current && !collapsed) stick()
      })
    })
    ro.observe(inner)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [collapsed, liveMode])

  // Отпустил прокрутку ↑ и появились новые действия → кнопка возврата.
  const jumpToBottom = useCallback(() => {
    const el = itersRef.current
    if (!el) return
    pinnedRef.current = true
    setShowJumpDown(false)
    el.scrollTop = el.scrollHeight
  }, [])

  // Открыл окно заново (или начался прогон) — сразу прилипаем к хвосту.
  // Показ кнопки править не нужно: stick() ниже порождает scroll-событие,
  // onScroll сам сбросит flag — без setState внутри эффекта.
  useEffect(() => {
    if (collapsed) return
    pinnedRef.current = true
    const el = itersRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [collapsed, isRunning])

  // Map id→index больше не нужен (defaultOpen убран) — isLast считается
  // по позиции в видимой ленте.

  // Лента нужна и без тулов: чистый reasoning/текст перед первым вызовом.
  const hasThinking = !!thinkingText || !!allSections.some(s => s.thinking) ||
    (!!liveThinking && (liveThinking.isLive || liveThinking.ms !== undefined))
  // §steer — карточка внедрённой реплики тоже повод показать окно: прогон без
  // единого тула (модель отвечала текстом) иначе схлопнулся бы в null и
  // сообщение пользователя «исчезло» бы из ленты.
  const hasSteers = allSections.some(s => s.steps.some(st => st.type === 'steer'))

  if (iters.length === 0 && !isRunning && !hasThinking && !hasSteers) return null

  if (mode === 'compact') {
    return (
      <div className="tc2 tc2--compact">
        <div className="tc2-compact-row">
          {isRunning && <span className="tc2-spinner" />}
          {iters.map(({ id, call }, i) => {
            const meta = getToolMeta(call.toolName, call.serverName)
            return (
              <span key={id} className="tc2-compact-chip" style={{ '--chip-color': meta.color } as React.CSSProperties}>
                <AppIcon name={meta.icon as 'zap'} size="xs" />
                {i < iters.length - 1 && <span className="tc2-compact-arrow">›</span>}
              </span>
            )
          })}
          {isRunning && <span className="tc2-compact-dots">···</span>}
        </div>
    </div>
  )
  }

  // liveMode объявлен выше (до эффекта автоскролла) — здесь только строка
  // инструментов и разметка.
  const toolsStr = chipGroups.map(g => `${g.meta.label}${g.count > 1 ? ` ×${g.count}` : ''}`).join(' · ')

  return (
    <div className={`tc2${summary ? ' tc2--summary' : ''}${liveMode ? ' tc2--running' : ''}`}>
      {/* Conic-рамка: статичная маска на обёртке, градиент вращается через
          individual-свойство rotate (композитится на GPU) вместо анимации
          CSS-переменной внутри conic-gradient (repaint каждый кадр). */}
      <span className="tc2-border-arc" aria-hidden="true" />
      <div className="tc2-header" onClick={() => setCollapsed(c => !c)}>
        {/* Дымка-блик шапки: градиент бежит через transform, а не через
            background-position — иначе repaint шапки каждый кадр. */}
        <span className="tc2-header-glow" aria-hidden="true" />
        <span className="tc2-collapse-btn">
          <AppIcon name={collapsed ? 'chevronRight' : 'chevronDown'} size="xs" />
        </span>

        <div className="tc2-header-summary">
          {label
            ? <span className="tc2-header-title tc2-header-title--label">{label}</span>
            : liveMode
              ? headerMeta
                ? currentRunningIter
                  // Шаг реально выполняется — тикающий таймер.
                  ? <LiveHeader currentTool={headerMeta.label} currentArg={headerArg} startTime={runStartTime} />
                  // Шаг завершён, следующий ещё не пришёл / агент пишет ответ:
                  // название последнего действия остаётся, спиннер показывает,
                  // что работа продолжается (без врущего таймера).
                  : <>
                      <span className="tc2-spinner" />
                      <span key={headerMeta.label} className="tc2-header-title tc2-live-title">{headerMeta.label}</span>
                      {headerArg && <code className="tc2-header-current-arg">{headerArg}</code>}
                    </>
                : <><span className="tc2-spinner" /><span className="tc2-header-title">Агент работает</span></>
              : (() => {
                  // «Выполнено за 22с · 3 действия» — одной фразой вместо
                  // бейджа-счётчика + отдельного бейджа с часами: строка короче
                  // и читается как итог работы, а не как набор индикаторов.
                  const plural = totalDone === 1 ? 'действие' : totalDone < 5 ? 'действия' : 'действий'
                  return (
                    <span className="tc2-header-title tc2-header-title--done">
                      {elapsedMs != null ? `Выполнено за ${formatDoneDuration(elapsedMs)}` : 'Выполнено'}
                      <span className="tc2-header-dot"> · </span>
                      <span className={hasFailed ? 'tc2-header-count tc2-header-count--fail' : 'tc2-header-count'}>
                        {totalDone} {plural}
                      </span>
                      {hasFailed && (
                        <span className="tc2-status-badge tc2-status-badge--fail tc2-header-fail-badge">
                          {failedCount}
                        </span>
                      )}
                    </span>
                  )
                })()
          }
          {/* Часы-бейдж нужны только для блоков с внешним label (там нет
              фразы «Выполнено за …» в заголовке). */}
          {label && elapsedStr && !liveMode && (
            <span className="tc2-elapsed-badge">
              <AppIcon name="clock" size="xs" />
              {elapsedStr}
            </span>
          )}
        </div>

        <ToolChips chipGroups={chipGroups} isRunning={liveMode} toolsStr={toolsStr} />
      </div>



      <div className={`tc2-iters-wrap${collapsed ? '' : ' tc2-iters-wrap--open'}`}>
        <div className="tc2-iters" ref={itersRef}>
          {/* Внутренний контейнер — цель ResizeObserver для умного автоскролла:
              расти может что угодно внутри (вывод команды, reasoning, diff),
              отклик нужен на РЕАЛЬНЫЙ рост содержимого, а не на re-render. */}
          <div className="tc2-iters-inner" ref={innerRef}>
            {hiddenCount > 0 && (
              <button className="tc2-show-more" onClick={() => setItersExtra(e => e + ITERS_CHUNK)}>
                Показать ещё {Math.min(ITERS_CHUNK, hiddenCount)} из {hiddenCount} предыдущих действий
              </button>
            )}
            {visibleChain.map((entry, vIdx) => {
              // Рассуждение — строкой ленты (Think внутри окна хода работы).
              if (entry.kind === 'thinking') {
                return (
                  <div key={entry.key} className="tc2-thinking-embed">
                    <ThinkingBlock text={entry.text} thinkingMs={entry.ms} />
                  </div>
                )
              }
              // Обычный текст модели перед тулами — тоже внутри ленты, чтобы
              // при сворачивании хода работы он уходил вместе с ним, а не
              // оставался висеть в сообщении.
              if (entry.kind === 'text') {
                return (
                  <div key={entry.key} className="tc2-note">
                    <div className="tc2-note-text">{entry.text}</div>
                  </div>
                )
              }
              if (entry.kind === 'steer') {
                // §steer — реплика пользователя, внедрённая по ходу рана.
                return <SteerCard key={entry.key} step={entry.step} chatId={chatId} />
              }
              if (entry.kind === 'group') {
                return (
                  <GroupBlock
                    // Стабильный ключ по id первой итерации группы: индексный
                    // ключ ремонтировал GroupBlock при сдвиге окна видимых
                    // итераций → раскрытая группа схлопывалась.
                    key={entry.key}
                    group={{ type: 'group', meta: entry.meta, iters: entry.iters }}
                    mode={mode}
                    animateEntrance={false}
                  />
                )
              }
              const iter = entry.iter
              const isLastVisible = vIdx === visibleChain.length - 1
              // «Окно» последних AUTO_OPEN_LAST действий: они раскрыты, более
              // старые сворачиваются. Считаем от конца ленты, чтобы новый шаг
              // вытеснял самый старый.
              const fromEnd = visibleChain.length - 1 - vIdx
              // Дополнительный контент под шагом (Fast Context / карточка
              // саб-агента) — ВНУТРИ ленты, сразу под своей итерацией.
              // Передаём САМУ итерацию: иначе карточка рисовалась бы под
              // каждым шагом секции (шаги секции одинаковы для всех её итераций).
              const extra = renderIterExtra
                ? renderIterExtra(iter, entry.si === allSections.length - 1)
                : null
              return (
                <Fragment key={iter.id}>
                  <IterationBlock
                    iter={iter}
                    isLast={isLastVisible}
                    isRunning={!!isRunning}
                    mode={mode}
                    liveSessionId={runCmdActive && iter.call.toolName === 'run_command' && !iter.result ? runCmdSessionId : undefined}
                    // Анимация появления — ТОЛЬКО у последнего (только что
                    // добавленного) шага. Раньше флаг стоял у всех: при любом
                    // ре-рендере/смене флага класс пересоздавался и анимация
                    // перезапускалась у всей ленты разом.
                    animateEntrance={liveMode && isLastVisible}
                    autoOpen={liveMode && fromEnd < AUTO_OPEN_LAST}
                  />
                  {extra && <div className="tc2-iter-extra">{extra}</div>}
                </Fragment>
              )
            })}

            {/* Пульс — ждём следующего тула. При наличии live-thinking не нужен:
                строку «Думаю…» заменяет сам блок рассуждения ниже. */}
            {isRunning && iters.length > 0 && iters[iters.length - 1].result && !liveThinking && (
              <div className="tc2-iter">
                <div className="tc2-rail">
                  <div className="tc2-dot tc2-dot--thinking" />
                </div>
                <div className="tc2-iter-body">
                  <div className="tc2-thinking-row">
                    <span className="tc2-spinner" />
                    <span className="tc2-thinking-label">Думаю…</span>
                  </div>
                </div>
              </div>
            )}

            {/* Старт — нет тулов ещё */}
            {isRunning && iters.length === 0 && !liveThinking && (
              <div className="tc2-iter">
                <div className="tc2-rail">
                  <div className="tc2-dot tc2-dot--thinking" />
                </div>
                <div className="tc2-iter-body">
                  <div className="tc2-thinking-row">
                    <span className="tc2-spinner" />
                    <span className="tc2-thinking-label">Анализирую задачу…</span>
                  </div>
                </div>
              </div>
            )}

            {/* Текущее стримящееся рассуждение — последней строкой ленты, чтобы
                «ход работы» читался одной лентой (Think → тулы → Think).
                ThinkingBlock сам подписан на store по storeChatId — токены
                ре-рендерят только его, не всю цепочку. */}
            {liveThinking && (liveThinking.isLive || liveThinking.ms !== undefined) && (
              <div className="tc2-thinking-embed tc2-thinking-embed--live">
                <ThinkingBlock
                  thinkingMs={liveThinking.ms}
                  isLive={liveThinking.isLive}
                  storeChatId={liveThinking.storeChatId}
                />
              </div>
            )}
          </div>
        </div>
        {/* Пользователь прокрутил вверх читать — автоскролл отпущен.
            Кнопка возвращает к хвосту и снова прилипает. */}
        {showJumpDown && !collapsed && liveMode && (
          <button className="tc2-jump-down" onClick={jumpToBottom} title="К последним действиям">
            <AppIcon name="chevronDown" size="xs" />
            <span>к последним</span>
          </button>
        )}
      </div>
    </div>
  )
}, (prev, next) => prev.steps === next.steps && prev.sections === next.sections && prev.mode === next.mode &&
  prev.isRunning === next.isRunning && prev.busy === next.busy && prev.label === next.label &&
  prev.elapsed === next.elapsed && prev.summary === next.summary &&
  prev.toolProgress === next.toolProgress &&
  prev.thinkingText === next.thinkingText && prev.thinkingMs === next.thinkingMs &&
  prev.liveThinking === next.liveThinking && prev.chatId === next.chatId &&
  prev.renderIterExtra === next.renderIterExtra)

export default ToolChain
