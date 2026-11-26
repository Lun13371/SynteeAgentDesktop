/* global require, __dirname, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval, process, Buffer */
/* eslint-disable @typescript-eslint/no-require-imports -- Exercise production Agent loop with mocked providers. */
// §orchestration — функциональная интеграция РЕАЛЬНОГО цикла Agent.run()
// с фазовым автоматом: провайдер замокан, все внешние модули — заглушки.
//
// Проверяем именно поведение рана, а не текст исходников:
//  1) планировщик отвечает сам на read-only вопрос → исполнитель не вызывается;
//  2) план → исполнение → ревью approve → в ответ уходит работа исполнителя,
//     а промежуточные ответы фаз НЕ стримятся в answer;
//  3) явный блокер исполнителя уводит ран в replanning, затем работа доводится.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const IDENTITY = value => value

/** Транспиляция «чистого» модуля проекта (orchestration.ts импортирует только типы). */
function loadTsModule(relPath) {
  const file = path.join(__dirname, '..', relPath)
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: file,
  })
  const mod = { exports: {} }
  new Function('exports', 'require', 'module', '__filename', '__dirname', outputText)(
    mod.exports, require, mod, file, path.dirname(file),
  )
  return mod.exports
}

function loadAgent(stubs) {
  const file = path.join(__dirname, '..', 'src/core/agent/Agent.ts')
  const module = { exports: {} }
  const source = fs.readFileSync(file, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file,
  })
  vm.runInNewContext(outputText, {
    module,
    exports: module.exports,
    require: name => Object.hasOwn(stubs, name) ? stubs[name] : require(name),
    console: { log: () => {}, warn: () => {}, error: () => {} },
    AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval,
    process, Buffer, Promise, Date, Math, JSON, Map, Set, Number, String, Array, Object, RegExp, Error,
  }, { filename: file })
  return module.exports
}

const EMPTY_SETTINGS = {
  enabled: false, navigatorEnabled: false, watcherEnabled: false, janitorEnabled: false,
  hintBudgetTokens: 0, hintCooldownRounds: 0, orchestratorEnabled: false,
}

const RESPONSE = content => ({ content, tool_calls: [], hadStreamedTokens: false })

function harness(responses, options = {}) {
  const calls = []
  const steps = []
  const approvalModes = []
  const confirmations = []
  const executedTools = []
  let done = null
  const error = null
  const AIClient = class {
    constructor() {}
    async chatWithTools(messages, schemas, signal, role, onToken, _onCtx, _onRate, _onRetry, onUsage, _onThink, _onThinkDone, _onToolStart, phaseModelOverride) {
      calls.push({ messages: messages.slice(), schemas, phaseModelOverride })
      const next = responses.shift()
      if (!next) throw new Error('unexpected provider call #' + calls.length)
      return typeof next === 'string' ? RESPONSE(next) : next
    }
    async complete() { return 'judged' }
  }
  const { Agent } = loadAgent({
    './orchestration': loadTsModule('src/core/agent/orchestration.ts'),
    '../ai/AIClient': { AIClient },
    '../ai/visionSupport': { agentModelSupportsVision: () => false },
    '../ai/toolImageHistory': { hydrateHistoryContents: () => [] },
    '../ai/shared': { MAX_TOOL_TIMEOUT_MS: 1000 },
    '../../shared/imageFormat': { ImageRequestBudget: class { accept() {} } },
    '../../shared/steer': { STEER_MARKER: '[[steer]]' },
    '../../shared/finalAnswer': {
      isFinalAnswerToolName: () => false,
      takeFinalAnswerToolCalls: calls => ({ calls, removed: 0, text: '' }),
    },
    '../../shared/assistants': { DEFAULT_ASSISTANTS_SETTINGS: EMPTY_SETTINGS },
    '../../shared/subagent-roles': { getSubagentRole: () => undefined },
    '../../shared/toolSettings': {
      filterToolSchemas: schemas => schemas,
      getToolSettings: () => ({}),
      isToolDisabled: () => false,
    },
    './nativeImageAnalysis': { NativeImageAnalysis: class { fail() {} respond() {} } },
    './commandSafety': {
      needsApproval: (_name, _args, mode) => {
        approvalModes.push(mode)
        return { confirm: mode === 'ask', block: false, level: 'safe' }
      },
      resolveAutoModeSettings: () => ({}), mergeForbiddenPaths: () => [],
      isAllowlisted: () => false, isSecretPath: () => false,
      maskSecretValues: IDENTITY, actionAllowlistKey: () => '',
    },
    './injectionGuard': {
      scanForInjection: () => ({ suspicious: false }), wrapUntrustedContent: IDENTITY,
      isMutatingTool: () => false, isScannedTool: () => false, isWebSourceTool: () => false,
      INJECTION_ESCALATION_STEPS: [],
    },
    './utils': {
      FALLBACK_SYSTEM_PROMPT: 'system', VERIFICATION_INTERVAL: 5,
      normalizeToolName: name => name, findMissingRequiredArgs: () => [],
      formatMissingArgsMessage: () => '', getToolErrorHint: () => '',
      isSequentialTool: () => false,
      buildToolFingerprint: (name, args) => ({ toolName: name, argsKey: JSON.stringify(args ?? {}) }),
      dropOldestRoundsIfOverflow: messages => messages,
      extractMcpServerName: () => null, imagePayloadInfos: () => [],
      tryRepairJson: raw => ({ fixed: false, repaired: raw, fixes: [] }),
      salvageEditFileArgs: () => null,
    },
    './validateArgs': { validateAndCoerceArgs: (_name, args) => ({ fixes: [], errors: [], args }) },
    './toolDispatcher': {
      ToolDispatcher: class {
        async executeTool(name) { executedTools.push(name); return { success: true, output: 'ok' } }
        maskSecretValuesInText(text) { return text }
        buildSummaryDetails() { return {} }
        getFileCacheUpdates() { return {} }
        getFileSnapshots() { return {} }
      },
    },
    './goalRuntime': { GoalRuntime: class {} },
    './goalEvaluator': { formatTranscript: () => '', makeGoalJudge: () => () => 'done' },
    'jsonrepair': { jsonrepair: raw => raw },
    '../context/structuredMemory': { updateStructuredMemory: () => '' },
    '../context/contextManager': {
      truncateToolResult: IDENTITY,
      getContextSettings: () => ({ diffJournalEnabled: false, diffJournalLines: 0, fileMapEnabled: false }),
      getModelContextWindow: () => 128000,
      getHardLimitTokens: () => 1000000,
      getHardLimitTargetTokens: () => 500000,
    },
    '../context/janitor': {
      Janitor: class {
        getArchiveEntries() { return [] }
        apply(messages) { return messages }
        updateSettings() {}
        recall() { return '' }
        hydrateArchive() {}
        restoreSummaries() {}
        getArchiveSize() { return 0 }
        shouldScan() { return false }
        scan() { return null }
        recallPage() { return '' }
      },
    },
    '../context/assistantState': {
      loadAssistantState: () => ({}), saveAssistantState: () => {}, ASSISTANT_STATE_VERSION: 1,
    },
    '../context/constitution': {
      Constitution: class {
        list() { return [] }
        serialize() { return '' }
        hydrate() {}
        addExplicit() { return [] }
      },
    },
    '../context/hintBudget': { consumeHintBudget: () => ({ selected: [], remaining: [] }), MAX_PENDING_HINTS: 10 },
    '../skills/skillManager': { getSkillManager: () => ({}) },
    '../tokens/usageTracker': { computeRequestContextSnapshot: () => ({ estimated: 0, breakdown: {} }) },
    '../prompts/buildSystemPrompt': {
      sanitizeToolInstructions: IDENTITY,
      splitSystemPromptForCache: text => ({ staticPart: text, dynamicPart: '' }),
    },
    '../codeMode': { executeCode: async () => ({ success: true, output: '' }), EphemeralArtifactStore: class {} },
    '../tools': { runCommand: async () => ({ success: true, output: '' }), TOOL_SCHEMAS: [] },
    '../logger': { log: () => {} },
  })
  const store = { get: key => options.store?.[key], set: () => {}, delete: () => {}, has: () => false }
  const agent = new Agent(store, options.role ?? 'main')
  agent.projectId = options.projectId
  const callbacks = {
    approvalMode: options.approvalMode,
    onConfirm: async name => { confirmations.push(name); return false },
    onStep: step => steps.push(step),
    onDone: (answer, details) => { done = { answer, details } },
    onError: err => { throw err },
  }
  return {
    calls, steps, agent, approvalModes, confirmations, executedTools,
    get done() { return done },
    get error() { return error },
    answers: () => steps.filter(s => s.type === 'answer').map(s => s.content),
    run: (userMessage, runOptions) => agent.run(userMessage, callbacks, 8, undefined, 'system prompt', [], options.schemas ?? [], runOptions),
  }
}

test('subagent uses the same project → global approval precedence as its parent', async () => {
  const schema = { type: 'function', function: { name: 'read_file' } }
  for (const [approvalMode, projectMode, expected] of [
    ['auto', 'full', 'full'], ['full', 'ask', 'ask'], ['full', undefined, 'full'],
  ]) {
    for (const role of ['main', 'subagent']) {
      const h = harness([
        { ...RESPONSE(''), tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"package.json"}' } }] },
        'done',
      ], {
        role, projectId: 'project', approvalMode, schemas: [schema],
        store: { projectPermissions: { project: { approvalMode: projectMode } } },
      })
      await h.run('read config')
      assert.deepEqual(h.approvalModes, [expected], `${role}: ${approvalMode} / ${projectMode}`)
      assert.deepEqual(h.confirmations, expected === 'ask' ? ['read_file'] : [])
      assert.deepEqual(h.executedTools, expected === 'ask' ? [] : ['read_file'])
    }
  }
})

const RUN = {
  planner: { providerId: 'openai', modelId: 'gpt-5-plan' },
  executor: { providerId: 'anthropic', modelId: 'claude-exec' },
  reviewer: { providerId: 'openai', modelId: 'gpt-5-review' },
}

test('agent/orchestration: планировщик отвечает сам — исполнитель не вызывается', async () => {
  const h = harness(['Ответ: код в src/core/agent/Agent.ts.\n<answer/>'])
  await h.run('где лежит цикл агента?', { orchestration: RUN })

  assert.equal(h.calls.length, 1, 'исполнитель не должен вызываться на read-only вопрос')
  assert.equal(h.calls[0].phaseModelOverride.modelId, 'gpt-5-plan')
  // Ровно один answer — реальный ответ планировщика, без служебного тега.
  assert.deepEqual(h.answers(), ['Ответ: код в src/core/agent/Agent.ts.'])
  assert.equal(h.done.answer, 'Ответ: код в src/core/agent/Agent.ts.')
})

test('agent/orchestration: plan → executing → reviewing approve, промежуточные ответы не стримятся', async () => {
  const h = harness([
    '1. поправить parser.ts',
    'Готово: parser.ts обновлён, тесты прошли.',
    '<review verdict="approve">ок</review>',
  ])
  await h.run('поправь парсер', { orchestration: RUN })

  assert.equal(h.calls.length, 3)
  assert.deepEqual(
    h.calls.map(c => c.phaseModelOverride.modelId),
    ['gpt-5-plan', 'claude-exec', 'gpt-5-review'],
  )
  // Единственный answer — работа исполнителя (не план и не вердикт).
  assert.deepEqual(h.answers(), ['Готово: parser.ts обновлён, тесты прошли.'])
  assert.equal(h.done.answer, 'Готово: parser.ts обновлён, тесты прошли.')
})

test('agent/orchestration: блокер исполнителя уводит ран в replanning, затем работа доводится', async () => {
  const h = harness([
    '1. прочитать конфиг',
    'Не могу: файл конфига недоступен.\n<blocker>файл конфига недоступен</blocker>',
    '1. спросить путь у пользователя, затем прочитать конфиг',
    'Готово: конфиг прочитан через путь по умолчанию.',
    '<review verdict="approve">ок</review>',
  ])
  await h.run('обнови конфиг', { orchestration: RUN })

  assert.equal(h.calls.length, 5)
  assert.deepEqual(
    h.calls.map(c => c.phaseModelOverride.modelId),
    ['gpt-5-plan', 'claude-exec', 'gpt-5-plan', 'claude-exec', 'gpt-5-review'],
  )
  assert.deepEqual(h.answers(), ['Готово: конфиг прочитан через путь по умолчанию.'])
  assert.equal(h.done.answer, 'Готово: конфиг прочитан через путь по умолчанию.')
})
