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
    // Фаза 2: lib/com/excel.js. Пока — дефолтное приложение.
    const shell = require('../lib/com/shell')
    await shell.openWithDefault(p)
    return 'Открыто: ' + p
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
}

module.exports = { registerComTools, officeOpen, wordExportPdf }
