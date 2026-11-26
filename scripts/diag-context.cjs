/* Диагностика счётчика контекста на РЕАЛЬНЫХ данных прода.
   Собирает историю прод-кодом (buildContextHistory + applyJanitorSummaries),
   считает токены и сравнивает с prompt_tokens, который вернул провайдер.
   Временный скрипт. Запуск: node scripts/diag-context.cjs <chatId> [realPrompt] */
const path = require('path')
const fs = require('fs')
const vm = require('vm')
const ts = require('typescript')
const Database = require('better-sqlite3')

const USER_DATA = process.env.SYNTEE_USER_DATA
  || path.join(process.env.APPDATA || path.join(require('os').homedir(), 'AppData/Roaming'), 'SynteeHelper')
const CHAT = process.argv[2] || '6c9b7189-3e76-4e78-a78f-5660bf2aeaa1'
const REAL = process.argv[3] ? Number(process.argv[3]) : null

function load(file, deps = {}) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  const code = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports, TextEncoder, console,
    require: name => (name in deps ? deps[name] : require(name)),
  })
  return module.exports
}

const contract = load('src/shared/contextUsage.ts')
const usage = load('src/core/tokens/usageTracker.ts', {
  './modelCatalog': {}, './gatewayModelsCache': {}, '../../shared/data/builtinModels': {},
  '../../shared/imageFormat': { IMAGE_TOKEN_COST: 1000 }, './ModelPricing': {},
  '../../shared/contextUsage': contract,
})
const state = load('src/core/context/assistantState.ts')
const assistants = load('src/shared/assistants.ts')
const helpers = load('src/main/ipc/chatContextHelpers.ts', {
  '../../shared/types': {}, '../../core/context/contextManager': {},
  '../../shared/attachmentMarkdown': { stripAttachTokens: t => t },
  '../../shared/steer': { STEER_MARKER: '[[steer]]' }, '../../shared/assistants': assistants,
})

const db = new Database(path.join(USER_DATA, 'syntee.db'), { readonly: true })
const json = v => { if (v == null || v === '') return undefined; try { return JSON.parse(v) } catch { return undefined } }

const raw = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC').all(CHAT)
const rows = raw.map(r => ({
  id: r.id, chatId: r.chat_id, role: r.role, content: r.content, createdAt: r.created_at,
  isPinned: r.is_pinned, model: r.model,
  toolSteps: json(r.tool_steps), iterations: json(r.iterations), thinking: r.thinking,
  thinkingBlocks: json(r.thinking_blocks), todo: json(r.todo), planData: json(r.plan_data),
  slashCommand: json(r.slash_command), hiddenFromContext: r.hidden_from_context,
  promptTokens: r.prompt_tokens, completionTokens: r.completion_tokens,
}))

let lastCompact = -1
rows.forEach((m, i) => { if (m.role === 'system' && m.slashCommand) lastCompact = i })
const live = rows.slice(lastCompact + 1)
const history = helpers.buildContextHistory(live)
const archive = state.loadAssistantState(USER_DATA, CHAT)?.janitorArchive
const applied = state.applyJanitorSummaries(history, archive)

// «До фикса» — та же история, но reasoning_content учитывается.
function tokensWithReasoning(msgs) {
  const T = t => usage.estimateTokens(t ?? '')
  let sum = 0
  for (const m of msgs) {
    const content = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map(p => p.text ?? '').join('') : ''
    sum += T(content) + 4
    if (m.tool_call_id) sum += T(m.tool_call_id)
    if (m.name) sum += T(m.name)
    if (m.reasoning_content) sum += T(m.reasoning_content)
    if (m.thinking_blocks?.length) for (const b of m.thinking_blocks) sum += T(b.thinking) + T(b.signature)
    if (Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) { try { sum += T(JSON.stringify(tc)) } catch { } }
  }
  return sum
}

const after = usage.estimateMessagesTokensFull(history)
const before = tokensWithReasoning(history)
// prompt_tokens в БД — СУММА по всем раундам хода, а не один запрос, поэтому
// для сверки передавай реальный prompt из логов: node diag-context.cjs <chatId> 207491
const real = REAL

console.log('chat            :', CHAT)
console.log('db messages     :', rows.length, '→ после компакции:', live.length)
console.log('context messages:', history.length, '| janitor свёрток:', applied)
console.log('reasoning msgs  :', history.filter(m => m.reasoning_content).length,
  '| thinking_blocks msgs:', history.filter(m => m.thinking_blocks?.length).length)
console.log('')
console.log('оценка истории ДО фикса :', before, real ? `(${(before / real).toFixed(2)}x к real)` : '')
console.log('оценка истории ПОСЛЕ    :', after, real ? `(${(after / real).toFixed(2)}x к real)` : '')
if (real) console.log('остаток до real         :', real - after, '→ system prompt + tool schemas (норма 20-40k)')
else console.log('передай реальный prompt из логов вторым аргументом для сверки')
