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

const mentions = load('src/shared/mentions.ts')
const { findMentionTokenAtCaret, findMentionTokenNearCaret } = mentions

const EDITOR_SRC = readFileSync('src/renderer/src/components/ui/ChatInput/ChatInputEditor.tsx', 'utf8')
const INPUT_SRC = readFileSync('src/renderer/src/components/ui/ChatInput/ChatInput.tsx', 'utf8')

// ── @mention: окно перед кареткой ≡ полный скан ────────────────────────────
// Вставка сотен КБ в инпут не должна ломать @mention-меню: результат оконного
// поиска обязан совпадать с прежним полным сканом везде, где токен влезает в
// окно; токен длиннее окна — уже не mention-запрос (возвращаем null).

const MENTION_CASES = [
  '',
  'привет',
  '@',
  ' @',
  '@src/',
  '@src/app.tsx дальше',
  'foo@bar',
  'a @b c',
  '@a\n@b',
  '  @',
  'текст @файл.ts и ещё',
  'x'.repeat(600) + ' @file',
  'x'.repeat(600) + 'foo@bar',
  'y '.repeat(300) + '@deep/path/component.tsx',
]

for (const win of [512, 8, 1]) {
  test(`findMentionTokenNearCaret(window=${win}) совпадает с полным сканом`, () => {
    for (const text of MENTION_CASES) {
      for (let pos = 0; pos <= text.length; pos++) {
        const full = findMentionTokenAtCaret(text, pos)
        const near = findMentionTokenNearCaret(text, pos, win)
        if (full && full.start < pos - win) {
          // Токен начинается до окна — оконный поиск его не видит (by design).
          assert.equal(near, null, `ожидали null вне окна: pos=${pos} win=${win}`)
        } else {
          assert.deepEqual(near, full, `расхождение: pos=${pos} win=${win} text=${JSON.stringify(text.slice(0, 40))}`)
        }
      }
    }
  })
}

test('огромный текст без пробелов: mention-скан не уходит за окно и не находит токен', () => {
  const huge = 'A'.repeat(300_000)
  assert.equal(findMentionTokenNearCaret(huge, huge.length, 512), null)
  // А настоящий @токен в конце — находится с АБСОЛЮТНЫМИ индексами.
  const withToken = huge + ' @src/index.ts'
  const token = findMentionTokenNearCaret(withToken, withToken.length, 512)
  assert.ok(token)
  assert.equal(withToken.slice(token.start, token.end), '@src/index.ts')
  assert.equal(token.query, 'src/index.ts')
})

test('@ сразу после границы окна не считается mention (как в полном скане)', () => {
  const text = 'foo@' + 'x'.repeat(500)
  const caret = text.length
  assert.equal(findMentionTokenAtCaret(text, caret), null)
  assert.equal(findMentionTokenNearCaret(text, caret, 512), null)
})

// ── Вставка: нативная для мелких, прямая для крупных ───────────────────────
// execCommand('insertText') на больших вставках подвешивает окно (Blink гонит
// текст через editing-пайплайн). Для крупных вставляем Text-узел напрямую —
// но тогда нативного input-event нет, и emitChange обязателен, иначе черновик
// не обновится (текст в поле «есть», а value/state пустые). Мелкие вставки
// оставлены нативными — там undo (Ctrl+Z) и каретка работают как раньше.

test('execCommand остаётся только в нативной ветке под порогом', () => {
  assert.match(EDITOR_SRC, /const NATIVE_PASTE_MAX_CHARS = 32_768/)
  const start = EDITOR_SRC.indexOf('function pastePlainText')
  assert.ok(start > 0, 'pastePlainText не найден')
  const body = EDITOR_SRC.slice(start, EDITOR_SRC.indexOf('function insertPlainText'))
  assert.match(body, /if \(text\.length <= NATIVE_PASTE_MAX_CHARS\)/)
  assert.match(body, /document\.execCommand\('insertText', false, text\)/)
  assert.match(body, /insertPlainText\(el, text\)\s*\n\s*return true/)
  // И нигде больше execCommand не зовётся (комментарии не считаем — в JSDoc
  // он упоминается как «то, чем больше не пользуемся»).
  const code = EDITOR_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const calls = code.match(/document\.execCommand\s*\(/g) ?? []
  assert.equal(calls.length, 1, `execCommand вызывается ${calls.length} раз(а), ожидался 1`)
})

test('insertPlainText вставляет Text-узел и ставит каретку в конец', () => {
  assert.match(EDITOR_SRC, /function insertPlainText\(el: HTMLElement, text: string\): void/)
  const body = EDITOR_SRC.slice(EDITOR_SRC.indexOf('function insertPlainText'))
  const slice = body.slice(0, body.indexOf('\n}\n'))
  assert.match(slice, /document\.createTextNode\(text\)/)
  assert.match(slice, /range\.insertNode\(node\)/)
  assert.match(slice, /caret\.setStart\(node, node\.length\)/)
})

test('paste/drop: ручная вставка сопровождается emitChange', () => {
  const paste = EDITOR_SRC.slice(EDITOR_SRC.indexOf('const handlePasteInner'))
  const pasteBody = paste.slice(0, paste.indexOf('const handleDropInner'))
  assert.match(pasteBody, /if \(toInsert && pastePlainText\(el, toInsert\)\) emitChange\(\)/, 'paste-links без emitChange')
  assert.match(pasteBody, /if \(pastePlainText\(el, text\)\) emitChange\(\)/, 'paste без emitChange')

  const drop = EDITOR_SRC.slice(EDITOR_SRC.indexOf('const handleDropInner'))
  const dropBody = drop.slice(0, drop.indexOf('\n  }\n'))
  assert.match(dropBody, /if \(pastePlainText\(el, text\)\) emitChange\(\)/, 'drop без emitChange')
})

// ── Меню и линейные проходы на крупном вводе ───────────────────────────────

test('ChatInput использует оконный mention-детект', () => {
  assert.match(INPUT_SRC, /findMentionTokenNearCaret/)
  assert.ok(!/findMentionTokenAtCaret\(text, caretPos\)/.test(INPUT_SRC), 'вернулся полный скан по всему тексту')
})

test('крупный ввод не гоняет slash/arg/plugin-меню по всей строке', () => {
  assert.match(INPUT_SRC, /text\.length <= SLASH_MAX_CHARS/)
  assert.match(INPUT_SRC, /text\.length > ARG_PICKER_MAX_CHARS/)
  assert.match(INPUT_SRC, /text\.length > PLUGIN_AUTO_MAX_CHARS/)
  assert.ok(!/const firstWord = text\.split\(' '\)\[0\]/.test(INPUT_SRC), 'split(" ") по всей строке вернулся')
})

test('синхронизация вложений: быстрый выход без токенов', () => {
  const src = INPUT_SRC.slice(INPUT_SRC.indexOf('const handleEditorUserInput'))
  const body = src.slice(0, src.indexOf('}, [attachments, onAttachmentsChange])'))
  assert.match(body, /if \(!text\.includes\('\[\[attach:'\)\)/)
})

test('авто-ресайз не меряет scrollHeight на крупном тексте', () => {
  const src = INPUT_SRC.slice(INPUT_SRC.indexOf('// Авто-ресайз contentEditable-редактора'))
  const body = src.slice(0, src.indexOf('}, [value])'))
  assert.match(body, /if \(value\.length > 50_000\)/)
  assert.match(body, /el\.style\.height = '200px'/)
})
