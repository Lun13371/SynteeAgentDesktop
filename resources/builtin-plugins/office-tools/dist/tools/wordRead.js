// wordRead — тул word_read: чтение .docx (structure | text | full | stats)
const state = require('../state')
const recent = require('../lib/recent')

async function readWord({ path: p, mode }) {
  if (!p) throw new Error('path обязателен')
  const api = state.api
  const st = await api.fs.stat(p)
  if (!st.exists) throw new Error('Файл не найден: ' + p)

  const reader = require('../lib/word/read') // лениво: mammoth ставится при старте
  const m = mode || 'structure'
  const res = await reader.readDocument(p, m)

  // Журнал + превью панели
  if (res.stats) {
    await recent.add({
      path: p,
      kind: 'word',
      op: 'read',
      name: p.split(/[\\/]/).pop(),
      size: st.size,
      stats: res.stats,
      outline: res.outline || null,
    })
  }
  return typeof res === 'string' ? res : JSON.stringify(res, null, 1)
}

function registerWordReadTools(syntee) {
  syntee.registerTool({
    name: 'word_read',
    description:
      'Read a .docx file. Modes: "structure" (document outline: headings tree + block counts — default), "text" (plain text), "full" (full JSON spec of content, suitable for rebuilding via word_create), "stats" (pages/words/paragraphs/tables/images). Use before word_edit to locate blocks.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .docx' },
        mode: { type: 'string', enum: ['structure', 'text', 'full', 'stats'] },
      },
      required: ['path'],
    },
    handler: readWord,
  })
}

module.exports = { registerWordReadTools, readWord }
