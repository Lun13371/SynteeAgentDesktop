const fs = require('node:fs'), path = require('node:path'), ts = require('typescript'), assert = require('node:assert/strict')

function load(file, deps = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => name in deps ? deps[name] : require(name), module, module.exports)
  return module.exports
}

const goalTypes = load('src/shared/types/goal.ts')
const evaluator = load('src/core/agent/goalEvaluator.ts', { '../../shared/types/goal': goalTypes })
const { GoalRuntime } = load('src/core/agent/goalRuntime.ts', {
  '../../shared/types/goal': goalTypes,
  './goalEvaluator': evaluator,
})

const baseGoal = (over = {}) => ({
  id: 'g', chatId: 'c', objective: 'npm test exits 0', criteria: [], constraints: [],
  progress: [], evidence: [], status: 'running', steps: 0, maxSteps: 0,
  createdAt: 1, startedAt: 1, updatedAt: 1, turnsEvaluated: 0, tokensSpent: 0, idleTurns: 0,
  ...over,
})

function runtime(over = {}, judge) {
  const saved = []
  const r = new GoalRuntime(baseGoal(over), value => saved.push(value), judge ?? (async () => ({ verdict: 'not_met', reason: 'not yet' })))
  return { r, saved }
}

// ── Вердикт выносит ОЦЕНЩИК, а не сама модель ────────────────────────────────
;(async () => {
  {
    const { r } = runtime({}, async () => ({ verdict: 'met', reason: 'npm test printed 0 failures' }))
    r.beginRound()
    assert.equal(await r.evaluate('transcript'), 'stop')
    assert.equal(r.goal.status, 'completed')
    assert.match(r.goal.evidence[0], /npm test printed 0 failures/)
    assert.equal(r.goal.turnsEvaluated, 1)
  }
  {
    // «Готово» в тексте модели ничего не подтверждает — решает вердикт оценщика.
    const { r } = runtime({}, async () => ({ verdict: 'not_met', reason: 'no test output in transcript' }))
    r.beginRound()
    assert.equal(r.reserveTool(), true) // инструменты были — не stall
    assert.equal(await r.evaluate('I am done, everything works'), 'continue')
    assert.equal(r.goal.status, 'running')
    assert.equal(r.goal.lastReason, 'no test output in transcript')
  }
  {
    const { r } = runtime({}, async () => ({ verdict: 'impossible', reason: 'test file is missing' }))
    r.beginRound()
    assert.equal(await r.evaluate('x'), 'stop')
    assert.equal(r.goal.status, 'blocked')
    assert.match(r.goal.blocker, /test file is missing/)
  }
  {
    // Три хода без инструментов — цикл приостанавливается, цель НЕ снимается.
    const { r } = runtime({}, async () => ({ verdict: 'not_met', reason: 'talking only' }))
    for (let i = 0; i < 3; i++) {
      r.beginRound()
      const decision = await r.evaluate('just talking')
      if (i < 2) assert.equal(decision, 'continue')
      else assert.equal(decision, 'stalled')
    }
    assert.equal(r.goal.status, 'running')
    assert.equal(r.goal.idleTurns, 3)
  }
  {
    // Ошибка транспорта оценщика не закрывает цель.
    const { r } = runtime({}, async () => { throw new Error('evaluator offline') })
    r.beginRound()
    assert.equal(await r.evaluate('x'), 'continue')
    assert.equal(r.goal.status, 'running')
  }
  {
    // Лимит раундов — опциональный предохранитель (0 = без лимита).
    const bounded = runtime({ maxSteps: 1 }).r
    assert.equal(bounded.beginRound(), undefined)
    assert.match(bounded.beginRound(), /round budget/)
    const unlimited = runtime({ maxSteps: 0 }).r
    for (let i = 0; i < 50; i++) assert.equal(unlimited.beginRound(), undefined)
  }
  {
    // Неисправимые ошибки снимают цель, транзиентные — нет.
    const { r } = runtime({})
    r.handleError('Network error: ECONNRESET')
    assert.equal(r.goal.status, 'running')
    r.handleError('Syntee session expired — sign in again')
    assert.equal(r.goal.status, 'blocked')
    assert.match(r.goal.blocker, /Запусти \/goal заново/)
  }
  {
    const { r } = runtime({})
    r.addTokens(1200); r.addTokens(800); r.addTokens(NaN)
    assert.equal(r.goal.tokensSpent, 2000)
  }

  // ── Чистые функции оценщика ───────────────────────────────────────────────
  assert.deepEqual(evaluator.parseVerdict('{"verdict":"met","reason":"ok"}'), { verdict: 'met', reason: 'ok' })
  assert.deepEqual(evaluator.parseVerdict('```json\n{"verdict":"not_met","reason":"no proof"}\n```'), { verdict: 'not_met', reason: 'no proof' })
  assert.equal(evaluator.parseVerdict('{"verdict":"met"}').reason, '')
  assert.equal(evaluator.parseVerdict('Not yet met: tests still fail').verdict, 'not_met')
  assert.equal(evaluator.parseVerdict('IMPOSSIBLE — the file does not exist').verdict, 'impossible')
  assert.equal(evaluator.parseVerdict('the condition is met in my opinion').verdict, 'met')
  assert.equal(evaluator.parseVerdict(''), undefined)

  const transcript = evaluator.formatTranscript([
    { role: 'system', content: 'goal instructions' },
    { role: 'user', content: 'fix auth' },
    { role: 'assistant', content: 'ok', tool_calls: [{ function: { name: 'run_command', arguments: '{"command":"npm test"}' } }] },
    { role: 'tool', content: 'exit code 1: 2 failing', name: 'run_command' },
  ])
  assert.ok(!transcript.includes('goal instructions'), 'system-сообщения оценщику не нужны')
  assert.match(transcript, /→ calls run_command/)
  assert.match(transcript, /tool result \(run_command\)/)
  assert.match(evaluator.formatTranscript([], {}), /empty transcript/)
  assert.match(evaluator.formatTranscript([{ role: 'system', content: 'x' }]), /empty transcript/)

  const long = evaluator.formatTranscript(Array.from({ length: 200 }, (_, i) => ({ role: 'user', content: `${i}:` + 'x'.repeat(500) })), { maxChars: 3000, perMessageChars: 400 })
  assert.ok(long.length < 3400, 'транскрипт обрезается до бюджета')
  assert.match(long, /earlier messages omitted/)

  assert.equal(evaluator.isUnrecoverableGoalError('insufficient credit balance'), true)
  assert.equal(evaluator.isUnrecoverableGoalError('502 bad gateway, retrying'), false)
  assert.equal(evaluator.isUnrecoverableGoalError(''), false)

  console.log('goal runtime regressions passed')
})().catch(error => { console.error(error); process.exit(1) })