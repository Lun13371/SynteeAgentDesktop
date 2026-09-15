// spec — сборка .docx из JSON-спеки (см. specDoc.js — полный контракт формата).
// buildDocument(spec, ctx) → { buffer, stats, outline }.

const docx = require('docx')
const { buildStyles, cmToTwips } = require('./styles')
const { BlockBuilder } = require('./blocks')
const { buildHeaderFooter } = require('./media')

const { Document, Packer, PageOrientation } = docx

/** Размеры бумаги в twips (портрет). */
const PAGE_SIZES = {
  a4: [11906, 16838],
  a3: [16838, 23811],
  a5: [8391, 11906],
  letter: [12240, 15840],
  legal: [12240, 20160],
}

/** page-секция спеки → docx page setup (size/orientation/margins/pageNumbers). */
function buildPageSetup(page, footer) {
  const p = page || {}
  const sizeKey = String(p.size || 'a4').toLowerCase()
  const dims = PAGE_SIZES[sizeKey] || PAGE_SIZES.a4
  const landscape = String(p.orientation || 'portrait').toLowerCase() === 'landscape'
  const out = {
    size: {
      width: dims[0],
      height: dims[1],
      // docx сам меняет w/h местами при landscape — передаём портретные размеры
      ...(landscape ? { orientation: PageOrientation.LANDSCAPE } : {}),
    },
  }
  if (p.margins && typeof p.margins === 'object') {
    const m = p.margins
    out.margin = {}
    for (const side of ['top', 'right', 'bottom', 'left']) {
      if (m[side] !== undefined) out.margin[side] = cmToTwips(m[side])
    }
  }
  // Стартовый номер страницы (footer.pageNumber.start)
  const start = footer && footer.pageNumber && Number(footer.pageNumber.start)
  if (Number.isFinite(start) && start > 0) {
    out.pageNumbers = { start: Math.round(start) }
  }
  return out
}

/**
 * Главная функция: JSON-спека → Buffer .docx.
 * @param {object} spec спека документа (word_create / word_read full)
 * @param {object} ctx { readImage(path) → { base64, ext } } — чтение картинок
 * @returns {Promise<{buffer: Buffer, stats: object, outline: Array}>}
 */
async function buildDocument(spec, ctx) {
  if (!spec || typeof spec !== 'object') throw new Error('spec (объект документа) обязателен')
  if (!Array.isArray(spec.content)) throw new Error('spec.content (массив блоков) обязателен')

  const builder = new BlockBuilder({ ctx, numberingSpec: spec.numbering || {} })
  await builder.addMany(spec.content)

  const section = {
    properties: { page: buildPageSetup(spec.page, spec.footer) },
    children: builder.children,
  }
  // Колонки текста (page.columns)
  const cols = Number(spec.page && spec.page.columns)
  if (Number.isFinite(cols) && cols > 1) {
    section.properties.column = { count: Math.min(4, Math.round(cols)), space: 708 }
  }
  if (spec.header && (Array.isArray(spec.header.blocks) || typeof spec.header === 'object')) {
    section.headers = {
      default: await buildHeaderFooter(spec.header, 'header', ctx, spec.numbering || {}),
    }
  }
  if (spec.footer && typeof spec.footer === 'object') {
    section.footers = {
      default: await buildHeaderFooter(spec.footer, 'footer', ctx, spec.numbering || {}),
    }
  }

  const doc = new Document({
    styles: buildStyles(spec.styles),
    ...(builder.numberingConfigs.length ? { numbering: { config: builder.numberingConfigs } } : {}),
    features: { updateFields: true }, // Word предложит обновить TOC (Ctrl+A, F9)
    sections: [section],
  })

  const buffer = await Packer.toBuffer(doc)
  return { buffer, stats: builder.stats, outline: builder.outline }
}

module.exports = { buildDocument, buildPageSetup, PAGE_SIZES }
