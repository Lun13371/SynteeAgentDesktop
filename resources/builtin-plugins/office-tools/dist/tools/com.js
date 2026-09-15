// com — тулы office_open / word_export_pdf (COM-автоматизация MS Office)
const state = require('../state')
const recent = require('../lib/recent')

function extOf(p) {
  return (p.split('.').pop() || '').toLowerCase()
}

async function officeOpen({ path: p, app }) {
  if (!p) throw new Error('path обязателен')
  const api = state.api
  const st = await api.fs.stat(p)
  if (!st.exists) throw new Error('Файл не найден: ' + p)

  const ext = extOf(p)
  if (ext === 'docx' || ext === 'doc' || app === 'word') {
    const com = require('../lib/com/word')
    await com.openDoc(p)
    return 'Открыто в Word: ' + p
  }
  if (ext === 'xlsx' || ext === 'xls' || app === 'excel') {
    const com = require('../lib/com/excel')
    await com.openBook(p)
    return 'Открыто в Excel: ' + p
  }
  const shell = require('../lib/com/shell')
  await shell.openWithDefault(p)
  return 'Открыто: ' + p
}

async function wordExportPdf({ path: p, out }) {
  if (!p) throw new Error('path обязателен')
  const api = state.api
  const st = await api.fs.stat(p)
  if (!st.exists) throw new Error('Файл не найден: ' + p)
  if (extOf(p) !== 'docx' && extOf(p) !== 'doc') throw new Error('Ожидался .docx/.doc, получено .' + extOf(p))

  const com = require('../lib/com/word')
  const target = out || p.replace(/\.(docx|doc)$/i, '.pdf')
  await com.exportPdf(p, target)

  const st2 = await api.fs.stat(target)
  await recent.add({
    path: target,
    kind: 'pdf',
    op: 'export',
    name: target.split(/[\\/]/).pop(),
    size: st2.size,
  })
  return 'PDF создан: ' + target
}

function registerComTools(syntee) {
  syntee.registerTool({
    name: 'office_open',
    description:
      'Open a document in the real MS Office application (Word via COM for .docx/.doc, default app otherwise). The Office window becomes visible on screen.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
        app: { type: 'string', enum: ['word', 'excel'], description: 'Force app (optional, auto-detected by extension)' },
      },
      required: ['path'],
    },
    handler: officeOpen,
    requiresApproval: true, // запускает внешнее приложение
  })

  syntee.registerTool({
    name: 'word_export_pdf',
    description:
      'Export a .docx document to PDF using installed MS Word (COM ExportAsFixedFormat). Requires Word installed. Returns the PDF path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .docx' },
        out: { type: 'string', description: 'Output .pdf path (default: same name .pdf)' },
      },
      required: ['path'],
    },
    handler: wordExportPdf,
    requiresApproval: true,
  })

  syntee.registerTool({
    name: 'excel_chart',
    description:
      'Add an embedded chart to an existing .xlsx sheet via real MS Excel COM (exceljs cannot create charts). Types: bar, column, line, pie, doughnut, area, scatter, radar. The chart is anchored to a cell and the workbook is saved. Requires Excel installed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .xlsx' },
        sheet: { type: 'string', description: 'Sheet name' },
        type: { type: 'string', enum: ['bar', 'column', 'line', 'pie', 'doughnut', 'area', 'scatter', 'radar'] },
        dataRange: { type: 'string', description: 'Data range on the sheet, e.g. "A1:B10" (include headers row for legend)' },
        title: { type: 'string', description: 'Chart title (optional)' },
        anchor: { type: 'string', description: 'Top-left anchor cell, e.g. "D2" (default D2)' },
        width: { type: 'number', description: 'Chart width px (default 480)' },
        height: { type: 'number', description: 'Chart height px (default 300)' },
      },
      required: ['path', 'sheet', 'type', 'dataRange'],
    },
    handler: async ({ path: p, ...rest }) => {
      if (!p) throw new Error('path обязателен')
      const api = state.api
      const st = await api.fs.stat(p)
      if (!st.exists) throw new Error('Файл не найден: ' + p)
      // Превалидация ДО COM: понятные ошибки вместо криптичного PS-вывода.
      if (!rest.sheet) throw new Error('sheet обязателен (имя листа). Узнать листы: excel_read mode "meta"')
      if (!rest.dataRange) throw new Error('dataRange обязателен, например "A1:B10" (включите строку заголовков для легенды)')
      if (!/^[A-Za-z]+[0-9]+:[A-Za-z]+[0-9]+$/.test(String(rest.dataRange).replace(/\$/g, '').replace(/'/g, ''))) {
        throw new Error('dataRange должен быть диапазоном вида "A1:B10", получено: ' + rest.dataRange)
      }
      const reader = require('../lib/excel/read')
      const meta = await reader.readWorkbook(p, { mode: 'meta' })
      const found = (meta.sheets || []).find((s) => s.name === rest.sheet)
      if (!found) {
        const names = (meta.sheets || []).map((s) => '"' + s.name + '" (' + s.rowCount + 'x' + s.columnCount + ')').join(', ')
        throw new Error('Лист не найден: ' + rest.sheet + '. Листы в файле: ' + names)
      }
      const com = require('../lib/com/excel')
      await com.addChart({ path: p, ...rest })
      return 'Диаграмма добавлена: ' + p + ' (лист ' + rest.sheet + ', ' + rest.type + ' ' + rest.dataRange + ')'
    },
    requiresApproval: true, // запускает реальный Excel и мутирует файл
  })
}

module.exports = { registerComTools, officeOpen, wordExportPdf }
