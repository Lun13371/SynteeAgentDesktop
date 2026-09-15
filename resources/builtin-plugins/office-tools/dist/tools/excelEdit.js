// excelEdit — тул excel_edit: гранулярные правки существующих .xlsx
const state = require('../state')
const recent = require('../lib/recent')

async function editExcel({ path: p, ops }) {
  if (!p) throw new Error('path обязателен')
  if (!Array.isArray(ops) || !ops.length) throw new Error('ops (массив операций) обязателен')
  const api = state.api
  const st = await api.fs.stat(p)
  if (!st.exists) throw new Error('Файл не найден: ' + p)

  const editor = require('../lib/excel/edit')
  const res = await editor.applyOps(p, ops)

  const st2 = await api.fs.stat(p)
  await recent.add({
    path: p,
    kind: 'excel',
    op: 'edit',
    name: p.split(/[\\/]/).pop(),
    size: st2.size,
    stats: res.stats,
    preview: res.preview || null,
  })
  return JSON.stringify(res, null, 1)
}

function registerExcelEditTools(syntee) {
  syntee.registerTool({
    name: 'excel_edit',
    description:
      'Apply granular edit operations to an existing .xlsx. Ops: set_cells (values/formulas/styles by ref), insert_rows/delete_rows, insert_columns/delete_columns, add_sheet/delete_sheet/rename_sheet, set_column_width, merge, freeze, auto_filter, protect, sort. Call excel_read mode "meta" first to inspect the workbook.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .xlsx' },
        ops: { type: 'array', description: 'Array of edit operations, applied in order', items: { type: 'object' } },
      },
      required: ['path', 'ops'],
    },
    handler: editExcel,
    requiresApproval: true, // мутирует файл пользователя
  })
}

module.exports = { registerExcelEditTools, editExcel }
