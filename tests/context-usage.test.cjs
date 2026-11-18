/* global require, __dirname, TextEncoder, setTimeout, clearTimeout */
/* eslint-disable @typescript-eslint/no-require-imports -- Exercise production token accounting with isolated dependencies. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function load(file, dependencies = {}, globals = {}) {
  const module = { exports: {} }
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  vm.runInNewContext(code, {
    module, exports: module.exports, TextEncoder, setTimeout, clearTimeout,
    require: name => (name in dependencies ? dependencies[name] : require(name)),
    ...globals,
  })
  return module.exports
}

const contract = load('src/shared/contextUsage.ts')
const usage = load('src/core/tokens/usageTracker.ts', {
  './modelCatalog': {}, './gatewayModelsCache': {}, '../../shared/data/builtinModels': {},
  '../../shared/imageFormat': { IMAGE_TOKEN_COST: 1000 }, './ModelPricing': {},
  '../../shared/contextUsage': contract,
})

test('one set of thresholds: 60% warn, 85% critical, and pct is a single formula', () => {
  assert.equal(contract.contextPct(0, 1000), 0)
  assert.equal(contract.contextPct(500, 1000), 50)
  assert.equal(contract.contextPct(2000, 1000), 100, 'pct never exceeds 100')
  assert.equal(contract.contextPct(10, 0), 0, 'a zero window cannot divide by zero')
  assert.equal(contract.contextStatus(59), 'ok')
  assert.equal(contract.contextStatus(60), 'warn')
  assert.equal(contract.contextStatus(84), 'warn')
  assert.equal(contract.contextStatus(85), 'critical')
  // Snapshot path and payload path must agree — раньше main считал 60/85, а
  // renderer 80/95, и кольцо с панелью показывали разное состояние.
  const snapshot = usage.buildSnapshotFromReal({ promptTokens: 850, completionTokens: 1 }, 1000)
  assert.equal(snapshot.status, 'critical')
  const payload = contract.buildContextUsagePayload({ chatId: 'c', snapshot, source: 'real' })
  assert.equal(payload.status, 'critical')
  assert.equal(payload.pct, 85)
})

test('every emitted payload carries chatId and recomputes pct instead of trusting the caller', () => {
  const payload = contract.buildContextUsagePayload({
    chatId: 'chat-1',
    snapshot: { estimated: 250, limit: 1000, breakdown: { history: 250, system: 0, tools: 0, current: 0 } },
    source: 'estimate',
    scope: 'request',
    pct: 99, // приходит «снаружи» — должен быть пересчитан
    status: 'critical',
  })
  assert.equal(payload.chatId, 'chat-1', 'renderer filters by chatId; without it foreign chats leak in')
  assert.equal(payload.pct, 25)
  assert.equal(payload.status, 'ok')
  assert.equal(payload.source, 'estimate')
  assert.equal(payload.scope, 'request')
})

test('reasoning is counted once, not twice (thinking_blocks + reasoning_content are the same text)', () => {
  const thinking = 'думаю '.repeat(200)
  const oncePerField = usage.estimateMessagesTokensFull([{
    role: 'assistant', content: 'ok', thinking_blocks: [{ thinking, signature: 'sig' }],
  }])
  const bothFields = usage.estimateMessagesTokensFull([{
    role: 'assistant', content: 'ok', thinking, thinking_blocks: [{ thinking, signature: 'sig' }],
  }])
  assert.equal(bothFields, oncePerField, 'reasoning_content must not be added on top of thinking_blocks')
  const noReasoning = usage.estimateMessagesTokensFull([{ role: 'assistant', content: 'ok' }])
  const legacyOnly = usage.estimateMessagesTokensFull([{ role: 'assistant', content: 'ok', reasoning_content: thinking }])
  assert.ok(legacyOnly > noReasoning, 'a legacy message without blocks still pays for its reasoning')
})

test('calibration learns from provider truth and the next estimate uses it', () => {
  usage.setCalibrationModel('prov', 'model-x')
  const messages = [{ role: 'user', content: 'Проверка токенизации русского текста. '.repeat(50) }]
  const before = usage.computeContextSnapshot(messages, 200_000, { systemPrompt: 'system' }).estimated
  // Провайдер ответил вдвое меньшим prompt_tokens — типично для cl100k на русском.
  for (let i = 0; i < 12; i++) usage.recordEstimateCalibration(before, Math.round(before / 2))
  const after = usage.computeContextSnapshot(messages, 200_000, { systemPrompt: 'system' }).estimated
  assert.ok(after < before * 0.8, `estimate must shrink after calibration (${before} → ${after})`)
  assert.ok(usage.estimateCalibrationFactor() < 1)
  // Другая модель — свой коэффициент, оценки не смешиваются.
  usage.setCalibrationModel('prov', 'model-y')
  assert.equal(usage.estimateCalibrationFactor(), 1)
})

test('calibration ignores outliers instead of chasing them', () => {
  usage.setCalibrationModel('prov', 'model-z')
  usage.recordEstimateCalibration(1000, 5)      // мусор: в 200 раз меньше
  usage.recordEstimateCalibration(1000, 200_000) // мусор: в 200 раз больше
  assert.equal(usage.estimateCalibrationFactor(), 1)
})

test('calibration state is exportable and restorable (main → store → worker)', () => {
  usage.setCalibrationModel('prov', 'model-w')
  for (let i = 0; i < 12; i++) usage.recordEstimateCalibration(1000, 600)
  const exported = usage.exportCalibration()
  assert.ok(Object.keys(exported).length > 0)
  assert.ok(exported['prov:model-w'] < 1)
  usage.importCalibration({ 'prov:fresh': 0.7 })
  usage.setCalibrationModel('prov', 'fresh')
  assert.equal(usage.estimateCalibrationFactor(), 0.7)
})

// ── Джанитор ────────────────────────────────────────────────────────────────
// Агент сжимает tool-результаты только в памяти воркера, а `context:calculate`
// собирает историю из БД, где они лежат целиком. Без восстановления свёрток
// кольцо показывало несжатое значение (400k+) до прихода реального usage —
// «то 400к, то норм».
const assistantState = load('src/core/context/assistantState.ts')

test('janitor summaries are re-applied on DB history by exact content match', () => {
  const archive = [
    {
      id: 'jan-1-1',
      ts: 1,
      summary: '[janitor] read → резюме',
      originalMessages: [{ role: 'tool', tool_call_id: 'call-a', content: 'ОГРОМНЫЙ РЕЗУЛЬТАТ ЧТЕНИЯ' }],
    },
    {
      id: 'jan-2-1',
      ts: 2,
      summary: '[janitor] cmd → резюме',
      originalMessages: [{ role: 'tool', tool_call_id: 'call-b', content: 'ВЫВОД КОМАНДЫ' }],
    },
  ]
  const messages = [
    { role: 'tool', tool_call_id: 'call-a', content: 'ОГРОМНЫЙ РЕЗУЛЬТАТ ЧТЕНИЯ' },
    // Контент в БД уже другой (результат перезаписан) — резюме НЕ применяем.
    { role: 'tool', tool_call_id: 'call-b', content: 'другой вывод' },
    { role: 'assistant', content: 'обычный текст' },
  ]
  const applied = assistantState.applyJanitorSummaries(messages, archive)
  assert.equal(applied, 1, 'matches by tool_call_id AND original content')
  assert.equal(messages[0].content, '[janitor] read → резюме')
  assert.equal(messages[1].content, 'другой вывод', 'changed DB content must not be replaced')
  assert.equal(messages[2].content, 'обычный текст')
  // Пустой архив — ничего не меняем.
  assert.equal(assistantState.applyJanitorSummaries(messages, undefined), 0)
})

test('janitor savings are reported in the calibrated scale of the context ring', () => {
  usage.setCalibrationModel('savings', 'model')
  const big = 'lorem ipsum dolor sit amet '.repeat(400)
  const summary = '[janitor] короткое резюме'
  const rawSaved = usage.estimateTokens(big) - usage.estimateTokens(summary)
  assert.ok(rawSaved > 0)
  for (let i = 0; i < 14; i++) usage.recordEstimateCalibration(1000, 500)
  const factor = usage.estimateCalibrationFactor()
  assert.ok(factor < 0.9, 'calibration must have moved')
  const calibratedSaved = usage.estimateTokensCalibrated(big) - usage.estimateTokensCalibrated(summary)
  assert.ok(calibratedSaved < rawSaved, `economy must shrink with the factor (${rawSaved} → ${calibratedSaved})`)
})
