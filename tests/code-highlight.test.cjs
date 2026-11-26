/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')

// Регрессии подсветки кода. В прод-сборке подсветка молча отключалась
// целиком — цепочка из трёх причин, все три закрыты:
//  1) регистрация языков была побочным эффектом импорта → tree-shaking
//     выпиливал модуль, refractor бросал «Unknown language»;
//  2) refractor импортировался в двух модулях → два разных инстанса
//     (ESM/CJS), регистрация уходила в один, highlight читал другой;
//  3) refractor 5 отдаёт Root-ноду, а не массив → `tree.map is not a
//     function` → catch → escapeHtml (0 span.token).
const highlight = readFileSync('src/renderer/src/utils/codeHighlightHTML.ts', 'utf8')
const languages = readFileSync('src/renderer/src/utils/codeLanguages.ts', 'utf8')
const theme = readFileSync('src/renderer/src/utils/themeBase.ts', 'utf8')

test('регистрация языков — экспортируемая функция (не только side-effect)', () => {
  assert.match(languages, /export function registerLanguages\(\)/)
  assert.match(languages, /if \(registered\) return/)
  for (const lang of ['toml', 'scss', 'powershell', 'graphql', 'docker', 'shell-session']) {
    assert.ok(languages.includes(`'refractor/${lang}'`), `missing grammar ${lang}`)
  }
})

test('единый инстанс refractor: codeLanguages экспортирует его, highlight импортирует', () => {
  assert.match(languages, /export \{ refractor \}/)
  assert.match(highlight, /import \{ refractor, isLanguageRegistered \} from '\.\/codeLanguages'/)
  // Прямой импорт 'refractor/core' в highlight создаёт второй инстанс.
  assert.ok(!highlight.includes("from 'refractor/core'"))
})

test('Root-нода refractor 5 поддерживается (tree.map больше не вызывается)', () => {
  assert.ok(highlight.includes('function hastNodes('))
  assert.ok(highlight.includes('function renderTree('))
  // Проверяем КОД, а не комментарий: вырезаем строчные комментарии.
  const code = highlight.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.ok(!/tree\.map\(/.test(code), 'tree.map() на Root-ноде бросает')
})

test('незарегистрированный язык не бросает, а рендерится как plain-text', () => {
  assert.ok(highlight.includes('isLanguageRegistered(lang)'))
})

test('светлая палитра выбирается только когда кастомная тема реально активна', () => {
  // activeCustomThemeId остаётся от прошлой кастомной темы даже на встроенной
  // тёмной (mocha/onedark/…) — без проверки theme === 'custom' подсветка
  // брала oneLight и код становился почти чёрным на тёмном фоне.
  assert.ok(theme.includes("if (state.theme === 'custom')"))
})

test('read_file: конверт разбирается, CRLF и префиксы N| снимаются', () => {
  const renderer = readFileSync('src/renderer/src/components/ui/ToolChain/ToolResultRenderer.tsx', 'utf8')
  assert.ok(renderer.includes('export function parseReadBlocks('))
  // \r в конце строки ломал /^(\d+)\|(.*)$/ → префикс оставался в теле
  // (двойной ряд номеров) и давал пустую строку внизу карточки.
  assert.ok(renderer.includes('function stripCr('))
  assert.ok(renderer.includes('NUMBERED_LINE_RE = /^(\\d+)\\|([\\s\\S]*)$/'))
  // Строки до первого заголовка — не код (сжатый джанитором результат).
  assert.ok(renderer.includes('if (!sawHeader) continue'))
  // Нумерация — реальные номера строк файла.
  assert.ok(renderer.includes('lineNumberStart={block.from}'))
})

test('код-карточка: колонка кода без собственного overflow', () => {
  // overflow-x:auto + overflow-y:visible → computed overflow-y:auto, и код
  // скроллился отдельно от номеров строк («листаю код — строки стоят»).
  const codeColBlock = highlight.slice(highlight.indexOf('const codeColStyle'))
  assert.ok(!codeColBlock.slice(0, 300).includes("overflowX: 'auto'"))
})
