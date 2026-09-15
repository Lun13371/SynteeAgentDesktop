// word.edit.test.js — применение ops (append_blocks, replace_text,
// insert_table, set_style, delete_block) к .docx и проверка чтением.
// Запуск: node test/word.edit.test.js (cwd = папка плагина)

const fs = require('fs')
const path = require('path')
const { buildDocument } = require('../dist/lib/word/spec')
const { readDocument } = require('../dist/lib/word/read')
const { applyOps } = require('../dist/lib/word/edit')
const { buildTestSpec, TMP_DIR, PNG_1X1 } = require('./word.test')

const EDIT_DOCX = path.join(TMP_DIR, 'word-edit.docx')

let failures = 0
function check(name, cond, extra) {
  if (cond) {
    console.log('  ok  ' + name)
  } else {
    failures++
    console.error('  FAIL ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''))
  }
}

async function main() {
  fs.mkdirSync(TMP_DIR, { recursive: true })

  console.log('[1] создание исходного документа')
  const built = await buildDocument(buildTestSpec(), {})
  fs.writeFileSync(EDIT_DOCX, built.buffer)
  const before = await readDocument(EDIT_DOCX, 'structure')
  check('исходник: 1 таблица', before.stats.tables === 1, before.stats)
  const beforeBlocks = before.blocks.length

  console.log('[2] applyOps: append_blocks + replace_text + insert_table + set_style + delete_block')
  const res = await applyOps(EDIT_DOCX, [
    {
      op: 'append_blocks',
      blocks: [
        { type: 'heading', level: 2, text: 'Приложение после правки' },
        { type: 'paragraph', text: 'Дописанный абзац через word_edit.' },
      ],
    },
    { op: 'replace_text', find: 'Конец документа', replace: 'Финал документа' },
    {
      op: 'insert_table',
      after: 1,
      table: {
        header: true,
        style: 'table-grid',
        rows: [
          [{ text: 'Новая' }, { text: 'таблица' }],
          [{ text: 'x', fill: 'FFF2CC' }, { text: 'y' }],
        ],
      },
    },
    { op: 'set_style', index: 1, style: { bold: true, color: 'C00000' } },
    { op: 'delete_block', index: 3 },
  ])

  check('applied: 5 строк', Array.isArray(res.applied) && res.applied.length === 5, res.applied)
  check('applied[0] append_blocks', /append_blocks: \+2/.test(res.applied[0]), res.applied[0])
  check('applied[1] replace_text: 1 замена', /replace_text .*: 1 замен/.test(res.applied[1]), res.applied[1])
  check('applied[2] insert_table', /insert_table/.test(res.applied[2]), res.applied[2])
  check('res.stats.tables = 2', res.stats.tables === 2, res.stats)
  check('res.outline содержит новый заголовок',
    res.outline.some((h) => h.text === 'Приложение после правки'), res.outline)

  console.log('[3] проверка результата чтением')
  const text = await readDocument(EDIT_DOCX, 'text')
  check('текст: замена применена', text.includes('Финал документа'), text.slice(-200))
  check('текст: старой фразы нет', !text.includes('Конец документа'))
  check('текст: дописанный абзац есть', text.includes('Дописанный абзац через word_edit.'))
  check('текст: новая таблица читается', text.includes('Новая') && text.includes('таблица'))

  const after = await readDocument(EDIT_DOCX, 'structure')
  check('structure: таблиц стало 2', after.stats.tables === 2, after.stats)
  check('structure: outline вырос',
    after.outline.length > before.outline.length, { before: before.outline.length, after: after.outline.length })
  // +2 append, +1 insert_table, -1 delete_block
  check('structure: блоков = исходник + 2',
    after.blocks.length === beforeBlocks + 2, { before: beforeBlocks, after: after.blocks.length })

  console.log('[4] add_footer с номером страницы + patch_document')
  const res2 = await applyOps(EDIT_DOCX, [
    { op: 'add_footer', blocks: [{ type: 'paragraph', text: 'Отчёт', alignment: 'left' }], pageNumber: { alignment: 'center' } },
    { op: 'patch_document', content: [{ type: 'heading', level: 1, text: 'Полная замена' }, { type: 'paragraph', text: 'Документ перезаписан целиком.' }] },
  ])
  check('applied (2-я партия): 2 строки', res2.applied.length === 2, res2.applied)
  check('res2.stats: 1 параграф + 1 заголовок', res2.stats.paragraphs === 2, res2.stats)
  const text2 = await readDocument(EDIT_DOCX, 'text')
  check('текст после patch_document', text2.includes('Полная замена') && text2.includes('целиком'), text2)

  console.log('[5] ошибки: неверный индекс и неизвестная операция')
  let threw = 0
  try { await applyOps(EDIT_DOCX, [{ op: 'delete_block', index: 99 }]) } catch { threw++ }
  try { await applyOps(EDIT_DOCX, [{ op: 'no_such_op' }]) } catch { threw++ }
  try { await applyOps(EDIT_DOCX, []) } catch { threw++ }
  check('все 3 ошибочных вызова бросили исключения', threw === 3, threw)

  if (failures) {
    console.error('\nFAILED: ' + failures + ' проверок не прошло')
    process.exit(1)
  }
  console.log('\nPASSED: все проверки word.edit.test.js прошли')
}

if (require.main === module) {
  main().catch((e) => {
    console.error('TEST ERROR:', e)
    process.exit(1)
  })
}

module.exports = { PNG_1X1 }
