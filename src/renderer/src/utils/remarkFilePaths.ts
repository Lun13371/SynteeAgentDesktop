// ── remark-плагин: делает пути файлов в text-нодах кликабельными ─────────
//
// Проходит по mdast, находит text-ноды, regex-ом разбивает на сегменты:
// пути файлов → link-ноды с URL scheme file-path:// (кликабельные).
//
// Не применяется во время стриминга (для производительности).
// Используется в MessageBubble.tsx через createMdComponents.
//
// ВАЖНО: используем link-ноды (не html-ноды), т.к. react-markdown
// без rehype-raw НЕ рендерит raw HTML. Link-ноды рендерятся как <a>,
// а наш компонент `a` в createMdComponents перехватывает клик.

import type { Plugin } from 'unified'
import type { Root, Text, Parent, PhrasingContent, Link } from 'mdast'

// Regex для детекта путей файлов:
// - Относительные: src/foo/bar.ts, a/b/c.tsx
// - Абсолютные Unix: /home/user/file.ts
// - Абсолютные Windows: C:\Projects\file.ts, C:/Projects/file.ts
// - Кириллические папки/файлы: C:\Проекты\файл.ts (\u0400-\u04FF)
// Требования: минимум один разделитель (/ или \) + расширение файла.
// Не матчит: URL (https://site.com/a.ts — сегмент после домена закрыт
// lookbehind), email (@), версии (v1.2.3 без слэшей).
//
// Lookbehind (?<![\w~./\\-]) вместо старого (^|\s): путь подсвечивается и
// после открывающей скобки/кавычки/двоеточия/запятой — AI часто пишет пути
// в скобках «(src/foo.ts)». Electron/Chromium поддерживает lookbehind.
// Экспортируется — renderClickablePlainText в MessageBubble использует тот же
// regex, чтобы подсветка в plain-text и markdown не разъезжалась.
export const PATH_RE = /(?<![\w~./\\-])((?:[a-zA-Z]:[\\/])?[~/]?(?:[\w.\u0400-\u04FF-]+[\\/])+[\w.\u0400-\u04FF-]+\.\w{1,10})(?![\w-])/g

function isInsideLink(parents: Parent[]): boolean {
  return parents.some(p => p.type === 'link')
}

// Простой обход дерева без unist-util-visit
function visitTextNodes(tree: Root, visitor: (node: Text, index: number, parent: Parent) => void | [number, Parent]) {
  const walk = (node: Parent, parents: Parent[]) => {
    const children = node.children
    if (!children) return
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if (child.type === 'text' && !isInsideLink(parents)) {
        const result = visitor(child as Text, i, node)
        if (result) {
          i = result[0]
        }
        continue
      }
      if (child && typeof child === 'object' && 'children' in child) {
        walk(child as Parent, [...parents, child as Parent])
      }
    }
  }
  walk(tree, [])
}

export const remarkFilePaths: Plugin<[], Root> = () => {
  return (tree: Root) => {
    visitTextNodes(tree, (node: Text, index: number, parent: Parent) => {
      const text = node.value
      if (!text.includes('/') && !text.includes('\\')) return

      const segments: Array<{ text: string; isPath: boolean }> = []
      let lastIdx = 0
      let m: RegExpExecArray | null
      const re = new RegExp(PATH_RE.source, 'g')
      let found = false

      while ((m = re.exec(text)) !== null) {
        found = true
        const pathStart = m.index + (m[0].length - m[1].length)
        if (pathStart > lastIdx) {
          segments.push({ text: text.slice(lastIdx, pathStart), isPath: false })
        }
        segments.push({ text: m[1], isPath: true })
        lastIdx = pathStart + m[1].length
      }

      if (!found) return

      if (lastIdx < text.length) {
        segments.push({ text: text.slice(lastIdx), isPath: false })
      }

      // Заменяем text-ноду на массив нод (text + link)
      // Используем link-ноды с URL scheme file-path:// — они рендерятся
      // react-markdown как <a>, а наш компонент `a` перехватывает клик.
      const newNodes: PhrasingContent[] = segments.map(seg => {
        if (seg.isPath) {
          // Кодируем путь в URL (file-path://path/to/file.ts)
          const encoded = encodeURIComponent(seg.text)
          const linkNode: Link = {
            type: 'link',
            url: `file-path://${encoded}`,
            children: [{ type: 'text', value: seg.text }],
          }
          return linkNode as unknown as PhrasingContent
        }
        return {
          type: 'text',
          value: seg.text,
        } as PhrasingContent
      })

      parent.children.splice(index, 1, ...newNodes)
      return [index + newNodes.length - 1, parent]
    })
  }
}

/**
 * Резолв относительного пути от workdir.
 * Если путь уже абсолютный — возвращает как есть.
 */
export function resolveFilePath(rawPath: string, workdir?: string): string {
  // Нормализуем Windows-слэши
  const p = rawPath.replace(/\\/g, '/')

  // Абсолютный путь
  if (/^[a-zA-Z]:\//.test(p) || p.startsWith('/') || p.startsWith('~')) {
    return p
  }

  // Относительный — резолв от workdir
  if (workdir) {
    const wd = workdir.replace(/\\/g, '/').replace(/\/$/, '')
    return `${wd}/${p}`
  }

  return p
}
