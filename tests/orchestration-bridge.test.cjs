/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports -- Read and transpile project source. */
// §orchestration — проверка main-моста one-turn оркестрации.
//
// Две группы проверок:
//   1) правила main-стороны (src/main/ipc/orchestrationRun.ts) — модуль чистый
//      (только type-импорты), поэтому транспилируется и грузится как CJS;
//   2) статическая сверка «моста»: preload-подписка, канал события, workerData,
//      персист в messages, миграция и тип Message должны сходиться по именам —
//      electron в тестах недоступен, а рассинхрон канала ловится именно так.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function resolveTsPath(fromDir, request) {
  const base = path.resolve(fromDir, request)
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}

// Транспиляция с локальным require: тестируемый модуль может импортировать
// другие .ts проекта (shared/orchestrationProgress) — такие запросы резолвим и
// транспилируем сами, остальное (node-модули) отдаём обычному require.
const tsModuleCache = new Map()

function loadTsFile(file) {
  if (tsModuleCache.has(file)) return tsModuleCache.get(file).exports
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
  tsModuleCache.set(file, mod)
  const localRequire = (request) => {
    if (request.startsWith('.') || path.isAbsolute(request)) {
      const resolved = resolveTsPath(path.dirname(file), request)
      if (resolved) return loadTsFile(resolved)
    }
    return require(request)
  }
  new Function('exports', 'require', 'module', '__filename', '__dirname', outputText)(
    mod.exports, localRequire, mod, file, path.dirname(file),
  )
  return mod.exports
}

function loadTsModule(relPath) {
  return loadTsFile(path.join(__dirname, '..', relPath))
}

function readSource(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8')
}

const orch = loadTsModule('src/main/ipc/orchestrationRun.ts')
// Мерж/слим/block прогресса — общий хелпер (shared/orchestrationProgress):
// его реэкспортирует main и использует renderer.
const shared = loadTsModule('src/shared/orchestrationProgress.ts')

const model = (providerId, modelId, reasoningValue) => ({
  providerId, modelId, ...(reasoningValue ? { reasoningValue } : {}),
})

const providers = () => ([
  { id: 'openai', enabled: true },
  { id: 'anthropic', enabled: true },
  { id: 'off', enabled: false },
])

const phase = (over) => ({
  phase: 'planning',
  model: model('openai', 'gpt-5'),
  startedAt: 1000,
  updatedAt: 1000,
  status: 'running',
  ...over,
})

// ── 1. Правила main-стороны ────────────────────────────────────────────────

test('mode gate: Ask/Plan/image несовместимы с оркестрацией', () => {
  assert.equal(orch.orchestrationModeIssue({}), null)
  assert.equal(orch.orchestrationModeIssue({ oneShotMode: 'code' }), null)
  assert.match(orch.orchestrationModeIssue({ askMode: true }), /Ask/)
  assert.match(orch.orchestrationModeIssue({ oneShotMode: 'ask' }), /Ask/)
  assert.match(orch.orchestrationModeIssue({ planningMode: true }), /Plan/)
  assert.match(orch.orchestrationModeIssue({ oneShotMode: 'plan' }), /Plan/)
  assert.match(orch.orchestrationModeIssue({ imageMode: true }), /изображен/)
})

test('selection: исполнитель обязателен, ревьюер опционален', () => {
  assert.equal(orch.orchestrationSelectionIssue(undefined), null)
  assert.equal(orch.orchestrationSelectionIssue(null), null)
  assert.match(orch.orchestrationSelectionIssue({}), /исполнител/)
  assert.match(orch.orchestrationSelectionIssue({ executor: { providerId: 'openai' } }), /исполнител/)
  assert.equal(orch.orchestrationSelectionIssue({ executor: model('openai', 'gpt-5') }), null)
  assert.equal(orch.orchestrationSelectionIssue({
    executor: model('openai', 'gpt-5'), reviewer: model('anthropic', 'claude'),
  }), null)
  assert.match(orch.orchestrationSelectionIssue({
    executor: model('openai', 'gpt-5'), reviewer: { modelId: 'claude' },
  }), /ревьюер/)
})

test('freeze: ревьюер по умолчанию = планировщик (ЯВНО, не undefined)', () => {
  const planner = model('openai', 'gpt-5-plan', 'high')
  const run = orch.freezeOrchestrationRun({ executor: model('anthropic', 'claude-opus') }, planner)
  assert.ok(run)
  assert.deepEqual(run.planner, planner)
  assert.deepEqual(run.executor, model('anthropic', 'claude-opus'))
  // Ключевое: reviewer присутствует и равен планировщику — core при
  // undefined пропускает фазу ревью, поэтому «пусто» здесь запрещено.
  assert.deepEqual(run.reviewer, planner)
})

test('freeze: явный ревьюер сохраняется, битый выбор → null', () => {
  const planner = model('openai', 'gpt-5-plan')
  const reviewer = model('anthropic', 'claude-review', 'medium')
  const run = orch.freezeOrchestrationRun(
    { executor: model('anthropic', 'claude-opus'), reviewer },
    planner,
  )
  assert.deepEqual(run.reviewer, reviewer)
  assert.equal(orch.freezeOrchestrationRun(null, planner), null)
  assert.equal(orch.freezeOrchestrationRun({ executor: model('anthropic', '') }, planner), null)
  assert.equal(orch.freezeOrchestrationRun({ executor: model('anthropic', 'x') }, null), null)
})

test('providers: ревалидация всех ролей, без fallback', () => {
  const run = orch.freezeOrchestrationRun(
    { executor: model('anthropic', 'claude-opus') },
    model('openai', 'gpt-5-plan'),
  )
  assert.equal(orch.orchestrationProviderIssue(run, providers()), null)
  assert.match(orch.orchestrationProviderIssue(run, [{ id: 'openai', enabled: true }]), /anthropic/)
  assert.match(
    orch.orchestrationProviderIssue(run, [{ id: 'openai', enabled: true }, { id: 'anthropic', enabled: false }]),
    /отключён/,
  )
  // Ревьюер тоже проверяется (он же планировщик по умолчанию).
  assert.match(orch.orchestrationProviderIssue(run, [{ id: 'anthropic', enabled: true }]), /openai/)
  assert.equal(orch.orchestrationProviderIssue(null, providers()), null)
})

test('merge: одно вхождение фазы обновляется на месте, повтор — отдельной записью', () => {
  let phases = []
  phases = orch.mergeOrchestrationProgress(phases, phase({ phase: 'planning', startedAt: 10, updatedAt: 10 }))
  // running → done того же вхождения: обновление, не дубль.
  phases = orch.mergeOrchestrationProgress(phases, phase({ phase: 'planning', startedAt: 10, status: 'done', updatedAt: 15 }))
  assert.equal(phases.length, 1)
  assert.equal(phases[0].status, 'done')

  phases = orch.mergeOrchestrationProgress(phases, phase({ phase: 'executing', startedAt: 20, updatedAt: 20 }))
  phases = orch.mergeOrchestrationProgress(phases, phase({ phase: 'executing', startedAt: 20, status: 'done', updatedAt: 40 }))
  phases = orch.mergeOrchestrationProgress(phases, phase({ phase: 'replanning', startedAt: 50, updatedAt: 50 }))
  phases = orch.mergeOrchestrationProgress(phases, phase({ phase: 'replanning', startedAt: 50, status: 'done', updatedAt: 55 }))
  // Второй круг executing (после replanning) — ИСТОРИЯ КРУГОВ, а не замена.
  phases = orch.mergeOrchestrationProgress(phases, phase({ phase: 'executing', startedAt: 60, updatedAt: 60 }))

  assert.deepEqual(phases.map(p => p.phase), ['planning', 'executing', 'replanning', 'executing'])
  assert.deepEqual(phases.map(p => p.startedAt), [10, 20, 50, 60])
  assert.equal(phases[3].status, 'running')
  // Идемпотентность: повторная доставка того же события и null — без изменений.
  const before = phases.length
  phases = orch.mergeOrchestrationProgress(phases, phase({ phase: 'executing', startedAt: 60, updatedAt: 60 }))
  assert.equal(phases.length, before)
  assert.equal(orch.mergeOrchestrationProgress(phases, null).length, before)
})

test('merge: устаревшее событие не откатывает статус и не двигает таймер', () => {
  let phases = orch.mergeOrchestrationProgress([], phase({ phase: 'executing', startedAt: 20, updatedAt: 20 }))
  phases = orch.mergeOrchestrationProgress(phases, phase({
    phase: 'executing', startedAt: 20, status: 'done', updatedAt: 40,
  }))
  const stale = orch.mergeOrchestrationProgress(phases, phase({
    phase: 'executing', startedAt: 20, status: 'running', updatedAt: 25,
  }))
  assert.equal(stale.length, 1)
  assert.equal(stale[0].status, 'done')
  assert.equal(stale[0].updatedAt, 40)
})

test('merge: повтор в ту же миллисекунду разводится seq, ключи не коллидируют', () => {
  let phases = orch.mergeOrchestrationProgress([], phase({ phase: 'reviewing', startedAt: 70, updatedAt: 70 }))
  // Круг закрылся в ту же мс, в которую стартовал.
  phases = orch.mergeOrchestrationProgress(phases, phase({
    phase: 'reviewing', startedAt: 70, status: 'done', updatedAt: 70,
  }))
  // Новый круг стартовал в ту же мс: running по закрытой записи → новое вхождение.
  phases = orch.mergeOrchestrationProgress(phases, phase({
    phase: 'reviewing', startedAt: 70, status: 'running', updatedAt: 71,
  }))
  assert.equal(phases.length, 2)
  assert.equal(phases[0].status, 'done')
  assert.equal(phases[1].status, 'running')
  assert.notEqual(phases[0].seq, phases[1].seq)

  // Запоздавшее running со стартом РАНЬШЕ закрытия предыдущего круга — устаревшее.
  const stale = orch.mergeOrchestrationProgress(phases, phase({
    phase: 'reviewing', startedAt: 60, status: 'running', updatedAt: 72,
  }))
  assert.equal(stale.length, 2)
  assert.equal(stale[stale.length - 1].status, 'running')
  assert.equal(stale[stale.length - 1].startedAt, 70)
})

test('cap: потолок сохраняет якорь таймера и актуальный хвост', () => {
  const many = Array.from({ length: 20 }, (_, i) => phase({
    phase: 'executing', startedAt: 100 + i, status: i === 19 ? 'running' : 'done',
  }))
  const capped = orch.capOrchestrationPhases(many)
  assert.equal(capped.length, orch.ORCH_PHASES_MAX)
  // Первая запись — самая ранняя фаза: карточка считает elapsed от неё.
  assert.equal(capped[0].startedAt, 100)
  assert.equal(capped[capped.length - 1].startedAt, 119)
  assert.equal(orch.capOrchestrationPhases([]).length, 0)

  // Live-мерж тоже не растёт без границ (карточка + буфер рендера).
  let live = []
  for (let i = 0; i < 30; i++) {
    live = orch.mergeOrchestrationProgress(live, phase({ phase: 'executing', startedAt: 200 + i, updatedAt: 200 + i }))
  }
  assert.equal(live.length, orch.ORCH_PHASES_MAX)
  assert.equal(live[0].startedAt, 200)
  assert.equal(live[live.length - 1].startedAt, 229)
})

test('slim: detail урезан, пустой снапшот → undefined', () => {
  assert.equal(orch.slimOrchestrationPhases([]), undefined)
  assert.equal(orch.slimOrchestrationPhases(undefined), undefined)
  const long = 'x'.repeat(500)
  const slim = orch.slimOrchestrationPhases([phase({ detail: long })])
  assert.equal(slim.length, 1)
  assert.equal(slim[0].detail.length, orch.ORCH_DETAIL_MAX)
  assert.deepEqual(slim[0].model, model('openai', 'gpt-5'))
  // Лимит записей — карточка не раздувает сообщение даже при цикле фаз.
  const many = Array.from({ length: 20 }, (_, i) => phase({ phase: 'executing', startedAt: i }))
  assert.equal(orch.slimOrchestrationPhases(many).length, orch.ORCH_PHASES_MAX)
})

test('stop/error: незакрытая фаза становится blocked', () => {
  const phases = [phase({ phase: 'planning', status: 'done', startedAt: 1 }),
    phase({ phase: 'executing', status: 'running', startedAt: 2 })]
  const blocked = orch.blockRunningOrchestrationPhase(phases, 'stopped by the user', 99)
  assert.equal(blocked[0].status, 'done')
  assert.equal(blocked[1].status, 'blocked')
  assert.equal(blocked[1].updatedAt, 99)
  assert.match(blocked[1].detail, /stopped/)
  assert.deepEqual(orch.blockRunningOrchestrationPhase([], 'x'), [])
})

// ── 2. Сверка моста (preload ↔ main ↔ DB ↔ renderer) ───────────────────────

test('bridge: канал события объявлен один раз и совпадает у main/preload/renderer', () => {
  const constants = readSource('src/shared/constants.ts')
  assert.match(constants, /AGENT_ORCHESTRATION_PROGRESS: 'agent:orchestration_progress'/)

  const preload = readSource('src/preload/index.ts')
  assert.match(preload, /onOrchestrationProgress: \(cb: \(event: \{/)
  assert.match(preload, /ipcRenderer\.on\('agent:orchestration_progress', handler\)/)
  assert.match(preload, /orchestration\?: import\('\.\.\/shared\/orchestration'\)\.OrchestrationSelection/)
  // Никаких битых относительных импортов из src/preload (было '../../shared').
  assert.doesNotMatch(preload, /'\.\.\/\.\.\/shared\//)

  const main = readSource('src/main/ipc/chatSendEngine.ts')
  assert.match(main, /IPC_EVENTS\.AGENT_ORCHESTRATION_PROGRESS/)
  // Событие адресуется РАНУ (assistantMsgId), а не произвольному msgId из воркера.
  assert.match(main, /msgId: assistantMsgId,\s*\n\s*progress,/)
  assert.match(main, /orchestration: orchestrationRun \?\? undefined/)
  assert.match(main, /orchestrationProviderIssue\(/)

  const rendererHook = readSource('src/renderer/src/hooks/useOrchestrationProgress.ts')
  assert.match(rendererHook, /onOrchestrationProgress/)
  assert.match(rendererHook, /agent:orchestration_progress/)
})

test('bridge: live state отдаёт orchestration на верхнем уровне', () => {
  const ipc = readSource('src/main/ipc/chat.ipc.ts')
  const liveStateBlock = ipc.slice(ipc.indexOf("ipcMain.handle('chat:getLiveState'"))
  assert.match(liveStateBlock, /orchestration: run\.orchestration,/)
  // renderer читает именно top-level (fallback на liveState — для старых сборок).
  const runtime = readSource('src/renderer/src/hooks/chatRunRuntime.ts')
  assert.match(runtime, /live\.orchestration \?\? live\.liveState\?\.orchestration/)
})

test('bridge: Message.orchestration персистится в messages', () => {
  const types = readSource('src/shared/types/chat.ts')
  assert.match(types, /orchestration\?: import\('\.\.\/orchestration'\)\.OrchestrationProgress\[\]/)

  const db = readSource('src/core/db/messages.ts')
  assert.match(db, /orchestration\)\r?\n\s*VALUES \(/)
  assert.match(db, /msg\.orchestration \? JSON\.stringify\(msg\.orchestration\) : null/)
  assert.match(db, /orchestration as orchestrationJson/)
  assert.match(db, /orchestration: orchestrationJson \? JSON\.parse\(orchestrationJson\) : undefined/)

  const migration = readSource('src/core/db/migrations/incremental.ts')
  assert.match(migration, /ALTER TABLE messages ADD COLUMN orchestration TEXT/)
})

// ── 3. Общий мерж/кап прогресса (shared/orchestrationProgress) ─────────────

test('shared: мерж один — main реэкспортирует, renderer использует тот же модуль', () => {
  // Одна реализация на оба конца моста: live-карточка и персист не расходятся.
  assert.equal(orch.mergeOrchestrationProgress, shared.mergeOrchestrationProgress)
  assert.equal(orch.slimOrchestrationPhases, shared.slimOrchestrationPhases)
  assert.equal(orch.blockRunningOrchestrationPhase, shared.blockRunningOrchestrationPhase)
  assert.equal(orch.ORCH_PHASES_MAX, shared.ORCH_PHASES_MAX)

  const renderer = readSource('src/renderer/src/utils/orchestrationProgress.ts')
  assert.match(renderer, /from '\.\.\/\.\.\/\.\.\/shared\/orchestrationProgress'/)
  assert.match(renderer, /mergeOrchestrationProgress/)
  // Локальной копии мержа «по одной фазе» больше нет.
  assert.doesNotMatch(renderer, /prev\.findIndex\(p => p\.phase === incoming\.phase\)/)

  // Контракт типов не менялся: seq живёт только в shared-хелпере.
  const contract = readSource('src/shared/orchestration.ts')
  assert.doesNotMatch(contract, /seq\??:/)
})

test('card: повтор фазы — отдельная строка, порядок и таймер из общего хелпера', () => {
  const card = readSource('src/renderer/src/components/ui/OrchestrationCard/OrchestrationCard.tsx')
  assert.match(card, /compareOrchestrationPhases/)
  // Ключ строки включает startedAt/seq — иначе React склеил бы повторы фаз.
  assert.match(card, /key=\{`\$\{p\.phase\}@\$\{p\.startedAt \?\? 0\}#/)
  // Таймер рана — от самой ранней фазы (якорь сохраняет cap).
  assert.match(card, /const startedAtMs = starts\.length \? Math\.min\(\.\.\.starts\) : now/)
})

test('recovery: буфер чекпоинта закрывает незавершённую фазу, карточка не «висит»', () => {
  const hc = readSource('src/main/ipc/historyCache.ts')
  assert.match(hc, /blockRunningOrchestrationPhase/)
  assert.match(hc, /msg\.orchestration = blockRunningOrchestrationPhase\(/)
  assert.match(hc, /saveMessage\(msg\)/)

  const engine = readSource('src/main/ipc/chatSendEngine.ts')
  // Чекпоинт пишет фазы в recovery-буфер — карточка переживает краш.
  assert.match(engine, /orchestration: slimOrchestrationPhases\(run\.orchestration\)/)
  // Финальное событие несёт снапшот фаз в message — карточка из finished event.
  assert.match(engine, /orchestration: orchestrationPhases,/)
  assert.match(engine, /message: slimMessageForUI\(assistantMsg\)/)
  // slimMessageForUI не выкидывает orchestration (иначе карточка из события пуста).
  const slim = readSource('src/main/ipc/slimMessages.ts')
  assert.doesNotMatch(slim, /orchestration/)
})

test('stop: незакрытая фаза закрывается blocked, прогресс и таймер сохраняются', () => {
  const phases = [
    phase({ phase: 'planning', status: 'done', startedAt: 1, updatedAt: 2 }),
    phase({ phase: 'executing', status: 'running', startedAt: 3, updatedAt: 4 }),
  ]
  const stopped = orch.slimOrchestrationPhases(
    orch.blockRunningOrchestrationPhase(phases, 'stopped by the user', 99),
  )
  assert.equal(stopped.length, 2)
  assert.equal(stopped[1].status, 'blocked')
  assert.match(stopped[1].detail, /stopped/)
  // startedAt сохраняется — карточка показывает время до остановки.
  assert.equal(stopped[1].startedAt, 3)
  assert.equal(stopped[1].updatedAt, 99)
})

// ── Персист выбора по чатам (renderer/utils/orchestration) ────────────────
// Модель и уровень мышления должны переживать перезапуск: раньше выбор жил
// только в useRef и терялся.

test('per-chat выбор: пишется, читается, не затирается пустым', () => {
  const u = loadTsFile(path.join(__dirname, '..', 'src/renderer/src/utils/orchestration.ts'))
  const executor = { providerId: 'p1', modelId: 'm1', reasoningValue: 'high' }
  const reviewer = { providerId: 'p2', modelId: 'm2' }

  // Пустое хранилище / чужой чат — ничего не помним.
  assert.equal(u.readOrchestrationForChat(undefined, 'c1'), null)
  assert.equal(u.readOrchestrationForChat({}, 'c1'), null)

  // Запись + чтение вместе с reasoningValue (effort переживает перезапуск).
  const table = u.writeOrchestrationForChat({}, 'c1', { executor, reviewer })
  assert.deepEqual(u.readOrchestrationForChat(table, 'c1'), { executor, reviewer })

  // Ещё не выбранный исполнитель не затирает сохранённое.
  const empty = u.writeOrchestrationForChat(table, 'c1', { executor: { providerId: '', modelId: '' } })
  assert.deepEqual(u.readOrchestrationForChat(empty, 'c1'), { executor, reviewer })

  // Закрытие блока (null) тоже не затирает.
  const closed = u.writeOrchestrationForChat(table, 'c1', null)
  assert.deepEqual(u.readOrchestrationForChat(closed, 'c1'), { executor, reviewer })

  // Иммутабельность: исходный объект не мутирован.
  assert.equal(Object.keys(table).length, 1)
})

test('per-chat выбор: LRU-кап не даёт стору расти бесконечно', () => {
  const u = loadTsFile(path.join(__dirname, '..', 'src/renderer/src/utils/orchestration.ts'))
  const executor = { providerId: 'p1', modelId: 'm1' }
  let acc = {}
  for (let i = 0; i < 45; i++) acc = u.writeOrchestrationForChat(acc, `chat-${i}`, { executor })
  assert.ok(Object.keys(acc).length <= 40, `ожидали <= 40, получили ${Object.keys(acc).length}`)
  // Последний записанный чат точно на месте.
  assert.ok(u.readOrchestrationForChat(acc, 'chat-44'))
})

// ── Resume: «Продолжить» прерванный ран ──────────────────────────────────

test('freeze: resume нормализуется и попадает в снапшот рана', () => {
  const selection = {
    executor: { providerId: 'p1', modelId: 'exec' },
    reviewer: { providerId: 'p2', modelId: 'rev' },
  }
  const planner = { providerId: 'p3', modelId: 'plan' }

  const run = orch.freezeOrchestrationRun(selection, planner, {
    plan: '1. add endpoint',
    done: ['src/api.ts (+10 −2)'],
  })
  assert.equal(run.resume.plan, '1. add endpoint')
  assert.deepEqual(run.resume.done, ['src/api.ts (+10 −2)'])

  // Без resume — обычный ран (поле не появляется).
  assert.equal(orch.freezeOrchestrationRun(selection, planner).resume, undefined)

  // Мусор не ломает запуск: пустой resume просто отбрасывается.
  assert.equal(orch.freezeOrchestrationRun(selection, planner, { plan: '   ' }).resume, undefined)
})

test('slim: план сохраняется в снапшоте сообщения (кнопке «Продолжить» он нужен)', () => {
  const phases = [
    {
      phase: 'planning',
      model: { providerId: 'p', modelId: 'm' },
      startedAt: 1,
      updatedAt: 2,
      status: 'done',
      plan: '1. step one\n2. step two',
    },
    {
      phase: 'executing',
      model: { providerId: 'p', modelId: 'e' },
      startedAt: 3,
      updatedAt: 4,
      status: 'blocked',
    },
  ]
  const slim = orch.slimOrchestrationPhases(phases)
  const planning = slim.find(p => p.phase === 'planning')
  assert.equal(planning.plan, '1. step one\n2. step two')
  // У executing плана нет — он относится только к планированию.
  assert.equal(slim.find(p => p.phase === 'executing').plan, undefined)
})
