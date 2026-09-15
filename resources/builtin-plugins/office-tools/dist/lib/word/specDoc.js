// specDoc — полный справочник формата JSON-спеки word_create.
// Это КОНТРАКТ: dist/lib/word/spec.js обязан поддерживать всё описанное здесь,
// а dist/lib/templates/* генерирует спеки в этом же формате.

function specDoc() {
  return `# word_create spec reference

Document spec (argument "spec"):

{
  "page": {                       // optional page setup
    "size": "A4" | "Letter" | "Legal" | "A5" | "A3",       // default A4
    "orientation": "portrait" | "landscape",                // default portrait
    "margins": { "top": 2, "right": 1.5, "bottom": 2, "left": 3 },  // cm
    "columns": 1                                              // text columns
  },
  "styles": {                     // optional default styles
    "default": { "font": "Calibri", "size": 22, "color": "1F1F1F", "lineHeight": 1.15, "spacingAfter": 160 },  // size = half-points (22 → 11pt), spacing in twips (20 twips = 1pt)
    "heading1": { "font": "Calibri", "size": 32, "bold": true, "color": "2E74B5", "spacingBefore": 240, "spacingAfter": 120 },
    "heading2": { ... }, "heading3": { ... }, "heading4": { ... }, "heading5": { ... }, "heading6": { ... }
  },
  "numbering": {                  // optional custom list numbering, id → definition
    "mylist": { "type": "decimal", "levels": [ { "format": "decimal", "text": "%1.", "alignment": "start", "indent": 720 } ] }
  },
  "header": { "blocks": [ block, ... ] },   // running header (paragraph/table blocks)
  "footer": { "blocks": [ block, ... ], "pageNumber": { "alignment": "center", "start": 1 } },
  "content": [ block, ... ]       // REQUIRED: document body blocks
}

## Blocks (content / header / footer / append_blocks)

{ "type": "heading", "level": 1..6, "text": "…" }                       // styled via styles.headingN
{ "type": "paragraph", "text": "…",                                     // plain text OR runs (below)
  "alignment": "left"|"center"|"right"|"justify",
  "spacing": { "before": 120, "after": 120, "line": 276 },              // twips
  "indent": { "firstLine": 720, "left": 360, "hanging": 360 },
  "style": { ...run props } }                                           // default run props for plain text
{ "type": "list", "ordered": true|false, "numberingId": "mylist",       // custom numbering (optional)
  "items": [ "text" | { "text": "…", "level": 0, "style": { … } } ] }
{ "type": "table",
  "rows": [ [ cell, cell, ... ], ... ],                                 // REQUIRED: rows of cells
  "header": true,                       // first row is header (bold, repeated on page break)
  "columnWidths": [ 4, 6, 3 ],          // cm; omit → autofit
  "width": 100,                         // % of page width
  "borders": { "style": "single"|"double"|"dashed"|"dotted"|"none", "size": 4, "color": "auto" },  // size in 1/8 pt
  "style": "table-grid" | "light-shading" | "medium-shading-1" | "no-border",  // preset table styles
  "align": "center" }
  // cell: "text" | { "text": "…" | "runs": [ run ], "bold": true, "italic": false, "align": "center",
  //        "fill": "DEEBF7", "color": "333333", "colspan": 2, "rowspan": 2, "verticalAlign": "center",
  //        "borders": { … } }
{ "type": "image", "path": "C:/abs/pic.png", "width": 400, "height": 300,   // px; omit both → natural size
  "alignment": "left"|"center"|"right" }
{ "type": "hyperlink", "text": "…", "url": "https://…" }
{ "type": "pageBreak" }
{ "type": "toc", "title": "Содержание", "levels": 3 }                     // table of contents (needs field update in Word: Ctrl+A F9)
{ "type": "hr" }                                                          // horizontal rule (bottom border paragraph)

## Runs (inline styled text)

"runs": [ { "text": "…", "bold": true, "italic": true, "underline": {} | { "type": "single"|"double"|"wave" },
  "strike": true, "subscript": true, "superscript": true,
  "font": "Times New Roman", "size": 24,          // half-points: 24 → 12pt
  "color": "FF0000", "highlight": "yellow",       // highlight: named (yellow, green, …) or hex
  "allCaps": true, "caps": true } ]

## Colors
Hex without '#': "FF0000", "1F1F1F", "auto".

## Units
size (font) = half-points; spacing/indent = twips (20 twips = 1 pt, 567 twips = 1 cm);
borders.size = 1/8 pt; image width/height = px; margins/columnWidths = cm.

## Stats returned by word_create
{ paragraphs, words, tables, images, lists, approxPages } and outline: [{ level, text }] for headings.`
}

module.exports = { specDoc }
