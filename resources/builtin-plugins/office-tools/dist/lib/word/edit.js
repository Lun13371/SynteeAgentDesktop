// edit — гранулярные правки .docx: read full-спека → применение ops →
// пересборка через buildDocument → перезапись файла.

const fs = require('fs')
const { readDocument } = require('./read')
const { buildDocument } = require('./spec')

/** ctx для пересборки: картинки читаются напрямую через fs. */
function makeCtx() {
  return {
    async readImage(p) {
      const b64 = fs.readFileSync(p).toString('base64')
      const ext = (String(p).split('.').pop() || 'png').toLowerCase()
      return { base64: b64, ext }
    },
  }
}

/** Рекурсивная замена find→replace во всех строковых полях text/title. */
function replaceDeep(node, find, replace, once, counter) {
  if (counter.done) return
  if (Array.isArray(node)) {
    for (const item of node) replaceDeep(item, find, replace, once, counter)
    return
  }
  if (!node || typeof node !== 'object') return
  for (const key of ['text', 'title']) {
    if (typeof node[key] === 'string' && node[key].includes(find)) {
      node[key] = once ? node[key].replace(find, replace) : node[key].split(find).join(replace)
      counter.n++
      if (once) { counter.done = true; return }
    }
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') replaceDeep(v, find, replace, once, counter)
    if (counter.done) return
  }
}

function checkIndex(content, index, op) {
  if (!Number.isInteger(index) || index < 0 || index >= content.length) {
    throw new Error(op + ': индекс ' + index + ' вне диапазона 0..' + (content.length - 1))
  }
}

function insertAt(content, after, blocks, opName) {
  if (after === undefined || after === null || after === -1) {
    content.push(...blocks)
    return 'добавлено в конец'
  }
  checkIndex(content, after, opName)
  content.splice(after + 1, 0, ...blocks)
  return 'вставлено после блока ' + after
}

/**
 * Применяет операции к .docx и перезаписывает файл.
 * @param {string} path абсолютный путь до .docx
 * @param {Array} ops операции (в порядке применения)
 * @returns {Promise<{stats: object, outline: Array, applied: string[]}>}
 */
async function applyOps(path, ops) {
  if (!Array.isArray(ops) || !ops.length) throw new Error('ops (массив операций) обязателен')
  const full = await readDocument(path, 'full')
  const spec = full.spec
  const applied = []

  for (const op of ops) {
    const name = op && op.op
    switch (name) {
      case 'append_blocks': {
        if (!Array.isArray(op.blocks) || !op.blocks.length) throw new Error('append_blocks: blocks обязателен')
        spec.content.push(...op.blocks)
        applied.push('append_blocks: +' + op.blocks.length)
        break
      }
      case 'insert_after': {
        const blocks = op.blocks || (op.block ? [op.block] : null)
        if (!blocks || !blocks.length) throw new Error('insert_after: block или blocks обязателен')
        applied.push('insert_after: ' + insertAt(spec.content, op.index, blocks, 'insert_after'))
        break
      }
      case 'replace_text': {
        if (!op.find) throw new Error('replace_text: find обязателен')
        const counter = { n: 0, done: false }
        replaceDeep(spec.content, String(op.find), String(op.replace ?? ''), op.all === false, counter)
        applied.push('replace_text "' + op.find + '": ' + counter.n + ' замен')
        break
      }
      case 'set_style': {
        checkIndex(spec.content, op.index, 'set_style')
        const b = spec.content[op.index]
        if (b.type !== 'paragraph' && b.type !== 'heading') {
          throw new Error('set_style: блок ' + op.index + ' имеет тип ' + b.type + ' (нужен paragraph)')
        }
        b.style = { ...(b.style || {}), ...(op.style || {}) }
        applied.push('set_style: блок ' + op.index)
        break
      }
      case 'insert_table': {
        if (!op.table || !Array.isArray(op.table.rows)) throw new Error('insert_table: table.rows обязателен')
        applied.push('insert_table: ' + insertAt(spec.content, op.after, [{ type: 'table', ...op.table }], 'insert_table'))
        break
      }
      case 'add_image': {
        if (!op.image) throw new Error('add_image: image обязателен')
        applied.push('add_image: ' + insertAt(spec.content, op.after, [{ type: 'image', ...op.image }], 'add_image'))
        break
      }
      case 'add_header': {
        if (!Array.isArray(op.blocks)) throw new Error('add_header: blocks обязателен')
        spec.header = { blocks: op.blocks }
        applied.push('add_header: ' + op.blocks.length + ' блоков')
        break
      }
      case 'add_footer': {
        if (!Array.isArray(op.blocks)) throw new Error('add_footer: blocks обязателен')
        spec.footer = { blocks: op.blocks, ...(op.pageNumber ? { pageNumber: op.pageNumber } : {}) }
        applied.push('add_footer: ' + op.blocks.length + ' блоков' + (op.pageNumber ? ' + номер страницы' : ''))
        break
      }
      case 'delete_block': {
        checkIndex(spec.content, op.index, 'delete_block')
        const removed = spec.content.splice(op.index, 1)
        applied.push('delete_block: ' + op.index + ' (' + removed[0].type + ')')
        break
      }
      case 'patch_document': {
        if (!Array.isArray(op.content)) throw new Error('patch_document: content обязателен')
        spec.content = op.content
        applied.push('patch_document: ' + op.content.length + ' блоков')
        break
      }
      default:
        throw new Error(
          'Неизвестная операция: ' + JSON.stringify(name) +
          '. Доступно: append_blocks, insert_after, replace_text, set_style, insert_table, add_image, add_header, add_footer, delete_block, patch_document',
        )
    }
  }

  const built = await buildDocument(spec, makeCtx())
  fs.writeFileSync(path, built.buffer)
  return { stats: built.stats, outline: built.outline, applied }
}

module.exports = { applyOps }
