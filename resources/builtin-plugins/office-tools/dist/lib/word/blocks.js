// blocks — построение docx-элементов из блоков спеки (content/header/footer).
// Заголовки, параграфы с runs, списки (bullet/numbered/multilevel/numberingId),
// hyperlink, pageBreak, hr, toc. Таблицы и картинки — в tables.js / media.js.

const docx = require('docx')
const { runProps, alignType, lineHeightToTwips } = require('./styles')
const { buildTable } = require('./tables')
const { buildImageParagraph } = require('./media')

const { Paragraph, TextRun, HeadingLevel, AlignmentType, LevelFormat, BorderStyle,
  PageBreak, ExternalHyperlink, TableOfContents } = docx

const HEADING_IDS = {
  1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4, 5: HeadingLevel.HEADING_5, 6: HeadingLevel.HEADING_6,
}

const LEVEL_FORMATS = {
  decimal: LevelFormat.DECIMAL, number: LevelFormat.DECIMAL,
  lowerletter: LevelFormat.LOWER_LETTER, loweralpha: LevelFormat.LOWER_LETTER,
  upperletter: LevelFormat.UPPER_LETTER, upperalpha: LevelFormat.UPPER_LETTER,
  lowerroman: LevelFormat.LOWER_ROMAN, upperroman: LevelFormat.UPPER_ROMAN,
  bullet: LevelFormat.BULLET, none: LevelFormat.NONE,
}

const BULLET_CHARS = ['\u25CF', '\u25CB', '\u25A0', '\u25CB', '\u25A0', '\u25CF']
const ORDERED_FORMATS = ['decimal', 'lowerLetter', 'lowerRoman', 'decimal', 'lowerLetter', 'lowerRoman']
const ORDERED_TEXT = ['%1.', '%2)', '%3.', '%4)', '%5.', '%6)']

/** Runs-массив спеки → TextRun[] (style-объекты применяются к каждому run). */
function buildRuns(runs, extraProps) {
  const out = []
  for (const r of runs || []) {
    if (r == null) continue
    if (typeof r === 'string') {
      if (r) out.push(new TextRun({ text: r, ...extraProps }))
      continue
    }
    if (!r.text && !r.break) continue
    const props = { ...runProps(r.style || {}), ...runProps(r), ...extraProps }
    if (r.break) out.push(new TextRun({ text: r.text || '', break: r.break, ...props }))
    else out.push(new TextRun({ text: String(r.text), ...props }))
  }
  return out
}

/** Сбор всего текста блока (для stats.words). */
function collectText(block, acc) {
  if (!block || typeof block !== 'object') return acc
  if (typeof block.text === 'string') acc.push(block.text)
  if (Array.isArray(block.runs)) {
    for (const r of block.runs) acc.push(typeof r === 'string' ? r : (r && r.text) || '')
  }
  if (Array.isArray(block.items)) {
    for (const it of block.items) {
      if (typeof it === 'string') acc.push(it)
      else if (it && typeof it === 'object') acc.push(it.text || '')
    }
  }
  if (Array.isArray(block.rows)) {
    for (const row of block.rows) {
      for (const c of row || []) {
        if (typeof c === 'string') acc.push(c)
        else if (c && typeof c === 'object') {
          if (typeof c.text === 'string') acc.push(c.text)
          if (Array.isArray(c.runs)) for (const r of c.runs) acc.push(typeof r === 'string' ? r : (r && r.text) || '')
        }
      }
    }
  }
  return acc
}

/**
 * Построитель блоков. Накапливает children (docx-элементы), numbering-конфиги
 * (для Document), stats и outline. add() асинхронный (картинки читаются с диска).
 */
class BlockBuilder {
  constructor({ ctx, numberingSpec }) {
    this.ctx = ctx || {}
    this.children = []
    this.numberingConfigs = []
    this._numberingSpec = numberingSpec || {}
    this._autoListSeq = 0
    this.stats = { paragraphs: 0, words: 0, tables: 0, images: 0, lists: 0, approxPages: 1 }
    this.outline = []
    this._texts = []
  }

  _countWords(block) {
    this._texts.push(...collectText(block, []))
  }

  _finishStats() {
    const words = this._texts.join(' ').split(/\s+/).filter(Boolean).length
    this.stats.words = words
    const est = words / 400 + this.stats.tables * 0.25 + this.stats.images * 0.15 + this.stats.paragraphs * 0.02
    this.stats.approxPages = Math.max(1, Math.ceil(est))
  }

  /** numbering-конфиг для списка: кастомный (numberingId) или авто. */
  _listNumbering(block) {
    if (block.numberingId && this._numberingSpec[block.numberingId]) {
      const id = block.numberingId
      if (!this.numberingConfigs.some((c) => c.reference === id)) {
        this.numberingConfigs.push(this._customNumbering(id, this._numberingSpec[id]))
      }
      return { reference: id, instance: 0 }
    }
    const ref = '__list' + ++this._autoListSeq
    this.numberingConfigs.push(
      block.ordered
        ? this._autoNumbering(ref, ORDERED_FORMATS, ORDERED_TEXT)
        : this._autoNumbering(ref, null, null),
    )
    return { reference: ref, instance: 0 }
  }

  _autoNumbering(ref, formats, texts) {
    const levels = []
    for (let i = 0; i < 6; i++) {
      levels.push({
        level: i,
        format: formats ? LEVEL_FORMATS[(formats[i] || 'decimal').toLowerCase()] : LevelFormat.BULLET,
        text: formats ? texts[i] : BULLET_CHARS[i],
        alignment: AlignmentType.START,
        style: { paragraph: { indent: { left: 720 * (i + 1), hanging: 360 } } },
      })
    }
    return { reference: ref, levels }
  }

  _customNumbering(id, def) {
    const levels = (def && Array.isArray(def.levels) && def.levels.length
      ? def.levels
      : [{ format: def && def.type, text: '%1.', indent: 720 }]
    ).map((l, i) => ({
      level: i,
      format: LEVEL_FORMATS[String(l.format || l.type || 'decimal').toLowerCase()] || LevelFormat.DECIMAL,
      text: l.text || '%1.',
      alignment: alignType(l.alignment) || AlignmentType.START,
      style: { paragraph: { indent: { left: Math.round(Number(l.indent) || 720 * (i + 1)), hanging: 360 } } },
    }))
    return { reference: id, levels }
  }

  async add(block) {
    if (!block || typeof block !== 'object') return
    switch (block.type) {
      case 'heading': {
        const level = Math.min(6, Math.max(1, Number(block.level) || 1))
        const props = { heading: HEADING_IDS[level], ...(block.pageBreakBefore ? { pageBreakBefore: true } : {}) }
        if (block.alignment) props.alignment = alignType(block.alignment)
        this.children.push(new Paragraph({
          ...props,
          children: block.runs ? buildRuns(block.runs) : [new TextRun({ text: String(block.text || '') })],
        }))
        this.stats.paragraphs++
        this.outline.push({ level, text: String(block.text || '') })
        this._countWords(block)
        break
      }
      case 'paragraph': {
        const base = runProps(block.style || {})
        const p = { children: block.runs ? buildRuns(block.runs, base) : [new TextRun({ text: String(block.text || ''), ...base })] }
        if (block.alignment) p.alignment = alignType(block.alignment)
        const sp = {}
        if (block.spacing) {
          if (block.spacing.before !== undefined) sp.before = Math.round(Number(block.spacing.before))
          if (block.spacing.after !== undefined) sp.after = Math.round(Number(block.spacing.after))
          if (block.spacing.line !== undefined) sp.line = Math.round(Number(block.spacing.line))
          else if (block.spacing.lineHeight !== undefined) sp.line = lineHeightToTwips(block.spacing.lineHeight)
          if (Object.keys(sp).length) p.spacing = sp
        }
        if (block.indent) {
          p.indent = {}
          for (const k of ['firstLine', 'left', 'right', 'hanging', 'start', 'end']) {
            if (block.indent[k] !== undefined) p.indent[k] = Math.round(Number(block.indent[k]))
          }
        }
        if (block.pageBreakBefore) p.pageBreakBefore = true
        this.children.push(new Paragraph(p))
        this.stats.paragraphs++
        this._countWords(block)
        break
      }
      case 'list': {
        const num = this._listNumbering(block)
        const base = runProps(block.style || {})
        for (const item of block.items || []) {
          const it = typeof item === 'string' ? { text: item } : item || {}
          const level = Math.max(0, Math.min(5, Number(it.level) || 0))
          this.children.push(new Paragraph({
            numbering: { reference: num.reference, level, instance: num.instance },
            children: it.runs
              ? buildRuns(it.runs)
              : [new TextRun({ text: String(it.text || ''), ...runProps(it.style || {}), ...base })],
          }))
          this.stats.paragraphs++
          this._countWords({ text: it.text, runs: it.runs })
        }
        this.stats.lists++
        break
      }
      case 'hyperlink': {
        this.children.push(new Paragraph({
          alignment: block.alignment ? alignType(block.alignment) : undefined,
          children: [new ExternalHyperlink({
            link: String(block.url || ''),
            children: [new TextRun({ text: String(block.text || block.url || ''), style: 'Hyperlink' })],
          })],
        }))
        this.stats.paragraphs++
        this._countWords(block)
        break
      }
      case 'table': {
        this.children.push(buildTable(block, this.stats))
        this.stats.tables++
        this._countWords(block)
        break
      }
      case 'image': {
        this.children.push(await buildImageParagraph(block, this.ctx, this.stats))
        this.stats.images++
        break
      }
      case 'pageBreak': {
        this.children.push(new Paragraph({ children: [new PageBreak()] }))
        break
      }
      case 'hr': {
        this.children.push(new Paragraph({
          spacing: { before: 60, after: 60 },
          border: { bottom: { color: 'auto', space: 1, style: BorderStyle.SINGLE, size: 6 } },
        }))
        break
      }
      case 'toc': {
        const levels = Math.min(6, Math.max(1, Number(block.levels) || 3))
        if (block.title) {
          this.children.push(new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: String(block.title) })],
          }))
          this.outline.push({ level: 1, text: String(block.title) })
        }
        this.children.push(new TableOfContents(String(block.title || 'Contents'), {
          hyperlink: true,
          headingStyleRange: '1-' + levels,
        }))
        break
      }
      default:
        throw new Error('Неизвестный тип блока: ' + JSON.stringify(block.type))
    }
  }

  async addMany(blocks) {
    for (const b of blocks || []) await this.add(b)
    this._finishStats()
    return this
  }
}

module.exports = { BlockBuilder, buildRuns, collectText }
