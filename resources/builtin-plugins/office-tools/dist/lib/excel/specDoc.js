// specDoc — полный справочник формата JSON-спеки excel_create.
// КОНТРАКТ: dist/lib/excel/spec.js обязан поддерживать всё описанное здесь.

function specDoc() {
  return `# excel_create spec reference

Workbook spec (argument "spec"):

{
  "sheets": [ sheet, ... ],              // REQUIRED, ≥ 1
  "definedNames": [ { "name": "TaxRate", "range": "Sheet1!$A$1" } ]   // optional named ranges
}

## Sheet

{
  "name": "Бюджет",                      // ≤ 31 chars, no []:*?/\\
  "columns": [ 20, { "width": 12 }, 8 ], // column widths (chars); number or { width }
  "rows": [ row, ... ],                  // REQUIRED
  "freeze": "A2",                        // freeze rows/cols above/left of ref
  "autoFilter": "A1:D10",                // autofilter range
  "merged": [ "A1:B1", "C3:C5" ],        // merged ranges
  "dataValidation": [
    { "range": "B2:B10", "type": "list"|"whole"|"decimal"|"date"|"textLength", "allowBlank": true,
      "operator": "between"|"notBetween"|"greaterThan"|..., "formulae": ['"Да,Нет"'] }
  ],
  "conditionalFormatting": [
    { "range": "C2:C10",
      "rules": [ { "type": "cellIs"|"expression"|"top10"|"colorScale"|"dataBar"|"iconSet",
                   "operator": "greaterThan"|"lessThan"|"equal"|..., "priority": 1,
                   "formulae": ["100"], "style": { "fill": "FFC7CE", "color": "9C0006" } } ] }
  ],
  "protection": { "password": "secret", "selectLockedCells": true, "insertRows": false }  // optional; omit password → no password
}

## Row

[ cell, cell, ... ]                      // array of cells
{ "cells": [ cell, ... ], "height": 24, "style": { ...cell style } }   // styled row

## Cell

value                                    // shorthand: number | string | boolean | null
{ "value": 42,                           // value OR formula (not both)
  "formula": "=SUM(A1:A2)",              // Excel formula WITH leading =
  "numFmt": "#,##0.00" | "dd.mm.yyyy" | "0%" | "@",   // number format
  "style": {                             // optional cell style
    "font": { "name": "Calibri", "size": 11, "bold": true, "italic": true,
              "underline": true, "strike": true, "color": "FF0000" },
    "fill": "DEEBF7",                    // solid fill color (hex, no '#')
    "border": {                          // borders; each side optional
      "top"|"bottom"|"left"|"right": { "style": "thin"|"medium"|"thick"|"double"|"dashed"|"dotted"|"hair", "color": "000000" } },
    "alignment": { "horizontal": "left"|"center"|"right", "vertical": "top"|"middle"|"bottom",
                   "wrapText": true, "shrinkToFit": true, "textRotation": 90 }
  },
  "hyperlink": "https://…"               // cell becomes a link (value = text)
}

## Colors
Hex without '#': "FF0000", "DEEBF7".

## Stats returned by excel_create
{ sheets, rows, cells, formulas, merged } and preview: { name, rows (first 10 rows of first sheet), totalRows, totalCols }.`
}

module.exports = { specDoc }
