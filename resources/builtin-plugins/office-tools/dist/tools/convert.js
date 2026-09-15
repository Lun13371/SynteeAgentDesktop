// convert — тулы конвертации: xlsx↔csv, docx→markdown/txt/html, xlsx/docx → pdf
const fs = require('fs')
const state = require('../state')
const recent = require('../lib/recent')

function extOf(p) {
  return (p.split('.').pop() || '').toLowerCase()
}

/** docx → markdown / txt / html (mammoth, без MS Office). */
async function convertDocx(p, dstExt, out) {
  const mammoth = require('mammoth')
  const md = require('../lib/word/md')
  const target = out || p.replace(/\.docx$/i, '.' + (dstExt === 'markdown' ? 'md' : dstExt))
  let content
  let label
  if (dstExt === 'markdown' || dstExt === 'md') {
    content = await md.docxToMarkdown(p)
    label = 'Markdown'
  } else if (dstExt === 'txt') {
    content = await md.docxToText(p)
    label = 'TXT'
  } else if (dstExt === 'html') {
    const r = await mammoth.convertToHtml({ path: p })
    content = '<!DOCTYPE html>\n<html>\n<head><meta charset="utf-8"></head>\n<body>\n' + r.value + '\n</body>\n</html>\n'
    label = 'HTML'
  } else {
    throw new Error('Неподдерживаемый формат: .' + dstExt)
  }
  fs.writeFileSync(target, content, 'utf-8')
  await recent.add({ path: target, kind: 'word', op: 'convert', name: target.split(/[\\/]/).pop(), size: fs.statSync(target).size })
  return label + ' создан: ' + target + ' (' + content.length + ' символов)'
}

/** xlsx → csv (exceljs) или csv → xlsx. */
async function convertTable({ path: p, to, out, sheet, delimiter }) {
  if (!p) throw new Error('path обязателен')
  const api = state.api
  const st = await api.fs.stat(p)
  if (!st.exists) throw new Error('Файл не найден: ' + p)

  const srcExt = extOf(p)
  const dstExt = (to || '').toLowerCase().replace('.', '')

  // docx → markdown / txt / html (чистый JS, без MS Office)
  if (srcExt === 'docx' && ['markdown', 'md', 'txt', 'html'].includes(dstExt)) {
    return convertDocx(p, dstExt, out)
  }

  const convert = require('../lib/convert/csv')

  if (srcExt === 'xlsx' && (dstExt === 'csv' || dstExt === 'txt')) {
    const target = out || p.replace(/\.xlsx$/i, '.csv')
    const res = await convert.xlsxToCsv(p, target, { sheet, delimiter })
    await recent.add({ path: target, kind: 'excel', op: 'convert', name: target.split(/[\\/]/).pop(), size: res.size })
    return 'CSV создан: ' + target + '\n' + res.summary
  }
  if (srcExt === 'csv' && dstExt === 'xlsx') {
    const target = out || p.replace(/\.csv$/i, '.xlsx')
    const res = await convert.csvToXlsx(p, target, { delimiter, sheetName: sheet })
    await recent.add({ path: target, kind: 'excel', op: 'convert', name: target.split(/[\\/]/).pop(), size: res.size })
    return 'XLSX создан: ' + target + '\n' + res.summary
  }
  throw new Error(
    'Неподдерживаемая конвертация: .' + srcExt + ' → .' + dstExt +
    ' (доступно: xlsx→csv, csv→xlsx, docx→markdown/txt/html)',
  )
}

/** xlsx/docx → pdf (COM: реальный Excel/Word). */
async function convertPdf({ path: p, out }) {
  if (!p) throw new Error('path обязателен')
  const api = state.api
  const st = await api.fs.stat(p)
  if (!st.exists) throw new Error('Файл не найден: ' + p)
  const target = out || p.replace(/\.(xlsx|xls|docx|doc)$/i, '.pdf')

  if (extOf(p) === 'xlsx' || extOf(p) === 'xls') {
    const com = require('../lib/com/excel')
    await com.exportPdf(p, target)
  } else {
    const com = require('../lib/com/word')
    await com.exportPdf(p, target)
  }
  const st2 = await api.fs.stat(target)
  await recent.add({ path: target, kind: 'pdf', op: 'export', name: target.split(/[\\/]/).pop(), size: st2.size })
  return 'PDF создан: ' + target
}

function registerConvertTools(syntee) {
  syntee.registerTool({
    name: 'office_convert',
    description:
      'Convert office documents. Supported: xlsx→csv (sheet/delimiter options), csv→xlsx, docx→markdown (also "md"), docx→txt, docx→html (pure JS via mammoth, no MS Office needed), xlsx→pdf and docx→pdf (via real MS Office COM — requires Word/Excel installed; see office_export_pdf). Returns the output path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to source file' },
        to: { type: 'string', enum: ['csv', 'xlsx', 'pdf', 'markdown', 'md', 'txt', 'html'], description: 'Target format' },
        out: { type: 'string', description: 'Output path (default: same name with new extension)' },
        sheet: { type: 'string', description: 'xlsx→csv: sheet name; csv→xlsx: new sheet name' },
        delimiter: { type: 'string', description: 'csv delimiter (default ";")' },
      },
      required: ['path', 'to'],
    },
    handler: convertTable,
  })

  // PDF-конвертация — отдельный тул: запускает реальный Office (approval)
  syntee.registerTool({
    name: 'office_export_pdf',
    description:
      'Export a document to PDF using installed MS Office (COM): .docx via Word, .xlsx via Excel. Requires Office installed. Returns the PDF path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .docx/.xlsx' },
        out: { type: 'string', description: 'Output .pdf path (default: same name .pdf)' },
      },
      required: ['path'],
    },
    handler: convertPdf,
    requiresApproval: true,
  })
}

module.exports = { registerConvertTools, convertTable, convertPdf }
