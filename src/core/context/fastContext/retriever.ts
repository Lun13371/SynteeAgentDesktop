import { readFile } from 'fs/promises'
import { stem, splitNameParts } from './lexical'
import type { SymbolDef } from './types'

// ─── Content snippets (читаем куски кода top файлов для LLM) ─────────────────
//
// Раньше этот модуль содержал ещё и buildRepoMapSlice — полный TypeScript
// retriever (инвертированный индекс, PageRank-boost, cosine-rerank). После
// перевода Fast Context на Rust он не вызывался ниоткуда: ранжирование делает
// sidecar, а здесь остаётся только чтение кода найденных файлов.

export interface ContentSnippet {
  path: string
  lineRanges: string
  code: string
}

/**
 * Multi-symbol snippets: для top-N файлов берёт до 3 query-relevant символов,
 * 30 строк вокруг каждого. Даёт LLM реальный код для более точного выбора.
 * Символы сортируются по query-relevance (lexical match), не по порядку в файле.
 */
export async function buildContentSnippets(
  topFiles: Array<{ path: string; definitions: SymbolDef[]; score?: number }>,
  maxFiles = 5,
  maxSymbolsPerFile = 3,
  linesPerSnippet = 30,
  queryTokens: string[] = [],
): Promise<{ text: string; items: ContentSnippet[] }> {
  const snippets: string[] = []
  const items: ContentSnippet[] = []
  const filesToRead = topFiles.slice(0, maxFiles)
  const queryStemsLocal = queryTokens.map(t => stem(t))

  const results = await Promise.allSettled(
    filesToRead.map(async f => {
      let source: string
      try { source = await readFile(f.path, 'utf-8') } catch { return null }
      if (!source || source.length > 500_000) return null

      const lines = source.split('\n')
      // Sort definitions by query-relevance: exact > component > substring > stem
      const scoredDefs = f.definitions
        .filter(d => d.lineStart > 0 && d.lineStart <= lines.length)
        .map(d => {
          const nameLower = d.name.toLowerCase()
          const parts = splitNameParts(d.name)
          const nameStem = stem(nameLower)
          let ds = 0
          for (let ti = 0; ti < queryTokens.length; ti++) {
            const t = queryTokens[ti]
            const ts = queryStemsLocal[ti]
            if (nameLower === t) ds += 5
            else if (parts.includes(t)) ds += 3
            else if (nameLower.includes(t)) ds += 2
            else if (ts !== t && (nameStem === ts || parts.some(p => stem(p) === ts))) ds += 3
          }
          return { def: d, ds }
        })
        .sort((a, b) => b.ds - a.ds)
        .slice(0, maxSymbolsPerFile)

      if (scoredDefs.length === 0) return null

      const parts: string[] = []
      const ranges: string[] = []
      const usedRanges: Array<[number, number]> = []
      for (const { def } of scoredDefs) {
        const center = def.lineStart - 1
        const half = Math.floor(linesPerSnippet / 2)
        const start = Math.max(0, center - half)
        const end = Math.min(lines.length, center + half)
        // Dedup overlapping ranges
        if (usedRanges.some(([s, e]) => start < e && end > s)) continue
        usedRanges.push([start, end])
        const snippet = lines.slice(start, end)
          .map((line, i) => `${start + i + 1}: ${line}`)
          .join('\n')
        parts.push(`  L${def.lineStart} ${def.kind} ${def.name}:\n${snippet}`)
        ranges.push(`${start + 1}-${end}`)
      }

      if (parts.length > 0) {
        const code = parts.join('\n\n')
        items.push({ path: f.path, lineRanges: ranges.join(', '), code })
        return `--- ${f.path} ---\n${code}`
      }
      return null
    }),
  )

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) snippets.push(r.value)
  }

  return {
    text: snippets.length > 0 ? '\n\n--- Content snippets ---\n\n' + snippets.join('\n\n') : '',
    items,
  }
}
