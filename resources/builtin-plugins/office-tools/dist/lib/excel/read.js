// read — чтение .xlsx (exceljs): meta | values | formulas | full
const fs = require('fs')
const ExcelJS = require('exceljs')
const { parseRange, rangeToString, cellToPlainValue, cellToFormula, cellToSpecValue, parseRef } = require('./cells')
const { unmapStyle } = require('./styles')

async function loadWorkbook(path) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(path)
  return wb
}

/** Использованный диапазон листа → { c1, r1, c2, r2 } */
function usedRange(ws) {
  let maxR = 0
  let maxC = 0
  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn > maxR) maxR = rn
    row.eachCell({ includeEmpty: false }, (cell) => {
      const c = cell.col
      if (c > maxC) maxC = c
    })
  })
  if (maxR === 0 || maxC === 0) return { c1: 1, r1: 1, c2: 1, r2: 1, empty: true }
  return { c1: 1, r1: 1, c2: maxC, r2: maxR, empty: false }
}

/** Статы по всему workbook */
function workbookStats(wb) {
  const stats = { sheets: wb.worksheets.length, rows: 0, cells: 0, formulas: 0, merged: 0 }
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      stats.rows++
      row.eachCell({ includeEmpty: false }, (cell) => {
        stats.cells++
        if (cellToFormula(cell)) stats.formulas++
      })
    })
    stats.merged += ws.model && ws.model.merges ? ws.model.merges.length : 0
  }
  return stats
}

function findSheet(wb, sheetName) {
  if (!sheetName) return wb.worksheets[0]
  const ws = wb.getWorksheet(sheetName)
  if (!ws) {
    // Подсказка модели: какие листы ЕСТЬ (баг-репорт «не шарит что есть»).
    const names = wb.worksheets.map((w) => '"' + w.name + '"').join(', ')
    throw new Error('Лист не найден: ' + sheetName + '. Доступные листы: ' + names)
  }
  return ws
}

/** Матрица значений листа в диапазоне rng (plain values) */
function matrixValues(ws, rng, mode) {
  const out = []
  for (let r = rng.r1; r <= rng.r2; r++) {
    const rowArr = []
    for (let c = rng.c1; c <= rng.c2; c++) {
      const cell = ws.getRow(r).getCell(c)
      if (mode === 'formulas') {
        const f = cellToFormula(cell)
        rowArr.push(f || cellToPlainValue(cell))
      } else {
        rowArr.push(cellToPlainValue(cell))
      }
    }
    out.push(rowArr)
  }
  return out
}

/** readWorkbook(path, { sheet, range, mode }) */
async function readWorkbook(path, opts) {
  const { sheet, range, mode } = opts || {}
  const wb = await loadWorkbook(path)

  if (mode === 'meta') {
    const sheets = wb.worksheets.map((ws) => {
      const ur = usedRange(ws)
      const hasFormulas = (() => {
        let has = false
        ws.eachRow({ includeEmpty: false }, (row) => {
          row.eachCell({ includeEmpty: false }, (cell) => {
            if (cellToFormula(cell)) has = true
          })
        })
        return has
      })()
      const merged = ws.model && ws.model.merges ? ws.model.merges.slice() : []
      return {
        name: ws.name,
        rowCount: ur.empty ? 0 : ur.r2,
        columnCount: ur.empty ? 0 : ur.c2,
        merged,
        hasFormulas,
      }
    })
    return { meta: { stats: workbookStats(wb) }, sheets }
  }

  if (mode === 'full') {
    const spec = { sheets: [] }
    for (const ws of wb.worksheets) {
      const sheetSpec = { name: ws.name, rows: [] }
      const ur = usedRange(ws)

      // Ширины колонок
      const widths = []
      for (let c = 1; c <= ur.c2; c++) {
        const col = ws.getColumn(c)
        if (col && col.width != null) widths.push(Math.round(col.width * 10) / 10)
        else widths.push(null)
      }
      let lastNonNull = -1
      widths.forEach((w, i) => { if (w != null) lastNonNull = i })
      if (lastNonNull >= 0) {
        sheetSpec.columns = widths.slice(0, lastNonNull + 1).map((w) => (w == null ? 8.43 : w))
      }

      // Ячейки
      for (let r = 1; r <= ur.r2; r++) {
        const rowCells = []
        let any = false
        for (let c = 1; c <= ur.c2; c++) {
          const cell = ws.getRow(r).getCell(c)
          const val = cellToSpecValue(cell)
          const hasVal = val.formula != null || val.value !== null && val.value !== undefined && val.value !== ''
          const style = unmapStyle(cell)
          const numFmt = cell.numFmt && cell.numFmt !== 'General' ? cell.numFmt : null
          if (hasVal || style || numFmt || val.hyperlink) {
            any = true
            const cs = {}
            if (val.formula != null) cs.formula = val.formula
            else if (val.value !== null && val.value !== undefined) cs.value = val.value
            if (val.hyperlink) cs.hyperlink = val.hyperlink
            if (numFmt) cs.numFmt = numFmt
            if (style) cs.style = style
            rowCells.push(cs)
          } else {
            rowCells.push(null)
          }
        }
        if (any) sheetSpec.rows.push(rowCells)
        else sheetSpec.rows.push([])
      }
      // Обрезаем пустые строки в конце
      while (sheetSpec.rows.length && sheetSpec.rows[sheetSpec.rows.length - 1].length === 0) sheetSpec.rows.pop()

      // Merged
      if (ws.model && ws.model.merges && ws.model.merges.length) {
        sheetSpec.merged = ws.model.merges.slice()
      }

      // Freeze
      const view = ws.views && ws.views[0]
      if (view && view.state === 'frozen') {
        const ref = require('./cells').numToLetters((view.xSplit || 0) + 1) + ((view.ySplit || 0) + 1)
        sheetSpec.freeze = ref
      }

      // AutoFilter
      if (ws.autoFilter) {
        const af = ws.autoFilter
        sheetSpec.autoFilter = typeof af === 'string' ? af : rangeToString({ c1: af.from.col, r1: af.from.row, c2: af.to.col, r2: af.to.row })
      }

      // Защита
      if (ws.sheetProtection && (ws.sheetProtection.sheet || Object.keys(ws.sheetProtection).some((k) => k !== 'sheet'))) {
        const sp = ws.sheetProtection
        const prot = {}
        for (const k of ['selectLockedCells', 'selectUnlockedCells', 'formatCells', 'formatColumns', 'formatRows', 'insertRows', 'insertColumns', 'insertHyperlinks', 'deleteRows', 'deleteColumns', 'sort', 'autoFilter', 'pivotTables']) {
          if (sp[k] != null) prot[k] = !!sp[k]
        }
        if (Object.keys(prot).length) sheetSpec.protection = prot
      }

      spec.sheets.push(sheetSpec)
    }
    return { spec }
  }

  // values | formulas (default values)
  const ws = findSheet(wb, sheet)
  const ur = usedRange(ws)
  let rng = ur
  if (range) {
    const pr = parseRange(range)
    rng = { c1: pr.c1, r1: pr.r1, c2: pr.c2, r2: pr.r2 }
  }
  const values = matrixValues(ws, rng, mode === 'formulas' ? 'formulas' : 'values')

  // preview: первые 10 строк used range (без range-ограничения)
  const previewRows = matrixValues(ws, { c1: ur.c1, r1: ur.r1, c2: ur.c2, r2: Math.min(ur.r2, ur.r1 + 9) }, 'values')

  return {
    preview: {
      name: ws.name,
      rows: previewRows,
      totalRows: ur.empty ? 0 : ur.r2,
      totalCols: ur.empty ? 0 : ur.c2,
    },
    meta: { stats: workbookStats(wb) },
    values,
  }
}

module.exports = { readWorkbook, loadWorkbook, usedRange, workbookStats }
