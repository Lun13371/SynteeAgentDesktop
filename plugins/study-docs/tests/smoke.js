// tests/smoke.js — смоук-тест тулов Study Docs без хоста.
// Запуск: node tests/smoke.js [--pdf]
const fs = require('fs')
const path = require('path')
const os = require('os')
const { exec } = require('child_process')

const root = path.join(__dirname, '..')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-docs-smoke-'))
const tools = []
const registered = { commands: [], panels: [], search: [], autocomplete: [], inputActions: [] }
const handled = {}

const fake = {
  pluginDir: root,
  registerTool: (t) => tools.push(t),
  registerCommand: (c) => registered.commands.push(c),
  registerPanel: (p) => registered.panels.push(p),
  registerSearchProvider: (s) => registered.search.push(s),
  registerAutocomplete: (a) => registered.autocomplete.push(a),
  registerInputAction: (a) => registered.inputActions.push(a),
  on: (ev, fn) => {
    handled[ev] = handled[ev] || []
    handled[ev].push(fn)
  },
  log: () => {},
  sound: { play: async () => {} },
  notifications: { show: async () => {} },
  storage: {
    _d: {},
    get: async (k) => fake.storage._d[k],
    set: async (k, v) => {
      fake.storage._d[k] = v
    },
  },
  config: { get: async (k) => ({ defaultSaveDir: outDir, defaultFormat: 'gost' })[k] },
  ui: {
    handle: () => {},
    emit: () => {},
    setBadge: () => {},
    openModal: () => {},
  },
  window: { toast: () => {} },
  chat: { send: async (m) => console.log('  [chat.send]', String(m).slice(0, 70) + '…') },
  fs: {
    readFile: async (p, o) => fs.readFileSync(p).toString(o && o.encoding === 'base64' ? 'base64' : 'utf8'),
    writeFile: async (p, data, o) => {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, Buffer.from(data, o && o.encoding === 'base64' ? 'base64' : 'utf8'))
    },
    stat: async (p) => {
      try {
        const s = fs.statSync(p)
        return { exists: true, isFile: s.isFile(), size: s.size }
      } catch (e) {
        return { exists: false }
      }
    },
    copy: async (a, b) => fs.copyFileSync(a, b),
    pickFile: async () => null,
  },
  process: {
    exec: (cmd, o) =>
      new Promise((res) => {
        exec(cmd, { timeout: (o && o.timeoutMs) || 60000 }, (err, stdout, stderr) =>
          res({ stdout: String(stdout || ''), stderr: String(stderr || ''), code: err ? err.code || 1 : 0 })
        )
      }),
  },
}

const state = require(path.join(root, 'dist/state.js'))
state.init(fake)
require(path.join(root, 'dist/tools.js'))(fake)
require(path.join(root, 'dist/commands.js'))(fake)
require(path.join(root, 'dist/ui.js'))(fake)

const byName = (n) => tools.find((t) => t.name === n)
let failed = 0
function check(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name)
  else {
    failed++
    console.log('  ✗ ' + name + (extra ? ' — ' + extra : ''))
  }
}

// Бейдж-виджет: JSON с __plugin_ui__ + kind badge + result для модели
function parseBadge(r) {
  try {
    const j = JSON.parse(r)
    if (j && j.__plugin_ui__ && j.kind === 'badge') return j
  } catch (e) {
    /* не JSON */
  }
  return null
}

// 1x1 PNG для теста image-секции
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

;(async () => {
  console.log('Зарегистрировано тулов: ' + tools.map((t) => t.name).join(', '))
  check('10 тулов', tools.length === 10, String(tools.length))
  check('5 команд', registered.commands.length === 5, String(registered.commands.length))
  check('панель main', registered.panels.some((p) => p.id === 'main'))
  check('search provider', registered.search.some((s) => s.id === 'study-files'))
  check('autocomplete @doc', registered.autocomplete.some((a) => a.trigger === '@doc'))
  check('input action', registered.inputActions.some((a) => a.id === 'study-docs'))

  // --- docx_create: все типы секций + rich text + картинка
  const imgPath = path.join(outDir, 'pic.png')
  fs.writeFileSync(imgPath, Buffer.from(PNG_1PX, 'base64'))
  const r1 = await byName('docx_create').handler({
    path: 'kursovaya.docx',
    title: 'Тестовая курсовая',
    headerText: 'Тестовая курсовая',
    format: 'gost',
    sections: [
      { type: 'titlePage', university: 'МГУ', workType: 'курсовая работа', topic: 'Нейронные сети', student: 'Иванов И.И.', group: '301' },
      { type: 'toc' },
      { type: 'heading', level: 1, text: 'ВВЕДЕНИЕ' },
      { type: 'paragraph', text: 'Актуальность **очень высокая** и *несомненная*, см. `код`.' },
      { type: 'paragraph', text: 'f″(−1) = −6 < 0 — точка максимума; f″(1) = 6 > 0 — точка минимума.' },
      { type: 'code', text: 'def train():\n    model.fit(x, y)\n    return model' },
      { type: 'quote', text: 'Наука — это то, что понимают.' },
      { type: 'formula', text: 'S = ∫₀³ x² dx', number: '(1)' },
      { type: 'image', path: imgPath, caption: 'Тестовый рисунок' },
      { type: 'list', ordered: true, items: ['Первый пункт', { text: 'Вложенный', level: 1 }, 'Второй пункт'] },
      { type: 'table', header: ['Модель', 'Год'], rows: [['Perceptron', '1958']], caption: 'Таблица 1' },
      { type: 'references', items: ['Иванов И.И. Нейронные сети. — М.: Наука, 2020.'] },
    ],
  })
  const b1 = parseBadge(r1)
  check('docx_create вернул бейдж', !!b1, String(r1).slice(0, 100))
  const docxPath = path.join(outDir, 'kursovaya.docx')
  const buf = fs.readFileSync(docxPath)
  check('docx создан в defaultSaveDir (PK-магия)', buf.slice(0, 2).toString() === 'PK' && buf.length > 3000)
  check('картинка упакована в docx (word/media/)', buf.toString('latin1').includes('word/media/'))

  // --- docx_read: статистика, outline, round-trip форматирования
  const r2 = await byName('docx_read').handler({ path: docxPath })
  check('docx_read: статистика (слов/стр.)', r2.includes('слов') && r2.includes('стр.'))
  check('docx_read: заголовки', r2.includes('# ВВЕДЕНИЕ'))
  check('docx_read: таблица', r2.includes('Perceptron'))
  check('docx_read: регрессия < 0 / > 0', r2.includes('−6 < 0') && r2.includes('6 > 0'))
  check('docx_read: **жирный** round-trip', r2.includes('**очень высокая**'))
  check('docx_read: *курсив* round-trip', r2.includes('*несомненная*'))
  check('docx_read: код-блок', r2.includes('model.fit'))
  const r2o = await byName('docx_read').handler({ path: docxPath, outline: true })
  check('docx_read outline: только заголовки', r2o.includes('# ВВЕДЕНИЕ') && !r2o.includes('Актуальность'))

  // --- draft-сессия: start → add → add → finish
  const rs = await byName('docx_start').handler({
    path: 'big.docx',
    title: 'Большая работа',
    format: 'gost',
    sections: [
      { type: 'titlePage', workType: 'курсовая работа', topic: 'Длинная тема' },
      { type: 'toc' },
      { type: 'heading', level: 1, text: 'ВВЕДЕНИЕ' },
      { type: 'paragraph', text: 'Вводные слова.' },
    ],
  })
  check('docx_start вернул бейдж', !!parseBadge(rs))
  check('черновик в storage', (await state.getDraft()).sections.length === 4)
  const ra1 = await byName('docx_add').handler({
    sections: [
      { type: 'heading', level: 1, text: 'ГЛАВА 1' },
      { type: 'paragraph', text: 'Текст первой главы.' },
    ],
  })
  check('docx_add: счётчик секций', parseBadge(ra1).result.includes('Всего в черновике: 6'))
  await byName('docx_add').handler({
    sections: [
      { type: 'heading', level: 1, text: 'ГЛАВА 2' },
      { type: 'paragraph', text: 'Текст второй главы.' },
    ],
  })
  const rf = await byName('docx_finish').handler({})
  check('docx_finish вернул бейдж', !!parseBadge(rf) && parseBadge(rf).result.includes('Секций: 8'))
  const bigPath = path.join(outDir, 'big.docx')
  check('big.docx создан', fs.existsSync(bigPath) && fs.readFileSync(bigPath).slice(0, 2).toString() === 'PK')
  const rBig = await byName('docx_read').handler({ path: bigPath })
  check('draft: титульник+главы на месте', rBig.includes('ВВЕДЕНИЕ') && rBig.includes('ГЛАВА 1') && rBig.includes('ГЛАВА 2') && rBig.includes('Длинная тема'))
  check('draft: черновик очищен', (await state.getDraft()) === null)
  let noDraftErr = ''
  try {
    await byName('docx_add').handler({ sections: [] })
  } catch (e) {
    noDraftErr = String(e.message || e)
  }
  check('docx_add без черновика: понятная ошибка', noDraftErr.includes('docx_start'), noDraftErr)

  // --- docx_edit (append) — бейдж + бэкап
  const r3 = await byName('docx_edit').handler({
    path: 'kursovaya.docx',
    mode: 'append',
    sections: [{ type: 'heading', level: 1, text: 'ПРИЛОЖЕНИЕ А' }, { type: 'paragraph', text: 'Дополнительный материал.' }],
  })
  check('docx_edit вернул бейдж', !!parseBadge(r3))
  check('бэкап создан', fs.existsSync(docxPath.replace(/\.docx$/i, '') + '.bak.docx'))
  const r4 = await byName('docx_read').handler({ path: docxPath })
  check('append: старое сохранилось', r4.includes('Актуальность') && r4.includes('Perceptron'))
  check('append: новое добавлено', r4.includes('ПРИЛОЖЕНИЕ А'))

  // --- xlsx_create: стили ячеек, merges, freeze, autoFilter
  const r5 = await byName('xlsx_create').handler({
    path: 'lab.xlsx',
    sheets: [
      {
        name: 'Расчёт',
        freeze: true,
        autoFilter: true,
        merges: ['A1:C1'],
        rows: [
          [
            { value: 'Отчёт по лабораторной', bold: true, align: 'center' },
            '',
            '',
          ],
          ['Параметр', 'Значение', 'Примечание'],
          ['Масса, кг', { value: 2, format: '0.00' }, 'исходные данные'],
          ['Ускорение', 9.81, ''],
          ['Сила, Н', '=B3*B4', 'F = ma'],
          ['Итог', { value: '=SUM(B3:B5)', bold: true, fill: '#FFEFEF' }, ''],
        ],
      },
    ],
  })
  check('xlsx_create вернул бейдж', !!parseBadge(r5))
  const xlsxPath = path.join(outDir, 'lab.xlsx')
  check('xlsx создан в defaultSaveDir', fs.existsSync(xlsxPath) && fs.readFileSync(xlsxPath).slice(0, 2).toString() === 'PK')

  // --- xlsx_edit: дозапись
  const r7 = await byName('xlsx_edit').handler({
    path: 'lab.xlsx',
    sheet: 'Расчёт',
    rows: [['Добавленная строка', 42, { value: 'новое', italic: true }]],
  })
  check('xlsx_edit вернул бейдж', !!parseBadge(r7) && parseBadge(r7).result.includes('строк: 7'))
  const r6 = await byName('xlsx_read').handler({ path: xlsxPath })
  check('xlsx_read: шапка', r6.includes('Параметр'))
  check('xlsx_read: формула', r6.includes('=B3*B4'))
  check('xlsx_read: дозаписанная строка', r6.includes('Добавленная строка'))
  const r8 = await byName('xlsx_edit').handler({
    path: 'lab.xlsx',
    sheet: 'Новый лист',
    rows: [['A', 'B']],
  })
  check('xlsx_edit: создаёт лист', parseBadge(r8).result.includes('Новый лист'))

  // --- custom формат
  const r9 = await byName('docx_create').handler({
    path: path.join(outDir, 'custom.docx'),
    format: 'custom',
    formatOptions: { font: 'Arial', fontSize: 12, lineSpacing: 1.15, margins: { left: 25, right: 10, top: 15, bottom: 15 } },
    sections: [{ type: 'heading', level: 1, text: 'Тест' }, { type: 'paragraph', text: 'Свой формат.' }],
  })
  check('custom docx создан', !!parseBadge(r9) && fs.existsSync(path.join(outDir, 'custom.docx')))

  // --- журнал + search + autocomplete
  const files = await state.getFiles()
  check('журнал файлов пополнился', files.length >= 4, String(files.length))
  const results = await registered.search[0].handler({ query: 'kursov' })
  check('search: находит по имени', Array.isArray(results) && results.some((r) => r.label.includes('kursovaya')))
  const ac = await registered.autocomplete[0].handler({})
  check('autocomplete: пути файлов', Array.isArray(ac) && ac.some((a) => a.insertText.includes('kursovaya.docx')))

  // --- PDF через реальный Word (опционально)
  if (process.argv.includes('--pdf')) {
    console.log('PDF-конвертация через Word COM…')
    try {
      const pdf = await state.toPdf(bigPath)
      const ok = fs.existsSync(pdf) && fs.readFileSync(pdf).slice(0, 5).toString() === '%PDF-'
      check('PDF создан (%PDF-магия)', ok, pdf)
    } catch (e) {
      check('PDF создан', false, e.message)
    }
  }

  state.cleanup()

  console.log('')
  console.log(failed === 0 ? '✅ ВСЕ ТЕСТЫ ПРОЙДЕНЫ' : '❌ ПРОВАЛЕНО: ' + failed)
  console.log('Файлы: ' + outDir)
  process.exit(failed === 0 ? 0 : 1)
})().catch((e) => {
  console.error('💥 Крах теста:', e)
  process.exit(1)
})
