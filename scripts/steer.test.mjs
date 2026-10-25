import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)

// Транспилируем продовые функции без Electron/сети/логгера.
function load(path, mocks = {}, source = readFileSync(path, 'utf8')) {
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(
    id => (Object.hasOwn(mocks, id) ? mocks[id] : require(id)),
    module,
    module.exports,
  )
  return module.exports
}

const { STEER_MARKER } = load('src/shared/steer.ts')
const attachmentMarkdown = load('src/shared/attachmentMarkdown.ts')
const { convertMessagesToAnthropic } = load('src/core/ai/anthropicConverters.ts', {
  '../prompts/buildSystemPrompt': { SYSTEM_PROMPT_CACHE_BREAK: '<CACHE_BREAK>' },
})
const { messageToContextMessages } = load('src/main/ipc/chatContextHelpers.ts', {
  '../../shared/attachmentMarkdown': attachmentMarkdown,
  '../../shared/steer': { STEER_MARKER },
})

// ── Anthropic: реплика посреди рана не должна давать 400 ────────────────
// Anthropic требует чередования user/assistant. Steer приходит сразу после
// tool_result'ов, а они конвертируются в {role:'user'} → без склейки два
// user подряд → "roles must alternate".

test('Anthropic: tool_result + внедрённая реплика склеиваются в одну user-мессу', () => {
  const converted = convertMessagesToAnthropic([
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: 'file body' },
    { role: 'user', content: `${STEER_MARKER}\n\nещё тесты допиши` },
  ])

  assert.deepEqual(converted.messages.map(m => m.role), ['assistant', 'user'])
  const userMsg = converted.messages[1]
  assert.equal(userMsg.content.length, 2)
  // tool_result обязан идти первым блоком, текст реплики — после него.
  assert.equal(userMsg.content[0].type, 'tool_result')
  assert.equal(userMsg.content[0].tool_use_id, 'call-1')
  assert.equal(userMsg.content[1].type, 'text')
  assert.match(userMsg.content[1].text, /ещё тесты допиши/)
})

test('Anthropic: непустые user-мессажи без tool_result тоже склеиваются', () => {
  const converted = convertMessagesToAnthropic([
    { role: 'user', content: 'первая' },
    { role: 'user', content: 'вторая' },
    { role: 'assistant', content: 'ответ' },
  ])
  assert.deepEqual(converted.messages.map(m => m.role), ['user', 'assistant'])
  assert.deepEqual(converted.messages[0].content.map(b => b.text), ['первая', 'вторая'])
})

test('Anthropic: чередование сохраняется, лишних склеек нет', () => {
  const converted = convertMessagesToAnthropic([
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' },
  ])
  assert.deepEqual(converted.messages.map(m => m.role), ['user', 'assistant', 'user'])
  assert.equal(converted.messages[0].content, 'a')
})

// ── История: реплика не должна теряться на следующем ходу ──────────────
// В БД steer живёт шагом внутри assistant-сообщения (отдельного user-пузыря
// нет). При пересборке контекста он обязан вернуться как user-сообщение,
// иначе модель «забудет», что её поправляли по ходу дела.

const assistantWithSteer = {
  id: 'a1',
  chatId: 'c1',
  role: 'assistant',
  content: 'Готово, тесты добавлены.',
  createdAt: 1,
  isPinned: 0,
  toolSteps: [
    { id: 's1', type: 'tool_call', toolName: 'read_file', toolArgs: { path: 'x.ts' }, content: 'read_file', callId: 'call-1', timestamp: 1 },
    { id: 's2', type: 'tool_result', toolName: 'read_file', content: 'file body', success: true, callId: 'call-1', timestamp: 2 },
    { id: 's3', type: 'steer', content: 'ещё тесты допиши', steerId: 'steer-1', steerApplied: true, timestamp: 3 },
  ],
}

test('history: steer восстанавливается user-сообщением ПЕРЕД ответом ассистента', () => {
  const context = messageToContextMessages(assistantWithSteer)
  const userIdx = context.findIndex(m => m.role === 'user' && String(m.content).includes('ещё тесты допиши'))
  const assistantIdx = context.findIndex(m => m.role === 'assistant')
  assert.ok(userIdx >= 0, 'steer должен попасть в контекст как user-сообщение')
  assert.ok(assistantIdx >= 0)
  assert.ok(userIdx < assistantIdx, 'реплика идёт перед финальным ответом')
  assert.ok(String(context[userIdx].content).includes(STEER_MARKER), 'маркер внедрения должен сохраняться')
  // Steer не должен превращаться в tool-сообщение или tool_call.
  assert.equal(context.some(m => m.role === 'tool' && String(m.content).includes('ещё тесты')), false)
})

test('history: сообщение только со steer (без тулов) не теряется', () => {
  const context = messageToContextMessages({
    id: 'a2',
    chatId: 'c1',
    role: 'assistant',
    content: 'Учёл, продолжаю.',
    createdAt: 2,
    isPinned: 0,
    toolSteps: [
      { id: 's1', type: 'steer', content: 'не туда копаешь', steerId: 'steer-2', steerApplied: true, timestamp: 1 },
    ],
  })
  assert.deepEqual(context.map(m => m.role), ['user', 'assistant'])
  assert.match(String(context[0].content), /не туда копаешь/)
  assert.equal(context[1].content, 'Учёл, продолжаю.')
})

test('history: обычное сообщение без steer не меняется', () => {
  const context = messageToContextMessages({
    id: 'a3',
    chatId: 'c1',
    role: 'assistant',
    content: 'Просто ответ',
    createdAt: 3,
    isPinned: 0,
  })
  assert.deepEqual(context.map(m => m.role), ['assistant'])
  assert.equal(context[0].content, 'Просто ответ')
})

// ── Контракт каналов: опечатка в имени IPC разрывала бы фичу молча ──────
// main вешает хендлеры по строковым именам, preload зовёт их же — проверим,
// что имена сходятся и что worker принимает steer ДО флага «уже запущен»
// (иначе сообщение отбрасывалось бы как не-стартовое).

test('IPC: имена steer-каналов совпадают в main и preload', () => {
  const ipc = readFileSync('src/main/ipc/chat.ipc.ts', 'utf8')
  const preload = readFileSync('src/preload/index.ts', 'utf8')
  assert.ok(ipc.includes("ipcMain.handle('chat:steer'"), 'main: нет обработчика chat:steer')
  assert.ok(ipc.includes("ipcMain.handle('chat:steer:cancel'"), 'main: нет обработчика chat:steer:cancel')
  assert.ok(preload.includes("ipcRenderer.invoke('chat:steer', chatId, text, steerId)"), 'preload: chat:steer')
  assert.ok(preload.includes("ipcRenderer.invoke('chat:steer:cancel', chatId, steerId)"), 'preload: chat:steer:cancel')
})

test('Worker: steer/steer_cancel принимаются до флага agentStarted', () => {
  const worker = readFileSync('src/main/workers/ai-worker.ts', 'utf8')
  // Ищем именно СТРОКУ КОДА (с отступом): строковое вхождение встречается и в
  // комментарии-пояснении выше, из-за чего сравнение позиций врало.
  const started = worker.indexOf('\n  if (agentStarted) return')
  const steer = worker.indexOf("if (msg.type === 'steer')")
  const cancel = worker.indexOf("if (msg.type === 'steer_cancel')")
  assert.ok(started > 0 && steer > 0 && cancel > 0)
  assert.ok(steer < started, 'steer обязан обрабатываться до возврата «уже запущено»')
  assert.ok(cancel < started, 'steer_cancel обязан обрабатываться до возврата «уже запущено»')
})

test('Agent: cancelSteer снимает только ещё не внедрённую реплику', () => {
  const agent = readFileSync('src/core/agent/Agent.ts', 'utf8')
  assert.ok(agent.includes('cancelSteer(id: string): boolean'), 'нет метода cancelSteer')
  // Дренаж на границе раунда обязан учитывать, что реплику могли снять.
  assert.ok(agent.includes('this.pendingSteers.splice(0)'), 'нет дренажа pendingSteers')
})

test('UI: pending-карточка имеет крестик отмены, applied — нет', () => {
  const chain = readFileSync('src/renderer/src/components/ui/ToolChain/ToolChain.tsx', 'utf8')
  assert.ok(chain.includes('const canCancel = !applied && !!chatId && !!steerId'), 'крестик только у pending')
  assert.ok(chain.includes('tc2-steer-cancel'), 'нет разметки кнопки отмены')
  assert.ok(chain.includes('steerCancel(chatId, steerId)'), 'отмена не уходит в main')
})

test('Кнопка: молния и кольцо живут ТОЛЬКО в режиме «клик ушёл бы в очередь»', () => {
  const btn = readFileSync('src/renderer/src/components/ui/ChatInput/ChatInputActionButton.tsx', 'utf8')
  assert.ok(
    btn.includes('const holdingView = canSteer && (holding || !!holdActive)'),
    'иначе залипший флаг превращает иконку Send в молнию на обычном поле',
  )
})

test('Enter: удержание рушится на keyup, автоповтор не перезапускает таймер', () => {
  const input = readFileSync('src/renderer/src/components/ui/ChatInput/ChatInput.tsx', 'utf8')
  assert.ok(input.includes('if (e.repeat || enterHoldTimer.current !== null) return'), 'нет гейта автоповтора')
  assert.ok(input.includes('if (!enterSteerFired.current) handleSend()'), 'короткое нажатие должно отправлять на keyup')
  assert.ok(input.includes('onKeyUp={handleKeyUp}'), 'keyup не проброшен в редактор')
})
