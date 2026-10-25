// Регрессия: ask_user из другого чата/суб-агента не должен ПЕРЕКРЫВАТЬ
// активный вопрос QuestionPanel. Панель глобальная (один экземпляр в App) и
// раньше имела один слот: второй вопрос затирал первый, его черновики
// сбрасывались, а questionResponse для первого reqId никогда не уходил →
// агент навсегда висел в ожидании ответа.
//
// Тест проверяет чистую логику очереди (enqueueQuestion/dequeueQuestion),
// которую использует компонент, + контракт «ответ уходит в свой reqId».
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const ts = require('typescript')

const file = path.join(__dirname, '../src/renderer/src/components/ui/QuestionPanel/QuestionPanel.tsx')
const source = fs.readFileSync(file, 'utf8')
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText

const mod = { exports: {} }
new Function('require', 'module', 'exports', output)(
  id => {
    if (id === 'react') return require('react')
    if (id === 'framer-motion') {
      return {
        AnimatePresence: ({ children }) => children,
        motion: { div: 'div', button: 'button', span: 'span' },
      }
    }
    if (id.endsWith('.css')) return {}
    if (id.includes('AppIcon/AppIcon')) return { default: () => null }
    if (id.includes('utils/sounds')) return { playConfirmSound: () => {} }
    if (id.includes('store/chat.store')) return { useChatStore: () => undefined }
    return require(id)
  },
  mod,
  mod.exports,
)

const { enqueueQuestion, dequeueQuestion } = mod.exports
assert.equal(typeof enqueueQuestion, 'function', 'enqueueQuestion должен экспортироваться')
assert.equal(typeof dequeueQuestion, 'function', 'dequeueQuestion должен экспортироваться')

const q = (reqId, chatId) => ({
  reqId,
  chatId,
  msgId: `msg-${reqId}`,
  questions: [{ id: `q_${reqId}`, question: `вопрос из ${chatId}` }],
})

// 1. Второй вопрос НЕ перекрывает первый — встаёт в конец очереди.
let queue = []
queue = enqueueQuestion(queue, q('req-A', 'chat-A'))
queue = enqueueQuestion(queue, q('req-B', 'chat-B'))
assert.deepEqual(queue.map(x => x.reqId), ['req-A', 'req-B'])
assert.equal(queue[0].reqId, 'req-A', 'активным остаётся первый (FIFO)')

// 2. Третий из суб-агента того же чата — тоже в очередь, а не поверх.
queue = enqueueQuestion(queue, q('req-C', 'chat-A'))
assert.deepEqual(queue.map(x => x.reqId), ['req-A', 'req-B', 'req-C'])

// 3. Повторная доставка того же reqId не дублирует запрос и не меняет порядок.
const same = enqueueQuestion(queue, q('req-B', 'chat-B'))
assert.equal(same, queue, 'дубликат возвращает тот же массив')
assert.deepEqual(same.map(x => x.reqId), ['req-A', 'req-B', 'req-C'])

// 4. Ответ на голову: она уходит, следующая становится активной.
queue = dequeueQuestion(queue, 'req-A')
assert.equal(queue[0].reqId, 'req-B', 'после ответа активен следующий вопрос')
assert.deepEqual(queue.map(x => x.reqId), ['req-B', 'req-C'])

// 5. Dismiss (Стоп/ответ через overlay) снимает запрос с любой позиции,
//    не ломая порядок остальных.
queue = dequeueQuestion(queue, 'req-C')
assert.deepEqual(queue.map(x => x.reqId), ['req-B'])
queue = dequeueQuestion(queue, 'req-unknown')
assert.deepEqual(queue.map(x => x.reqId), ['req-B'], 'неизвестный reqId — no-op')

// 6. Контракт исходника: панель обязана ответить ИМЕННО на reqId запроса,
//    и не должна возвращаться к одному слоту.
assert.match(source, /finishCurrent\(pending\.reqId/)
assert.match(source, /window\.syntee\.agent\.questionResponse\(reqId, answers\)/)
assert.match(source, /draftsByReq/, 'черновики хранятся per-reqId')
assert.match(source, /в очереди/, 'UI сообщает про очередь')
assert.doesNotMatch(source, /setPending\(/, 'один слот (setPending) не должен вернуться')

// 7. Main снимает висящие вопросы при Стопе — иначе панель висит с мёртвым
//    вопросом, а ответ уходит в убитый воркер.
const chatIpc = fs.readFileSync(path.join(__dirname, '../src/main/ipc/chat.ipc.ts'), 'utf8')
assert.match(chatIpc, /function dismissPendingQuestions/)
assert.match(chatIpc, /dismissPendingQuestions\(win, run\)/)
assert.match(chatIpc, /agent:question:dismiss/)

console.log('QuestionPanel queue regressions passed')
