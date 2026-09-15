// edit — гранулярные правки .xlsx: read full → применить ops → пересобрать → перезаписать
const fs = require('fs')
const { readWorkbook } = require('./read')
const { buildWorkbook } = require('./spec')
const { parseRef, parseRange, rangeToString, lettersToNum, numToLetters } = require('./cells')

/** Найти индекс листа в спеке по имени */
function sheetIdx(spec, name) {
  const i = spec.sheets.findIndex((s) => s.name === name)
  if (i < 0) {
    const names = spec.sheets.map((s) => '"' + s.name + '"').join(', ')
    throw new Error('Лист не найден: ' + name + '. Листы в файле: ' + names)
  }
  return i
}

/** Гарантировать наличие rows/columns у листа спеки */
function ensureRows(sheetSpec, rowCount, colCount) {
  if (!Array.isArray(sheetSpec.rows)) sheetSpec.rows = []
  while (sheetSpec.rows.length < rowCount) sheetSpec.rows.push([])
  if (colCount != null) {
    for (const row of sheetSpec.rows) {
      while (row.length < colCount) row.push(null)
    }
  }
}

/** Сдвиг номера строки/колонки при вставке/удалении. Возвращает новый номер или null (удалён). */
function shiftIdx(n, at, count, insert) {
  if (n < at) return n
  if (insert) return n + count
  const shifted = n - count
  return shifted < at ? null : shifted
}

/** Сдвиг ссылок в формуле ("=SUM(B2:B4)" → "=SUM(B3:B5)") вне строковых литералов */
function shiftFormulaRefs(f, axis, at, count, insert) {
  const parts = String(f).split('"')
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(/(\$?)([A-Za-z]{1,3})(\$?)(\d+)/g, (m, d1, letters, d2, digits) => {
      if (axis === 'row') {
        const n = shiftIdx(parseInt(digits, 10), at, count, insert)
        return n == null ? m : d1 + letters + d2 + n
      }
      const c = shiftIdx(lettersToNum(letters), at, count, insert)
      return c == null ? m : d1 + numToLetters(c) + d2 + digits
    })
  }
  return parts.join('"')
}

/** Сдвинуть все ссылки листа (формулы, merged, freeze, autoFilter, validation, CF) при insert/delete строк/колонок */
function shiftSheetRefs(sh, axis, at, count, insert) {
  const shiftRangeStr = (rangeStr) => {
    try {
      const r = parseRange(rangeStr)
      const a = axis === 'row' ? ['r1', 'r2'] : ['c1', 'c2']
      const n1 = shiftIdx(r[a[0]], at, count, insert)
      const n2 = shiftIdx(r[a[1]], at, count, insert)
      if (n1 == null || n2 == null) return null
      r[a[0]] = n1; r[a[1]] = n2
      return rangeToString(r)
    } catch (e) { return rangeStr }
  }
  for (const row of sh.rows || []) {
    const cells = Array.isArray(row) ? row : row && row.cells
    if (!cells) continue
    for (const cell of cells) {
      if (cell && typeof cell === 'object' && typeof cell.formula === 'string') {
        cell.formula = shiftFormulaRefs(cell.formula, axis, at, count, insert)
      }
    }
  }
  if (Array.isArray(sh.merged)) sh.merged = sh.merged.map(shiftRangeStr).filter(Boolean)
  if (sh.autoFilter) {
    const shifted = shiftRangeStr(sh.autoFilter)
    if (shifted) sh.autoFilter = shifted; else delete sh.autoFilter
  }
  if (sh.freeze) {
    try {
      const { col, row } = parseRef(sh.freeze)
      if (axis === 'row') {
        const n = shiftIdx(row, at, count, insert)
        if (n != null) sh.freeze = numToLetters(col) + n; else delete sh.freeze
      } else {
        const n = shiftIdx(col, at, count, insert)
        if (n != null) sh.freeze = numToLetters(n) + row; else delete sh.freeze
      }
    } catch (e) { /* leave */ }
  }
  if (Array.isArray(sh.dataValidation)) {
    sh.dataValidation = sh.dataValidation.map((dv) => (dv && dv.range ? Object.assign({}, dv, { range: shiftRangeStr(dv.range) }) : dv)).filter(Boolean)
  }
  if (Array.isArray(sh.conditionalFormatting)) {
    sh.conditionalFormatting = sh.conditionalFormatting.map((cf) => (cf && cf.range ? Object.assign({}, cf, { range: shiftRangeStr(cf.range) }) : cf)).filter(Boolean)
  }
}

/** set_cells */
function opSetCells(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  if (!Array.isArray(op.cells)) throw new Error('set_cells: cells (массив) обязателен')
  for (const c of op.cells) {
    if (!c || !c.ref) throw new Error('set_cells: у каждой ячейки нужен ref')
    const { col, row } = parseRef(c.ref)
    ensureRows(sh, row, col)
    const cell = {}
    if (c.value !== undefined) cell.value = c.value
    if (c.formula !== undefined && c.formula !== null && c.formula !== '') cell.formula = c.formula
    if (c.numFmt) cell.numFmt = c.numFmt
    if (c.style) cell.style = c.style
    if (c.hyperlink) cell.hyperlink = c.hyperlink
    sh.rows[row - 1][col - 1] = Object.keys(cell).length ? cell : null
  }
}

/** insert_rows { sheet, at (1-based), count, values? } */
function opInsertRows(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  const at = Number(op.at)
  const count = op.count || 1
  if (!(at >= 1)) throw new Error('insert_rows: at (1-based) обязателен')
  ensureRows(sh, at - 1)
  const newRows = []
  for (let i = 0; i < count; i++) {
    if (op.values && Array.isArray(op.values) && op.values[i] !== undefined) {
      const v = op.values[i]
      newRows.push(Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : { value: x })) : [])
    } else {
      newRows.push([])
    }
  }
  sh.rows.splice(at - 1, 0, ...newRows)
  shiftSheetRefs(sh, 'row', at, count, true)
}

/** delete_rows { sheet, at, count } */
function opDeleteRows(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  const at = Number(op.at)
  const count = op.count || 1
  if (!(at >= 1)) throw new Error('delete_rows: at (1-based) обязателен')
  ensureRows(sh, at + count - 1)
  sh.rows.splice(at - 1, count)
  shiftSheetRefs(sh, 'row', at, count, false)
}

/** insert_columns { sheet, at, count } */
function opInsertColumns(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  const at = Number(op.at)
  const count = op.count || 1
  if (!(at >= 1)) throw new Error('insert_columns: at (1-based) обязателен')
  for (const row of sh.rows || []) {
    // строки — массивы ячеек (full-спека всегда отдаёт массивы)
    if (Array.isArray(row)) {
      for (let i = 0; i < count; i++) row.splice(at - 1, 0, null)
    } else if (row && Array.isArray(row.cells)) {
      for (let i = 0; i < count; i++) row.cells.splice(at - 1, 0, null)
    }
  }
  shiftSheetRefs(sh, 'col', at, count, true)
}

/** delete_columns { sheet, at, count } */
function opDeleteColumns(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  const at = Number(op.at)
  const count = op.count || 1
  if (!(at >= 1)) throw new Error('delete_columns: at (1-based) обязателен')
  for (const row of sh.rows || []) {
    if (Array.isArray(row)) {
      row.splice(at - 1, count)
    } else if (row && Array.isArray(row.cells)) {
      row.cells.splice(at - 1, count)
    }
  }
  shiftSheetRefs(sh, 'col', at, count, false)
}

/** add_sheet { name, rows?, columns? } */
function opAddSheet(spec, op) {
  if (!op.name) throw new Error('add_sheet: name обязателен')
  if (spec.sheets.some((s) => s.name === op.name)) throw new Error('Лист уже существует: ' + op.name)
  spec.sheets.push({
    name: op.name,
    rows: op.rows || [],
    ...(op.columns ? { columns: op.columns } : {}),
  })
}

/** delete_sheet { name } */
function opDeleteSheet(spec, op) {
  const i = sheetIdx(spec, op.name)
  if (spec.sheets.length <= 1) throw new Error('Нельзя удалить единственный лист')
  spec.sheets.splice(i, 1)
}

/** rename_sheet { name, to } */
function opRenameSheet(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.name)]
  if (!op.to) throw new Error('rename_sheet: to обязателен')
  sh.name = op.to
}

/** set_column_width { sheet, column: 'B'|индекс, width } */
function opSetColumnWidth(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  let idx
  if (typeof op.column === 'string') idx = parseRef(op.column + '1').col
  else idx = Number(op.column)
  if (!(idx >= 1)) throw new Error('set_column_width: column обязателен')
  if (op.width == null) throw new Error('set_column_width: width обязателен')
  if (!Array.isArray(sh.columns)) {
    const maxCols = Math.max(idx, ...(sh.rows || []).map((r) => (Array.isArray(r) ? r.length : 0)))
    sh.columns = new Array(maxCols).fill(null)
  }
  while (sh.columns.length < idx) sh.columns.push(null)
  sh.columns[idx - 1] = Number(op.width)
}

/** merge { sheet, range } */
function opMerge(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  if (!op.range) throw new Error('merge: range обязателен')
  if (!Array.isArray(sh.merged)) sh.merged = []
  if (!sh.merged.includes(op.range)) sh.merged.push(op.range)
}

/** freeze { sheet, ref } */
function opFreeze(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  if (!op.ref) throw new Error('freeze: ref обязателен')
  parseRef(op.ref) // валидация
  sh.freeze = op.ref
}

/** auto_filter { sheet, range } */
function opAutoFilter(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  if (!op.range) throw new Error('auto_filter: range обязателен')
  parseRange(op.range) // валидация
  sh.autoFilter = op.range
}

/** protect { sheet, password?, options? } */
function opProtect(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  const prot = {}
  if (op.password) prot.password = op.password
  if (op.options && typeof op.options === 'object') Object.assign(prot, op.options)
  sh.protection = prot
}

/** sort { sheet, range, byColumn, ascending } — стабильная сортировка строк диапазона */
function opSort(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  if (!op.range) throw new Error('sort: range обязателен')
  const rng = parseRange(op.range)
  let colIdx
  if (typeof op.byColumn === 'string') colIdx = parseRef(op.byColumn + '1').col
  else colIdx = Number(op.byColumn || rng.c1)
  if (!(colIdx >= rng.c1 && colIdx <= rng.c2)) throw new Error('sort: byColumn вне диапазона')
  const asc = op.ascending !== false

  ensureRows(sh, rng.r2, rng.c2)

  // Извлечь строки диапазона
  const slice = []
  for (let r = rng.r1; r <= rng.r2; r++) slice.push(sh.rows[r - 1])

  const keyOf = (row) => {
    const cell = row[colIdx - 1]
    if (!cell || typeof cell !== 'object') return cell == null ? null : cell
    if (cell.formula != null) return cell.value != null ? cell.value : null
    return cell.value !== undefined ? cell.value : null
  }
  const cmp = (a, b) => {
    const ka = keyOf(a); const kb = keyOf(b)
    if (ka == null && kb == null) return 0
    if (ka == null) return 1
    if (kb == null) return -1
    if (typeof ka === 'number' && typeof kb === 'number') return ka - kb
    return String(ka).localeCompare(String(kb), 'ru')
  }
  slice.sort((a, b) => (asc ? cmp(a, b) : -cmp(a, b)))

  for (let i = 0; i < slice.length; i++) sh.rows[rng.r1 - 1 + i] = slice[i]
}

const OPS = {
  set_cells: opSetCells,
  insert_rows: opInsertRows,
  delete_rows: opDeleteRows,
  insert_columns: opInsertColumns,
  delete_columns: opDeleteColumns,
  add_sheet: opAddSheet,
  delete_sheet: opDeleteSheet,
  rename_sheet: opRenameSheet,
  set_column_width: opSetColumnWidth,
  merge: opMerge,
  freeze: opFreeze,
  auto_filter: opAutoFilter,
  protect: opProtect,
  sort: opSort,
}

/** applyOps(path, ops) → { stats, preview, applied } */
async function applyOps(path, ops) {
  if (!Array.isArray(ops) || !ops.length) throw new Error('ops (массив операций) обязателен')

  const full = await readWorkbook(path, { mode: 'full' })
  const spec = full.spec

  const applied = []
  for (const op of ops) {
    if (!op || !op.op || !OPS[op.op]) {
      throw new Error('Неизвестная операция: ' + (op && op.op) + '. Доступно: ' + Object.keys(OPS).join(', '))
    }
    OPS[op.op](spec, op)
    applied.push(describeOp(op))
  }

  const built = await buildWorkbook(spec)
  fs.writeFileSync(path, built.buffer)

  return { stats: built.stats, preview: built.preview, applied }
}

function describeOp(op) {
  switch (op.op) {
    case 'set_cells': return 'set_cells: ' + (op.cells ? op.cells.length : 0) + ' яч. на "' + op.sheet + '"'
    case 'insert_rows': return 'insert_rows: ' + op.count + ' стр. на ' + op.at + ' "' + op.sheet + '"'
    case 'delete_rows': return 'delete_rows: ' + op.count + ' стр. с ' + op.at + ' "' + op.sheet + '"'
    case 'insert_columns': return 'insert_columns: ' + op.count + ' кол. на ' + op.at + ' "' + op.sheet + '"'
    case 'delete_columns': return 'delete_columns: ' + op.count + ' кол. с ' + op.at + ' "' + op.sheet + '"'
    case 'add_sheet': return 'add_sheet: "' + op.name + '"'
    case 'delete_sheet': return 'delete_sheet: "' + op.name + '"'
    case 'rename_sheet': return 'rename_sheet: "' + op.name + '" → "' + op.to + '"'
    case 'set_column_width': return 'set_column_width: ' + op.column + ' = ' + op.width + ' "' + op.sheet + '"'
    case 'merge': return 'merge: ' + op.range + ' "' + op.sheet + '"'
    case 'freeze': return 'freeze: ' + op.ref + ' "' + op.sheet + '"'
    case 'auto_filter': return 'auto_filter: ' + op.range + ' "' + op.sheet + '"'
    case 'protect': return 'protect: "' + op.sheet + '"' + (op.password ? ' (с паролем)' : '')
    case 'sort': return 'sort: ' + op.range + ' по ' + op.byColumn + (op.ascending !== false ? ' ↑' : ' ↓')
    default: return op.op
  }
}

module.exports = { applyOps }
