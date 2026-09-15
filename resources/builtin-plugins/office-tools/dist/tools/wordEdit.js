// wordEdit — тулы word_edit / word_append: гранулярные правки существующих .docx
const state = require('../state')
const recent = require('../lib/recent')

async function editWord({ path: p, ops }) {
  if (!p) throw new Error('path обязателен')
  if (!Array.isArray(ops) || !ops.length) throw new Error('ops (массив операций) обязателен')
  const api = state.api
  const st = await api.fs.stat(p)
  if (!st.exists) throw new Error('Файл не найден: ' + p)

  const editor = require('../lib/word/edit')
  const res = await editor.applyOps(p, ops)

  const st2 = await api.fs.stat(p)
  await recent.add({
    path: p,
    kind: 'word',
    op: 'edit',
    name: p.split(/[\\/]/).pop(),
    size: st2.size,
    stats: res.stats,
    outline: res.outline,
  })
  return JSON.stringify(res, null, 1)
}

async function appendWord({ path: p, blocks }) {
  return editWord({ path: p, ops: [{ op: 'append_blocks', blocks }] })
}

function registerWordEditTools(syntee) {
  syntee.registerTool({
    name: 'word_edit',
    description:
      'Apply granular edit operations to an existing .docx. Ops: append_blocks (add content blocks to end), insert_after (block after index), replace_text (find & replace), set_style (restyle block by index), insert_table, add_image, add_header/add_footer, delete_block, patch_document (read full spec → modify → rebuild; use for complex changes). Call word_read mode "structure"/"full" first to get block indexes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .docx' },
        ops: { type: 'array', description: 'Array of edit operations, applied in order', items: { type: 'object' } },
      },
      required: ['path', 'ops'],
    },
    handler: editWord,
    requiresApproval: true, // мутирует файл пользователя
  })

  syntee.registerTool({
    name: 'word_append',
    description:
      'Append content blocks (same format as word_create spec.content) to the end of an existing .docx. Shortcut for word_edit with op append_blocks.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .docx' },
        blocks: { type: 'array', description: 'Blocks to append (word_create spec format)' },
      },
      required: ['path', 'blocks'],
    },
    handler: appendWord,
    requiresApproval: true,
  })
}

module.exports = { registerWordEditTools, editWord, appendWord }
