// spec — сборка .xlsx из JSON-спеки (exceljs). Контракт: dist/lib/excel/specDoc.js
const ExcelJS = require('exceljs')
const { mapCellStyle } = require('./styles')
const { parseRef, specValueToCell } = require('./cells')

const SHEET_NAME_RE = /[\[\]:*?/\\]/

/** Применить стиль ячейки из спеки (numFmt + style) */
function applyCellSpec(cell, cellSpec) {
  if (cellSpec.numFmt) cell.numFmt = String(cellSpec.numFmt)
  const st = mapCellStyle(cellSpec.style)
  if (st) cell.style = Object.assign({}, cell.style, st)
}

/** Нормализовать строку спеки → { cells: [...], height, style } */
function normalizeRow(row) {
  if (row === null || row === undefined) return { cells: [], height: null, style: null }
  if (Array.isArray(row)) return { cells: row, height: null, style: null }
  if (typeof row === 'object') {
    return {
      cells: Array.isArray(row.cells) ? row.cells : [],
      height: row.height != null ? Number(row.height) : null,
      style: row.style || null,
    }
  }
  return { cells: [row], height: null, style: null }
}

/** Нормализовать cell → объектная форма */
function normalizeCell(cell) {
  if (cell === null || cell === undefined) return null
  if (typeof cell !== 'object' || Array.isArray(cell)) {
    return { value: cell }
  }
  return cell
}

/** Собрать workbook из спеки. → { buffer, stats, preview } */
async function buildWorkbook(spec) {
  if (!spec || !Array.isArray(spec.sheets) || !spec.sheets.length) {
    throw new Error('spec.sheets (массив листов) обязателен')
  }
  const wb = new ExcelJS.Workbook()
  const stats = { sheets: 0, rows: 0, cells: 0, formulas: 0, merged: 0 }
  let firstSheetName = null
  let firstSheetRows = null // массив значений для превью

  for (const sheetSpec of spec.sheets) {
    if (!sheetSpec || typeof sheetSpec !== 'object') throw new Error('Лист должен быть объектом')
    const name = String(sheetSpec.name || 'Sheet' + (stats.sheets + 1))
    if (name.length > 31 || SHEET_NAME_RE.test(name)) {
      throw new Error('Недопустимое имя листа: ' + name + ' (≤31 символ, без []:*?/\\)')
    }
    const ws = wb.addWorksheet(name)

    // Ширины колонок
    if (Array.isArray(sheetSpec.columns)) {
      sheetSpec.columns.forEach((c, i) => {
        const w = typeof c === 'object' && c ? c.width : c
        if (w != null) ws.getColumn(i + 1).width = Number(w)
      })
    }

    // Строки и ячейки
    const rowsSpec = Array.isArray(sheetSpec.rows) ? sheetSpec.rows : []
    for (let r = 0; r < rowsSpec.length; r++) {
      const rowSpec = normalizeRow(rowsSpec[r])
      stats.rows++
      const xlsxRow = ws.getRow(r + 1)
      if (rowSpec.height != null) xlsxRow.height = rowSpec.height
      const rowStyle = mapCellStyle(rowSpec.style)
      for (let c = 0; c < rowSpec.cells.length; c++) {
        const cellSpec = normalizeCell(rowSpec.cells[c])
        if (!cellSpec) continue
        const cell = xlsxRow.getCell(c + 1)
        cell.value = specValueToCell(cellSpec)
        if (cellSpec.formula) stats.formulas++
        stats.cells++
        if (rowStyle) cell.style = Object.assign({}, cell.style, rowStyle)
        applyCellSpec(cell, cellSpec)
        if (cellSpec.hyperlink && typeof cellSpec.hyperlink === 'string') {
          cell.value = { text: String(cellSpec.value != null ? cellSpec.value : cellSpec.hyperlink), hyperlink: cellSpec.hyperlink }
        }
      }
    }

    // Merged
    if (Array.isArray(sheetSpec.merged)) {
      for (const range of sheetSpec.merged) {
        ws.mergeCells(String(range))
        stats.merged++
      }
    }

    // Freeze
    if (sheetSpec.freeze) {
      const { col, row } = parseRef(sheetSpec.freeze)
      ws.views = [{ state: 'frozen', xSplit: col - 1, ySplit: row - 1 }]
    }

    // AutoFilter
    if (sheetSpec.autoFilter) ws.autoFilter = String(sheetSpec.autoFilter)

    // Data validation
    if (Array.isArray(sheetSpec.dataValidation)) {
      for (const dv of sheetSpec.dataValidation) {
        if (!dv || !dv.range) continue
        const rule = {
          type: dv.type || 'list',
          allowBlank: dv.allowBlank !== false,
          showErrorMessage: dv.showErrorMessage !== false,
        }
        if (dv.operator) rule.operator = dv.operator
        if (Array.isArray(dv.formulae)) rule.formulae = dv.formulae.map(String)
        if (dv.promptTitle) rule.promptTitle = dv.promptTitle
        if (dv.prompt) rule.prompt = dv.prompt
        if (dv.errorTitle) rule.errorTitle = dv.errorTitle
        if (dv.error) rule.error = dv.error
        ws.getCell(dv.range).dataValidation = rule
      }
    }

    // Conditional formatting
    if (Array.isArray(sheetSpec.conditionalFormatting)) {
      for (const cf of sheetSpec.conditionalFormatting) {
        if (!cf || !cf.range || !Array.isArray(cf.rules)) continue
        const rules = cf.rules.map((r) => {
          const rule = { type: r.type || 'cellIs' }
          if (r.priority != null) rule.priority = Number(r.priority)
          if (r.operator) rule.operator = r.operator
          if (Array.isArray(r.formulae)) rule.formulae = r.formulae.map(String)
          if (r.style) {
            const st = {}
            if (r.style.fill) st.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + String(r.style.fill).replace('#', '').toUpperCase() } }
            if (r.style.color) st.font = { color: { argb: 'FF' + String(r.style.color).replace('#', '').toUpperCase() } }
            if (Object.keys(st).length) rule.style = st
          }
          return rule
        })
        ws.addConditionalFormatting({ ref: String(cf.range), rules })
      }
    }

    // Защита листа — ПОСЛЕ заполнения
    if (sheetSpec.protection && typeof sheetSpec.protection === 'object') {
      const pr = sheetSpec.protection
      const opts = {}
      for (const k of ['selectLockedCells', 'selectUnlockedCells', 'formatCells', 'formatColumns', 'formatRows', 'insertRows', 'insertColumns', 'insertHyperlinks', 'deleteRows', 'deleteColumns', 'sort', 'autoFilter', 'pivotTables', 'objects', 'scenarios']) {
        if (pr[k] != null) opts[k] = !!pr[k]
      }
      ws.protect(pr.password || undefined, Object.keys(opts).length ? opts : undefined)
    }

    stats.sheets++

    // Превью первого листа
    if (firstSheetRows === null) {
      firstSheetName = name
      firstSheetRows = []
      for (let r = 0; r < Math.min(rowsSpec.length, 10); r++) {
        const rowSpec = normalizeRow(rowsSpec[r])
        const vals = []
        for (let c = 0; c < rowSpec.cells.length; c++) {
          const cs = normalizeCell(rowSpec.cells[c])
          if (!cs) { vals.push(null); continue }
          if (cs.formula) vals.push(cs.value != null ? cs.value : null)
          else vals.push(cs.value === undefined ? null : cs.value)
        }
        firstSheetRows.push(vals)
      }
    }
  }

  // Named ranges
  if (Array.isArray(spec.definedNames)) {
    for (const dn of spec.definedNames) {
      if (!dn || !dn.name || !dn.range) continue
      wb.definedNames.add(String(dn.range), String(dn.name))
    }
  }

  const buffer = await wb.xlsx.writeBuffer()

  // totalRows/totalCols первого листа
  let totalRows = 0
  let totalCols = 0
  const rowsSpec0 = Array.isArray(spec.sheets[0].rows) ? spec.sheets[0].rows : []
  totalRows = rowsSpec0.length
  for (const row of rowsSpec0) {
    const rs = normalizeRow(row)
    if (rs.cells.length > totalCols) totalCols = rs.cells.length
  }

  return {
    buffer: Buffer.from(buffer),
    stats,
    preview: { name: firstSheetName, rows: firstSheetRows, totalRows, totalCols },
  }
}

module.exports = { buildWorkbook }
