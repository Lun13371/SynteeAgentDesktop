/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports -- Read and transpile project source. */
// §orchestration — unit-тесты фазового рантайма (src/core/agent/orchestration.ts).
//
// Файл на TypeScript, поэтому транспилируем его через typescript API прямо
// в тесте: логика фазового автомата — чистые функции/класс без импортов
// времени выполнения (импорт shared-контракта — только типы), так что модуль
// грузится в обычный CommonJS без сборки.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function loadTsModule(relPath) {
  const file = path.join(__dirname, '..', relPath)
  const source = fs.readFileSync(file, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: file,
  })
  const mod = { exports: {} }
  new Function('exports', 'require', 'module', '__filename', '__dirname', outputText)(
    mod.exports, require, mod, file, path.dirname(file),
  )
  return mod.exports
}

const orch = loadTsModule('src/core/agent/orchestration.ts')

const model = (providerId, modelId, reasoningValue) => ({
  providerId, modelId, ...(reasoningValue ? { reasoningValue } : {}),
})

const makeRun = (withReviewer = true) => ({
  planner: model('openai', 'gpt-5-plan', 'high'),
  executor: model('anthropic', 'claude-sonnet-4.5'),
  ...(withReviewer ? { reviewer: model('openai', 'gpt-5-review') } : {}),
})

const schema = (name) => ({ type: 'function', function: { name } })

// ── Фазовый allowlist ────────────────────────────────────────────────────

test('read-only фазы пускают только allowlist, executing — всё', () => {
  for (const phase of ['planning', 'reviewing', 'replanning']) {
    assert.equal(orch.isToolAllowedInPhase(phase, 'read_file'), true, `${phase}: read_file`)
    assert.equal(orch.isToolAllowedInPhase(phase, 'search_code'), true, `${phase}: search_code`)
    assert.equal(orch.isToolAllowedInPhase(phase, 'ask_user'), true, `${phase}: ask_user`)
    assert.equal(orch.isToolAllowedInPhase(phase, 'write_file'), false, `${phase}: write_file`)
    assert.equal(orch.isToolAllowedInPhase(phase, 'edit_file'), false, `${phase}: edit_file`)
    assert.equal(orch.isToolAllowedInPhase(phase, 'run_command'), false, `${phase}: run_command`)
    assert.equal(orch.isToolAllowedInPhase(phase, 'spawn_agent'), false, `${phase}: spawn_agent`)
    // Code Mode — не лазейка вокруг allowlist'а.
    assert.equal(orch.isToolAllowedInPhase(phase, 'execute_code'), false, `${phase}: execute_code`)
    // Побочные эффекты MCP/plugin-тулов статически неизвестны.
    assert.equal(orch.isToolAllowedInPhase(phase, 'mcp__gh__create_issue'), false, `${phase}: mcp`)
    assert.equal(orch.isToolAllowedInPhase(phase, 'plugin__x__do'), false, `${phase}: plugin`)
  }
  assert.equal(orch.isToolAllowedInPhase('executing', 'write_file'), true)
  assert.equal(orch.isToolAllowedInPhase('executing', 'run_command'), true)
  assert.equal(orch.isToolAllowedInPhase('executing', 'execute_code'), true)
})

test('filterSchemasForPhase режет набор и не копирует его в executing', () => {
  const schemas = ['read_file', 'write_file', 'run_command', 'execute_code', 'list_directory'].map(schema)
  const planning = orch.filterSchemasForPhase(schemas, 'planning').map(s => s.function.name)
  assert.deepEqual(planning, ['read_file', 'list_directory'])
  const reviewing = orch.filterSchemasForPhase(schemas, 'reviewing').map(s => s.function.name)
  assert.deepEqual(reviewing, ['read_file', 'list_directory'])
  // executing получает ИСХОДНЫЙ массив (identity): request_access дописывает
  // тулы в него посреди рана, копия потеряла бы это.
  assert.equal(orch.filterSchemasForPhase(schemas, 'executing'), schemas)
})

test('phaseModel: planner/executor/reviewer; reviewing без ревьюера — null (без fallback)', () => {
  const run = makeRun(true)
  assert.equal(orch.phaseModel(run, 'planning'), run.planner)
  assert.equal(orch.phaseModel(run, 'replanning'), run.planner)
  assert.equal(orch.phaseModel(run, 'executing'), run.executor)
  assert.equal(orch.phaseModel(run, 'reviewing'), run.reviewer)
  assert.equal(orch.phaseModel(makeRun(false), 'reviewing'), null)
})

// ── Прогресс ─────────────────────────────────────────────────────────────

test('makeProgress: одно событие на переход, startedAt/updatedAt/status', () => {
  const m = model('openai', 'gpt-5')
  const event = orch.makeProgress('planning', m, 'running', { at: 1000 })
  assert.deepEqual(event, { phase: 'planning', model: m, startedAt: 1000, updatedAt: 1000, status: 'running' })
  const withDetail = orch.makeProgress('executing', m, 'done', { startedAt: 500, at: 900, detail: 'ok' })
  assert.equal(withDetail.startedAt, 500)
  assert.equal(withDetail.updatedAt, 900)
  assert.equal(withDetail.detail, 'ok')
  // Пустой detail не попадает в событие (UI не показывает пустую строку).
  assert.equal('detail' in orch.makeProgress('planning', m, 'running', { at: 1 }), false)
})

test('runtime: start даёт ровно одно running-событие фазы planning', () => {
  const runtime = new orch.OrchestrationRuntime(makeRun(), 100)
  const events = runtime.start('researching')
  assert.equal(events.length, 1)
  assert.equal(events[0].phase, 'planning')
  assert.equal(events[0].status, 'running')
  assert.equal(events[0].startedAt, 100)
  assert.equal(events[0].model.modelId, 'gpt-5-plan')
})

// ── Фазовый автомат: happy path ──────────────────────────────────────────

test('planning → executing → reviewing → done отдаёт ответ исполнителя', () => {
  const runtime = new orch.OrchestrationRuntime(makeRun(), 100)

  const plan = orch.advanceAfterPhaseAnswer(runtime, 'Plan: 1. read 2. edit', { at: 200 })
  assert.equal(plan.outcome, 'continue')
  assert.equal(runtime.phase, 'executing')
  // Переход = закрытие прошлой фазы + открытие новой.
  assert.deepEqual(plan.events.map(e => [e.phase, e.status]), [['planning', 'done'], ['executing', 'running']])
  assert.match(plan.instruction, /EXECUTING PHASE/)
  assert.match(plan.instruction, /anthropic/)


  const executed = orch.advanceAfterPhaseAnswer(runtime, 'Done: file written', { at: 300 })
  assert.equal(executed.outcome, 'continue')
  assert.equal(runtime.phase, 'reviewing')
  assert.equal(runtime.reviewRoundCount, 1)
  assert.match(executed.instruction, /REVIEWING PHASE/)
  assert.match(executed.instruction, /verdict="approve"/)

  const reviewed = orch.advanceAfterPhaseAnswer(runtime, '<review verdict="approve">LGTM</review>', { at: 400 })
  assert.equal(reviewed.outcome, 'done')
  // Пользователю уходит РАБОТА исполнителя, а не текст вердикта.
  assert.equal(reviewed.answer, 'Done: file written')
  assert.deepEqual(reviewed.events.map(e => [e.phase, e.status]), [['reviewing', 'done']])
})

test('без ревьюера ран закрывается ответом исполнителя (никакой подмены модели)', () => {
  const runtime = new orch.OrchestrationRuntime(makeRun(false), 100)
  orch.advanceAfterPhaseAnswer(runtime, 'plan', { at: 110 })
  const executed = orch.advanceAfterPhaseAnswer(runtime, 'final work', { at: 120 })
  assert.equal(executed.outcome, 'done')
  assert.equal(executed.answer, 'final work')
  assert.equal(runtime.phase, 'executing')
  assert.deepEqual(executed.events.map(e => [e.phase, e.status]), [['executing', 'done']])
})

// ── Вердикты ревью ───────────────────────────────────────────────────────

test('parseReviewVerdict: нет одобрения без завершённого тега', () => {
  assert.deepEqual(orch.parseReviewVerdict('looks good'), { verdict: 'unknown', feedback: 'looks good' })
  assert.equal(orch.parseReviewVerdict('<review verdict="revise">fix tests</review>').verdict, 'revise')
  assert.equal(orch.parseReviewVerdict("<review verdict='replan'>wrong approach</review>").verdict, 'replan')
  assert.equal(orch.parseReviewVerdict('<review verdict="approve">ok').verdict, 'unknown')
  assert.equal(orch.parseReviewVerdict('<review verdict="approve">ok</review>').verdict, 'approve')
  const parsed = orch.parseReviewVerdict('<review verdict="revise">fix the parser</review>')
  assert.equal(parsed.feedback, 'fix the parser')
})

test('revise возвращает в executing с фидбеком и не теряет ответ исполнителя', () => {
  const runtime = new orch.OrchestrationRuntime(makeRun(), 100)
  orch.advanceAfterPhaseAnswer(runtime, 'plan', { at: 110 })
  orch.advanceAfterPhaseAnswer(runtime, 'work v1', { at: 120 })
  const revised = orch.advanceAfterPhaseAnswer(runtime, '<review verdict="revise">tests are missing</review>', { at: 130 })
  assert.equal(revised.outcome, 'continue')
  assert.equal(runtime.phase, 'executing')
  assert.match(revised.instruction, /REVIEW FEEDBACK/)
  assert.match(revised.instruction, /tests are missing/)
  assert.equal(runtime.finalExecutorAnswer, 'work v1')
})

test('replan ограничен MAX_ORCHESTRATION_REPLANS, дальше — финал ответом исполнителя', () => {
  const runtime = new orch.OrchestrationRuntime(makeRun(), 100)
  orch.advanceAfterPhaseAnswer(runtime, 'plan', { at: 110 })
  orch.advanceAfterPhaseAnswer(runtime, 'work v1', { at: 120 })

  let step = orch.advanceAfterPhaseAnswer(runtime, '<review verdict="replan">wrong plan</review>', { at: 130 })
  assert.equal(step.outcome, 'continue')
  assert.equal(runtime.phase, 'replanning')
  assert.equal(runtime.replanCount, 1)
  assert.match(step.instruction, /REPLANNING PHASE/)

  // Планировщик вернул новый план → снова исполнение.
  orch.advanceAfterPhaseAnswer(runtime, 'plan v2', { at: 140 })
  assert.equal(runtime.phase, 'executing')
  orch.advanceAfterPhaseAnswer(runtime, 'work v2', { at: 150 })

  step = orch.advanceAfterPhaseAnswer(runtime, '<review verdict="replan">still wrong</review>', { at: 160 })
  assert.equal(runtime.phase, 'replanning')
  assert.equal(runtime.replanCount, orch.MAX_ORCHESTRATION_REPLANS)

  orch.advanceAfterPhaseAnswer(runtime, 'plan v3', { at: 170 })
  orch.advanceAfterPhaseAnswer(runtime, 'work v3', { at: 180 })
  step = orch.advanceAfterPhaseAnswer(runtime, '<review verdict="replan">nope</review>', { at: 190 })
  assert.equal(step.outcome, 'done')
  assert.equal(step.answer, 'work v3')
  assert.equal(runtime.replanCount, orch.MAX_ORCHESTRATION_REPLANS)
})

test('круги ревью ограничены: после лимита executing закрывается без нового ревью', () => {
  const runtime = new orch.OrchestrationRuntime(makeRun(), 100)
  orch.advanceAfterPhaseAnswer(runtime, 'plan', { at: 110 })
  for (let i = 0; i < orch.MAX_ORCHESTRATION_REVIEW_ROUNDS; i++) {
    orch.advanceAfterPhaseAnswer(runtime, `work ${i}`, { at: 200 + i * 10 })
    const verdict = orch.advanceAfterPhaseAnswer(runtime, '<review verdict="revise">again</review>', { at: 205 + i * 10 })
    assert.equal(verdict.outcome, 'continue')
  }
  assert.equal(runtime.reviewRoundCount, orch.MAX_ORCHESTRATION_REVIEW_ROUNDS)
  const last = orch.advanceAfterPhaseAnswer(runtime, 'final work', { at: 900 })
  assert.equal(last.outcome, 'done')
  assert.equal(last.answer, 'final work')
})

// ── Steer / abort / бюджет / атрибуция ───────────────────────────────────

test('steer поднимает ревизию: вердикт по старой ревизии считается устаревшим', () => {
  const runtime = new orch.OrchestrationRuntime(makeRun(), 100)
  assert.equal(runtime.reviewIsStale, false) // ещё ничего не ревьюили
  runtime.markReviewed()
  assert.equal(runtime.reviewIsStale, false)
  assert.equal(runtime.bumpRevision(), 1)
  assert.equal(runtime.reviewIsStale, true)
  runtime.markReviewed()
  assert.equal(runtime.reviewIsStale, false)
  assert.equal(runtime.bumpRevision(), 2)
})

test('block закрывает текущую фазу как blocked и идемпотентен', () => {
  const runtime = new orch.OrchestrationRuntime(makeRun(), 100)
  const event = runtime.block('aborted by the user', 150)
  assert.ok(event)
  assert.equal(event.phase, 'planning')
  assert.equal(event.status, 'blocked')
  assert.equal(event.startedAt, 100)
  assert.equal(event.updatedAt, 150)
  assert.equal(runtime.block('again', 200), null)
  assert.equal(runtime.blocked, true)
})

test('атрибуция и бюджет считаются по каждой модели-роли отдельно', () => {
  const runtime = new orch.OrchestrationRuntime(makeRun(), 100)
  runtime.recordUsage(runtime.run.planner, 100, 20)
  runtime.recordUsage(runtime.run.planner, 50, 5)
  runtime.recordUsage(runtime.run.executor, 10, 1)
  const attribution = runtime.attribution()
  assert.equal(attribution.length, 2)
  const planner = attribution.find(u => u.modelId === 'gpt-5-plan')
  assert.deepEqual(planner, { providerId: 'openai', modelId: 'gpt-5-plan', promptTokens: 150, completionTokens: 25, calls: 2 })
  const executor = attribution.find(u => u.modelId === 'claude-sonnet-4.5')
  assert.equal(executor.calls, 1)

  // Жёсткого бюджета токенов больше нет: расход только атрибутируется.
  assert.equal(typeof runtime.budgetExceeded, 'undefined')

  const summary = runtime.summary()
  assert.equal(summary.perModel.length, 2)
  assert.equal(summary.replans, 0)
  assert.ok(Array.isArray(summary.phases))
})

// ── Кросс-провайдерная история ───────────────────────────────────────────

test('portableizeMessages снимает подписанные артефакты провайдера, сохраняя tool-структуру', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: 'x', tool_calls: [{ id: 'call_1' }], thinking_blocks: [{ thinking: 't', signature: 's' }] },
    { role: 'tool', content: 'ok', tool_call_id: 'call_1' },
    { role: 'assistant', content: 'y', reasoning_content: 'glm-reasoning' },
  ]
  const cleaned = orch.portableizeMessages(messages)
  assert.equal(cleaned, 2)
  assert.equal('thinking_blocks' in messages[1], false)
  assert.equal('reasoning_content' in messages[3], false)
  // Структура раунда не тронута — иначе провайдер отвергнет историю.
  assert.deepEqual(messages[1].tool_calls, [{ id: 'call_1' }])
  assert.equal(messages[2].tool_call_id, 'call_1')
  // Повторный вызов — уже портативно.
  assert.equal(orch.portableizeMessages(messages), 0)
})

test('sameModel сравнивает provider+model (смена только effort — та же история)', () => {
  assert.equal(orch.sameModel(model('openai', 'gpt-5', 'high'), model('openai', 'gpt-5', 'low')), true)
  assert.equal(orch.sameModel(model('openai', 'gpt-5'), model('anthropic', 'claude')), false)
  assert.equal(orch.sameModel(null, null), true)
  assert.equal(orch.sameModel(null, model('openai', 'gpt-5')), false)
})

test('phaseInstruction адресует фазу и её модель (effort в тексте не теряется)', () => {
  const m = model('openai', 'gpt-5-plan', 'high')
  assert.match(orch.phaseInstruction('planning', m), /PLANNING PHASE/)
  assert.match(orch.phaseInstruction('planning', m), /gpt-5-plan/)
  assert.match(orch.phaseInstruction('planning', m), /read-only/)
  assert.match(orch.phaseInstruction('replanning', m, { feedback: 'wrong files' }), /wrong files/)
  assert.match(orch.phaseInstruction('executing', m), /full toolset/)
  assert.match(orch.phaseInstruction('reviewing', m), /verdict="revise"/)
})

// ── Планировщик отвечает сам на read-only вопросы ────────────────────────

test('planning с <answer/> отдаёт ответ планировщика и НЕ запускает исполнителя', () => {
  const runtime = new orch.OrchestrationRuntime(makeRun(), 100)
  const step = orch.advanceAfterPhaseAnswer(
    runtime,
    'Файл лежит в src/core/agent/Agent.ts: функция run() — единственный цикл.\n<answer/>',
    { at: 200 },
  )
  assert.equal(step.outcome, 'done')
  // Пользователю уходит РЕАЛЬНЫЙ ответ планировщика, без служебного тега.
  assert.equal(step.answer, 'Файл лежит в src/core/agent/Agent.ts: функция run() — единственный цикл.')
  assert.equal(runtime.phase, 'planning')
  assert.equal(runtime.finalExecutorAnswer, step.answer)
  assert.deepEqual(step.events.map(e => [e.phase, e.status]), [['planning', 'done']])
})

test('planning без маркера остаётся планом: executing (безопасный дефолт)', () => {
  const runtime = new orch.OrchestrationRuntime(makeRun(), 100)
  const step = orch.advanceAfterPhaseAnswer(runtime, '1. прочитать 2. поправить', { at: 200 })
  assert.equal(step.outcome, 'continue')
  assert.equal(runtime.phase, 'executing')
})

test('parsePlannerOutcome: <answer/> и verdict="answer" — прямой ответ, теги снимаются', () => {
  assert.equal(orch.parsePlannerOutcome('text <answer/>').direct, true)
  assert.equal(orch.parsePlannerOutcome('text <orchestration verdict="answer">x</orchestration>').direct, true)
  assert.equal(orch.parsePlannerOutcome('plan only').direct, false)
  assert.equal(orch.parsePlannerOutcome('<plan>1. read</plan>').text, '1. read')
})

// ── Явный блокер исполнителя → ограниченный replan ───────────────────────

test('executor blocker уходит в replanning и не считается выполненной работой', () => {
  const runtime = new orch.OrchestrationRuntime(makeRun(), 100)
  orch.advanceAfterPhaseAnswer(runtime, 'plan', { at: 110 })
  const step = orch.advanceAfterPhaseAnswer(
    runtime,
    'Не могу: нет доступа к продовой БД.\n<blocker>нет доступа к продовой БД</blocker>',
    { at: 120 },
  )
  assert.equal(step.outcome, 'continue')
  assert.equal(runtime.phase, 'replanning')
  assert.equal(runtime.replanCount, 1)
  assert.match(step.instruction, /REPLANNING PHASE/)
  assert.match(step.instruction, /blocked/)
  assert.match(step.instruction, /продовой БД/)
  // Текст блокера не содержит служебного тега.
  assert.equal(runtime.finalExecutorAnswer, 'Не могу: нет доступа к продовой БД.')
  // Переход закрывает executing и открывает replanning.
  assert.deepEqual(step.events.map(e => [e.phase, e.status]), [['executing', 'done'], ['replanning', 'running']])
})

test('blocker после исчерпания репланов: честный финал, НЕ «одобрено»', () => {
  const runtime = new orch.OrchestrationRuntime(makeRun(), 100)
  for (let i = 0; i < orch.MAX_ORCHESTRATION_REPLANS; i++) {
    orch.advanceAfterPhaseAnswer(runtime, `plan ${i}`, { at: 100 + i })
    const blocked = orch.advanceAfterPhaseAnswer(runtime, `<blocker>step ${i} blocked</blocker>`, { at: 101 + i })
    assert.equal(blocked.outcome, 'continue')
  }
  assert.equal(runtime.replanCount, orch.MAX_ORCHESTRATION_REPLANS)
  orch.advanceAfterPhaseAnswer(runtime, 'plan last', { at: 200 })
  const final = orch.advanceAfterPhaseAnswer(runtime, '<blocker>still blocked</blocker>', { at: 201 })
  assert.equal(final.outcome, 'done')
  assert.equal(final.answer, 'still blocked')
  const last = final.events[final.events.length - 1]
  assert.equal(last.status, 'done')
  assert.match(last.detail, /blocked/)
  assert.match(last.detail, /not approved/)
})

test('parseExecutorBlocker: парный тег, самозакрывающийся и verdict="blocked"', () => {
  assert.deepEqual(orch.parseExecutorBlocker('<blocker>нет сети</blocker>'), { blocked: true, reason: 'нет сети' })
  assert.equal(orch.parseExecutorBlocker('<blocker/>').blocked, true)
  assert.equal(orch.parseExecutorBlocker('<orchestration verdict="blocked">нет прав</orchestration>').reason, 'нет прав')
  assert.equal(orch.parseExecutorBlocker('готово, тесты прошли').blocked, false)
})

// ── Никакого ложного approve ─────────────────────────────────────────────

test('битый тег вердикта = unknown, а не approve; переспрос ограничен', () => {
  assert.equal(orch.parseReviewVerdict('<review verdict="aprove">ok</review>').verdict, 'unknown')
  assert.equal(orch.parseReviewVerdict('<review>ok</review>').verdict, 'unknown')
  assert.equal(orch.parseReviewVerdict('без тега вообще').verdict, 'unknown')

  const runtime = new orch.OrchestrationRuntime(makeRun(), 100)
  orch.advanceAfterPhaseAnswer(runtime, 'plan', { at: 110 })
  orch.advanceAfterPhaseAnswer(runtime, 'work', { at: 120 })
  for (let i = 0; i < orch.MAX_ORCHESTRATION_VERDICT_RETRIES; i++) {
    const reask = orch.advanceAfterPhaseAnswer(runtime, '<review verdict="aprove">ok</review>', { at: 130 + i })
    assert.equal(reask.outcome, 'continue')
    assert.match(reask.instruction, /VERDICT UNREADABLE/)
    assert.equal(runtime.phase, 'reviewing')
  }
  assert.equal(runtime.verdictRetryCount, orch.MAX_ORCHESTRATION_VERDICT_RETRIES)
  const final = orch.advanceAfterPhaseAnswer(runtime, '<review verdict="aprove">ok</review>', { at: 200 })
  assert.equal(final.outcome, 'done')
  assert.equal(final.answer, 'work')
  const last = final.events[final.events.length - 1]
  assert.match(last.detail, /not verified/)
  assert.match(last.detail, /not approved/)
})

test('исчерпанные лимиты ревью не выглядят как одобрение', () => {
  const runtime = new orch.OrchestrationRuntime(makeRun(), 100)
  orch.advanceAfterPhaseAnswer(runtime, 'plan', { at: 110 })
  for (let i = 0; i < orch.MAX_ORCHESTRATION_REVIEW_ROUNDS; i++) {
    orch.advanceAfterPhaseAnswer(runtime, `work ${i}`, { at: 200 + i * 10 })
    orch.advanceAfterPhaseAnswer(runtime, '<review verdict="revise">again</review>', { at: 205 + i * 10 })
  }
  const last = orch.advanceAfterPhaseAnswer(runtime, 'final work', { at: 900 })
  assert.equal(last.outcome, 'done')
  const closing = last.events[last.events.length - 1]
  assert.match(closing.detail, /not verified/)
  assert.match(closing.detail, /not approved/)
})

// ── Steer: устаревший вердикт не применяется ─────────────────────────────

test('вердикт по устаревшей ревизии не применяется — ревью переспрашивается', () => {
  const runtime = new orch.OrchestrationRuntime(makeRun(), 100)
  orch.advanceAfterPhaseAnswer(runtime, 'plan', { at: 110 })
  orch.advanceAfterPhaseAnswer(runtime, 'work', { at: 120 })
  // Пользователь вмешался, пока ревьюер думал.
  runtime.bumpRevision()
  const stale = orch.advanceAfterPhaseAnswer(runtime, '<review verdict="approve">LGTM</review>', { at: 130 })
  assert.equal(stale.outcome, 'continue')
  assert.equal(runtime.phase, 'reviewing')
  assert.match(stale.instruction, /RE-ASK/)
  // Следующий вердикт — по актуальной ревизии, применяется штатно.
  const approved = orch.advanceAfterPhaseAnswer(runtime, '<review verdict="approve">LGTM</review>', { at: 140 })
  assert.equal(approved.outcome, 'done')
  assert.equal(approved.answer, 'work')
  assert.match(approved.events[approved.events.length - 1].detail, /approved/)
})

test('stripOrchestrationTags снимает служебные теги, сохраняя текст', () => {
  assert.equal(orch.stripOrchestrationTags('a<answer/>b'), 'ab')
  assert.equal(orch.stripOrchestrationTags('<plan>1. read</plan>'), '1. read')
  assert.equal(orch.stripOrchestrationTags('ok'), 'ok')
})

// ── Resume («Продолжить» прерванный ран) ─────────────────────────────────

test('resume: ран стартует сразу с исполнения, без фазы planning', () => {
  const runtime = new orch.OrchestrationRuntime({
    ...makeRun(),
    resume: { plan: '1. add endpoint' },
  })
  // Планировщик не нужен: план уже утверждён в прерванном ране.
  assert.equal(runtime.phase, 'executing')
  const events = runtime.start('continuing the interrupted run')
  assert.equal(events.length, 1)
  assert.equal(events[0].phase, 'executing')
  assert.equal(events[0].model.modelId, 'claude-sonnet-4.5')
})

test('resume: без него ран по-прежнему начинается с планирования', () => {
  const runtime = new orch.OrchestrationRuntime(makeRun())
  assert.equal(runtime.phase, 'planning')
})

test('resume: инструкция исполнителя несёт план, сделанное и запрет пересборки', () => {
  const text = orch.phaseInstruction('executing', model('anthropic', 'claude-sonnet-4.5'), {
    resume: { plan: '1. add endpoint\n2. cover with tests', done: ['src/api.ts (+10 −2)'] },
  })
  assert.match(text, /CONTINUATION PHASE/)
  assert.match(text, /1\. add endpoint/)
  assert.match(text, /src\/api\.ts \(\+10 −2\)/)
  assert.match(text, /Do NOT re-research/)
  assert.match(text, /Already done:/)
})

test('resume: обычная executing-инструкция не содержит continuation-блока', () => {
  const text = orch.phaseInstruction('executing', model('anthropic', 'claude-sonnet-4.5'))
  assert.match(text, /EXECUTING PHASE/)
  assert.doesNotMatch(text, /CONTINUATION PHASE/)
})

test('transition из planning сохраняет план в снапшоте фазы', () => {
  const runtime = new orch.OrchestrationRuntime(makeRun())
  const events = runtime.transition('executing', { detail: 'plan accepted', plan: '1. step' })
  const closed = events.find(e => e.phase === 'planning' && e.status === 'done')
  assert.equal(closed.plan, '1. step')
  // План не приклеивается к executing — только к планированию.
  const opened = events.find(e => e.phase === 'executing' && e.status === 'running')
  assert.equal(opened.plan, undefined)
})

