// media — картинки (ImageRun из base64/пути, px-размеры, sniffing натуральных
// размеров PNG/JPEG) и колонтитулы header/footer с номерами страниц.

const docx = require('docx')
const { alignType } = require('./styles')

const { Paragraph, TextRun, ImageRun, Header, Footer, PageNumber, AlignmentType } = docx

const IMG_TYPES = { png: 'png', jpg: 'jpg', jpeg: 'jpg', jpe: 'jpg', gif: 'gif', bmp: 'bmp', svg: 'svg' }

/** Натуральные размеры PNG (IHDR) — [w, h] или null. */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)]
}

/** Натуральные размеры JPEG (SOF-маркеры) — [w, h] или null. */
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue }
    const marker = buf[i + 1]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)]
    }
    const len = buf.readUInt16BE(i + 2)
    if (len <= 0) return null
    i += 2 + len
  }
  return null
}

/** image-блок → Paragraph с ImageRun. data (base64) либо path через ctx.readImage. */
async function buildImageParagraph(block, ctx, stats) {
  let base64 = block.data
  let ext = (block.ext || '').toLowerCase()
  if (!base64) {
    if (!block.path) throw new Error('image-блок: нужен path или data')
    if (!ctx || typeof ctx.readImage !== 'function') {
      throw new Error('ctx.readImage недоступен (нет доступа к файловой системе)')
    }
    const r = await ctx.readImage(block.path)
    base64 = r.base64
    ext = (r.ext || ext || 'png').toLowerCase()
  }
  if (!ext) ext = 'png'
  const type = IMG_TYPES[ext] || 'png'
  const buf = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64')
  if (!buf.length) throw new Error('Пустые данные картинки: ' + (block.path || '<data>'))

  let w = Number(block.width) || 0
  let h = Number(block.height) || 0
  if ((!w || !h) && type === 'png') {
    const nat = pngSize(buf)
    if (nat) { if (!w) w = nat[0]; if (!h) h = nat[1] }
  }
  if ((!w || !h) && (type === 'jpg' || type === 'jpeg')) {
    const nat = jpegSize(buf)
    if (nat) { if (!w) w = nat[0]; if (!h) h = nat[1] }
  }
  if (!w || !h) { w = w || 400; h = h || 300 }

  return new Paragraph({
    alignment: block.alignment ? alignType(block.alignment) : AlignmentType.CENTER,
    spacing: { before: 120, after: 120 },
    children: [new ImageRun({ data: buf, type, transformation: { width: Math.round(w), height: Math.round(h) } })],
  })
}

/** footer.pageNumber → Paragraph с полем номера страницы. */
function pageNumberParagraph(pageNumber) {
  const pn = pageNumber === true ? {} : pageNumber || {}
  const align = pn.alignment ? alignType(pn.alignment) : AlignmentType.CENTER
  const runs = []
  if (pn.before) runs.push(new TextRun({ text: String(pn.before) }))
  runs.push(new TextRun({ children: [PageNumber.CURRENT] }))
  if (pn.after) runs.push(new TextRun({ text: String(pn.after) }))
  if (pn.total) {
    runs.push(new TextRun({ text: ' / ' }))
    runs.push(new TextRun({ children: [PageNumber.TOTAL_PAGES] }))
  }
  return new Paragraph({ alignment: align, children: runs })
}

/**
 * header/footer-секция спеки ({ blocks, pageNumber? }) → docx Header/Footer.
 * Блоки строятся через BlockBuilder (ленивый require — против циклической
 * зависимости blocks.js ↔ media.js).
 */
async function buildHeaderFooter(spec, kind, ctx, numberingSpec) {
  const { BlockBuilder } = require('./blocks')
  const b = new BlockBuilder({ ctx, numberingSpec })
  await b.addMany(spec.blocks || [])
  const children = [...b.children]
  if (kind === 'footer' && spec.pageNumber) children.push(pageNumberParagraph(spec.pageNumber))
  return kind === 'header' ? new Header({ children }) : new Footer({ children })
}

module.exports = { buildImageParagraph, buildHeaderFooter, pageNumberParagraph, pngSize, jpegSize }
