/**
 * applyRollingWindowAsync — режимы full/last и токен-кап на tail.
 *
 * Семантика:
 *   full (и фокус-текст без режима) — tail ПУСТОЙ: вся live-история уходит
 *   в summary, модель начинает с «нового чата + резюме».
 *   last — tail = последний СЕГМЕНТ (последнее сообщение целиком, обычно
 *   ответ агента со всем тул-трафиком), остальное — в summary.
 *
 * Сегмент = развёртка одного Message (assistant(tool_calls) + tool × N +
 * todo-напоминание). Tail не режет Message посередине → tool-раунды целы.
 *
 * Токен-кап: если tail тяжелее 10% окна — старые tool-результаты ужимаются
 * (последние 8 дословно), пары call→result не ломаются. Если middle пуст
 * (вся история — один мега-ход) — trim-only компакция без нового summary.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function loadContextManager() {
  const source = fs.readFileSync(path.join(root, 'src/core/context/contextManager.ts'), 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  const requireShim = (spec) => {
    const resolved = path.join('src/core/context', spec).replace(/\\/g, '/')
    if (resolved.endsWith('tokens/usageTracker')) {
      return {
        estimateTokens: t => Math.ceil((t ?? '').length / 4),
        estimateMessagesTokens: msgs => msgs.reduce((n, m) => n + Math.ceil((m.content ?? '').length / 4), 0),
        estimateMessagesTokensAsync: async msgs => msgs.reduce((n, m) => n + Math.ceil((m.content ?? '').length / 4), 0),
        truncateToTokensAsync: async (text, _max) => ({ text, tokens: Math.ceil(text.length / 4), truncated: false }),
        TOOL_SCHEMAS_OVERHEAD: 0,
        getHardLimitTokens: () => 200000,
        getHardLimitTargetTokens: () => 160000,
        ROLLING_TRIGGER_PCT: 85,
      }
    }
    if (resolved.endsWith('tokens/modelCatalog')) return { getCatalogModel: () => undefined }
    if (resolved.endsWith('tokens/ModelContextLimits')) return { getContextLimit: () => 200000 }
    if (resolved.endsWith('shared/data/builtinModels')) return { BUILTIN_MODELS: [] }
    if (resolved.endsWith('tokens/gatewayModelsCache')) return { getGatewayModelsCache: () => [], GATEWAY_PROVIDER_ID: 'gateway' }
    return {}
  }
  vm.runInNewContext(js, { module, exports: module.exports, require: requireShim })
  return module.exports
}

const { applyRollingWindowAsync } = loadContextManager()

// ── Фикстуры: развертка Message → ChatMessage, как в messageToContextMessages ─
let seq = 0
/** Реальный user-Message: разворачивается ровно в 1 ChatMessage. */
const u = (text) => [{ role: 'user', content: text, messageId: `m${seq++}` }]
/** Текстовый assistant-Message без тулов. */
const aText = (text) => [{ role: 'assistant', content: text, messageId: `m${seq++}` }]
/** Агентский assistant-Message: assistant(tool_calls) + tool × N. */
const aAgent = (text, nTools, resultChars = 50) => {
  const id = `m${seq++}`
  const out = [{
    role: 'assistant',
    content: text,
    tool_calls: Array.from({ length: nTools }, (_, i) => ({
      id: `call_${id}_${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' },
    })),
    messageId: id,
  }]
  for (let i = 0; i < nTools; i++) {
    out.push({
      role: 'tool',
      content: `tool result ${i}: ${'x'.repeat(resultChars)}`,
      tool_call_id: `call_${id}_${i}`,
      name: 'read_file',
      messageId: id,
    })
  }
  return out
}
/** Агентский ход с незавершённым todo — развёртка заканчивается user-напоминанием. */
const aAgentTodo = (text, nTools) => {
  const out = aAgent(text, nTools)
  out.push({ role: 'user', content: '[CURRENT TASK PLAN — state as of the previous message]', messageId: out[0].messageId })
  return out
}

const SETTINGS = { rollingKeepFirst: 2, rollingKeepLast: 20, rollingTriggerPct: 85, contextLimitTokens: 200000 }
const summaryFn = async () => 'SUMMARY'

const compact = (messages, mode) =>
  applyRollingWindowAsync(messages, SETTINGS, summaryFn, undefined, true, mode)

// ── last: всё в summary, кроме последнего сообщения ───────────────────────────

test('last держит только последнее сообщение (сегмент целиком), остальное в summary', async () => {
  const history = [
    ...u('вопрос 1'),
    ...aAgent('ответ 1', 3),
    ...u('вопрос 2'),
    ...aAgent('ответ 2', 3),
  ]
  const result = await compact(history, 'last')
  assert.equal(result.compressed, true)
  // tail = последний сегмент целиком: assistant + 3 tool-результата
  assert.equal(result.messages.length, 4)
  assert.equal(result.messages[0].role, 'assistant')
  assert.equal(result.messages[0].content, 'ответ 2')
  assert.equal(result.messages.filter(m => m.role === 'tool').length, 3)
  // middle = u1 + a1 + u2 → 3 реальных Message в summary
  assert.equal(result.removedCount, 3)
})

test('last при ходе с todo держит сегмент целиком (включая todo-напоминание)', async () => {
  const history = [
    ...u('вопрос 1'),
    ...aAgent('ответ 1', 2),
    ...u('вопрос 2'),
    ...aAgentTodo('ответ 2', 2),
  ]
  const result = await compact(history, 'last')
  assert.equal(result.compressed, true)
  const roles = result.messages.map(m => m.role)
  // [assistant, tool, tool, user(todo)] — сегмент целиком
  assert.equal(roles[0], 'assistant')
  assert.equal(roles[roles.length - 1], 'user')
  assert.equal(result.messages.length, 4)
  assert.equal(result.removedCount, 3)
})

test('last на паре сообщений: middle = всё, кроме последнего', async () => {
  const history = [...u('вопрос 1'), ...aAgent('ответ 1', 2)]
  const result = await compact(history, 'last')
  assert.equal(result.compressed, true)
  assert.equal(result.removedCount, 1)
  assert.equal(result.messages.length, 3)
})

// ── full: вся история в summary, tail пустой ──────────────────────────────────

test('full: tail пустой — вся история уходит в summary', async () => {
  const history = []
  for (let i = 1; i <= 12; i++) {
    history.push(...u(`вопрос ${i}`), ...aText(`ответ ${i}`))
  }
  const result = await compact(history, 'full')
  assert.equal(result.compressed, true)
  assert.equal(result.messages.length, 0, 'tail пуст — модели остаётся только резюме')
  assert.equal(result.summaryAdded, true)
  assert.equal(result.removedCount, 24, 'все 24 реальных Message в summary')
})

test('full в агентском чате: тоже всё в summary, трим не нужен', async () => {
  const history = [
    ...u('вопрос 1'),
    ...aAgent('ответ 1', 30),
    ...u('вопрос 2'),
    ...aAgent('ответ 2', 25),
  ]
  const result = await compact(history, 'full')
  assert.equal(result.compressed, true)
  assert.equal(result.messages.length, 0)
  assert.equal(result.removedCount, 4)
  assert.equal(result.trimmedToolResults, 0, 'trim не нужен — tail пуст')
})

test('full на 1 сообщении сжимает в резюме; last на 1 сообщении — отказ', async () => {
  const single = [...u('единственное сообщение')]
  const full = await compact(single, 'full')
  assert.equal(full.compressed, true, 'full сжимает всё — даже одно сообщение')
  assert.equal(full.messages.length, 0)
  const last = await compact(single, 'last')
  assert.equal(last.compressed, false, 'last нечего оставлять — единственное сообщение и есть tail')
})

// ── Summary: только middle, tail не попадает ──────────────────────────────────

test('summary строится из middle: контент tail не попадает в суммаризацию', async () => {
  let captured = ''
  const history = [
    ...u('старый вопрос про миграции'),
    ...aText('старый ответ'),
    ...u('вопрос 2'),
    ...aText('ответ 2'),
  ]
  await applyRollingWindowAsync(history, SETTINGS, async (_sys, user) => { captured = user; return 'SUMMARY' }, undefined, true, 'last')
  assert.match(captured, /старый вопрос про миграции/)
  assert.match(captured, /вопрос 2/, 'вопрос 2 в middle — суммаризуется')
  assert.doesNotMatch(captured, /ответ 2/, 'ответ 2 — это tail, в summary не попадает')
})

// ── Токен-кап: мега-ходы ──────────────────────────────────────────────────────

test('last на мега-ходе: старые tool-результаты ужимаются, последние 8 дословно', async () => {
  // 40 tool-результатов × 6000 символов ≈ 60k токенов в tail — кап 10%×200k=20k
  const history = [
    ...u('вопрос 0'),
    ...aText('ответ 0'),
    ...u('вопрос 1'),
    ...aAgent('ответ 1', 40, 6000),
  ]
  const result = await compact(history, 'last')
  assert.equal(result.compressed, true)
  assert.equal(result.removedCount, 3)
  assert.equal(result.trimmedToolResults, 32, 'ужато 40-8')
  // Структура цела: все 40 tool-сообщений и пары на месте
  const tools = result.messages.filter(m => m.role === 'tool')
  assert.equal(tools.length, 40)
  assert.equal(result.messages.find(m => m.role === 'assistant').tool_calls.length, 40)
  // Последние 8 — дословно, более старые — ужаты до head+хвоста
  assert.ok(tools.slice(-8).every(m => m.content.length > 6000))
  assert.ok(tools.slice(0, 32).every(m => m.content.length < 450))
  // Вопрос и ответ не тронуты
  assert.equal(result.messages[0].content, 'ответ 1')
})

test('last на мелком tail ниже капа — тримминг не срабатывает', async () => {
  const history = [
    ...u('вопрос 0'),
    ...aText('ответ 0'),
    ...u('вопрос 1'),
    ...aAgent('ответ 1', 6, 100),
  ]
  const result = await compact(history, 'last')
  assert.equal(result.compressed, true)
  assert.equal(result.trimmedToolResults, 0)
  const tools = result.messages.filter(m => m.role === 'tool')
  assert.ok(tools.every(m => m.content.length < 150))
})

test('единственный мега-ход (middle пуст): last → trim-only без summary', async () => {
  // Реальный кейс: вся live-история = 1 мега-ход на 195k. last: middle=[],
  // новое summary не пишется (summaryFn не вызывается), вес съедает трим.
  const history = [...aAgent('ответ 1', 40, 6000)]
  let summaryCalled = false
  const result = await applyRollingWindowAsync(
    history, SETTINGS,
    async () => { summaryCalled = true; return 'S' },
    undefined, true, 'last',
  )
  assert.equal(result.compressed, true)
  assert.equal(result.removedCount, 0)
  assert.equal(result.summaryAdded, false)
  assert.equal(result.summaryContent, undefined)
  assert.equal(result.trimmedToolResults, 32)
  assert.equal(summaryCalled, false, 'summaryFn не должен вызываться')
  const tools = result.messages.filter(m => m.role === 'tool')
  assert.ok(tools.slice(-8).every(m => m.content.length > 6000))
  assert.ok(tools.slice(0, 32).every(m => m.content.length < 450))
})

test('лёгкий единственный сегмент: last — честный отказ', async () => {
  const result = await compact([...aText('один лёгкий ответ')], 'last')
  assert.equal(result.compressed, false)
  assert.equal(result.removedCount, 0)
})

test('tail не начинается с tool-сообщения (пары call→result целы)', async () => {
  const history = [
    ...u('вопрос 1'),
    ...aAgent('ответ 1', 4),
    ...u('вопрос 2'),
    ...aAgentTodo('ответ 2', 4),
  ]
  const result = await compact(history, 'last')
  assert.equal(result.compressed, true)
  assert.notEqual(result.messages[0].role, 'tool')
  assert.equal(result.messages[0].role, 'assistant')
})

test('авто-компакция (forceCompress=false) ниже токен-порога не срабатывает', async () => {
  const history = [...u('вопрос'), ...aText('ответ')]
  const result = await applyRollingWindowAsync(history, SETTINGS, summaryFn, undefined, false)
  assert.equal(result.compressed, false)
})

// ── Персистентный трим: маппинг callId → шаги tool_result ─────────────────────

function loadApplyToolTrimToSteps() {
  const src = fs.readFileSync(path.join(root, 'src/main/ipc/chatCompaction.ts'), 'utf8')
  const start = src.indexOf('export function applyToolTrimToSteps(')
  assert.ok(start >= 0, 'applyToolTrimToSteps not found in chatCompaction.ts')
  const end = src.indexOf('\n}', start) + 2
  assert.ok(end > start, 'unterminated applyToolTrimToSteps')
  const js = ts.transpileModule(src.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(js, { module, exports: module.exports })
  return module.exports.applyToolTrimToSteps
}

test('applyToolTrimToSteps: меняет только целевые tool_result, пары целы', () => {
  const apply = loadApplyToolTrimToSteps()
  const steps = [
    { type: 'tool_call', callId: 'c1', content: '' },
    { type: 'tool_result', callId: 'c1', content: 'BIG OUTPUT'.repeat(100) },
    { type: 'tool_call', callId: 'c2', content: '' },
    { type: 'tool_result', callId: 'c2', content: 'OTHER OUTPUT' },
    { type: 'steer', callId: undefined, content: '§steer' },
  ]
  const changed = apply(steps, new Map([['c1', 'TRIMMED']]))
  assert.equal(changed, true)
  assert.equal(steps[1].content, 'TRIMMED', 'целевой шаг ужат')
  assert.equal(steps[3].content, 'OTHER OUTPUT', 'шаг вне мапы не тронут')
  assert.equal(steps[0].type, 'tool_call', 'tool_call не тронут')
  assert.equal(steps[4].content, '§steer', 'steer не тронут')
  // Повторное применение того же контента — no-op
  assert.equal(apply(steps, new Map([['c1', 'TRIMMED']])), false)
})
