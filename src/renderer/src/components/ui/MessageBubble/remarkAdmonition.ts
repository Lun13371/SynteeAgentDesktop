// remark plugin: парсит :::note/:::tip/:::warning/:::danger блоки
import type { Plugin } from 'unified'
import type { Root, Paragraph, Text, BlockContent } from 'mdast'
import { visit } from 'unist-util-visit'

export interface AdmonitionNode {
  type: 'admonition'
  kind: 'note' | 'tip' | 'warning' | 'danger' | 'info'
  title?: string
  children: BlockContent[]
}

declare module 'mdast' {
  interface BlockContentMap {
    admonition: AdmonitionNode
  }
  interface RootContentMap {
    admonition: AdmonitionNode
  }
}

const ADMONITION_RE = /^:::(note|tip|warning|danger|info)(?:\s+(.+))?$/i

const remarkAdmonition: Plugin<[], Root> = () => {
  return (tree: Root) => {
    const toRemove: number[] = []
    const toInsert: { idx: number; node: AdmonitionNode }[] = []

    // Собираем все параграфы как строки
    const lines: { idx: number; text: string }[] = []
    tree.children.forEach((node, idx) => {
      if (node.type === 'paragraph') {
        const p = node as Paragraph
        const text = p.children
          .map(c => (c.type === 'text' ? (c as Text).value : ''))
          .join('')
        lines.push({ idx, text })
      }
    })

    // Ищем :::kind ... ::: паттерн
    let i = 0
    while (i < lines.length) {
      const match = ADMONITION_RE.exec(lines[i].text.trim())
      if (match) {
        const kind = match[1].toLowerCase() as AdmonitionNode['kind']
        const title = match[2]
        const startIdx = lines[i].idx
        // ищем закрывающий :::
        let end = -1
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].text.trim() === ':::') {
            end = j
            break
          }
        }
        if (end !== -1) {
          const contentNodes = tree.children.slice(startIdx + 1, lines[end].idx) as BlockContent[]
          const admonition: AdmonitionNode = { type: 'admonition', kind, children: contentNodes }
          if (title) admonition.title = title
          toInsert.push({ idx: startIdx, node: admonition })
          for (let k = startIdx; k <= lines[end].idx; k++) toRemove.push(k)
          i = end + 1
          continue
        }
      }
      i++
    }

    // Применяем изменения в обратном порядке
    const sorted = toRemove.filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => b - a)
    sorted.forEach(idx => tree.children.splice(idx, 1))
    toInsert.sort((a, b) => b.idx - a.idx).forEach(({ idx, node }) => {
      const insertAt = Math.min(idx, tree.children.length)
      tree.children.splice(insertAt, 0, node as never)
    })
  }
}

export default remarkAdmonition
